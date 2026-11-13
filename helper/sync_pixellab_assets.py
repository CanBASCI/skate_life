#!/usr/bin/env python3
"""Download PixelLab characters/objects into organized assets/ folders."""
from __future__ import annotations

import io
import json
import os
import re
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Parallel CDN fetches (Backblaze PNGs). MCP list/get stay sequential.
WORKERS = int(os.environ.get("SYNC_WORKERS", "24"))

# Avoid proxy tunnel 403 on some Mac setups
for k in list(os.environ):
    if "proxy" in k.lower():
        del os.environ[k]

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from helper.pixellab_mcp import PixelLabMCP  # noqa: E402
TOKEN = None
DIRS = [
    "south",
    "east",
    "north",
    "west",
    "south-east",
    "north-east",
    "north-west",
    "south-west",
]

# Demo / template characters to skip
SKIP_CHAR_NAMES = {
    "warrior woman with orange hair",
    "old man bald",
    "blonde farmer with long hair and a dress",
    "flat shaded light brown bear",
    "Mobile Skater Clean",
}

# Junk object name prefixes / exacts to skip
SKIP_OBJ_EXACT = {
    "Object 0",
    "Object 0 (copy)",
    "Object 0 (copy 2)",
    "Object 0 (copy 3)",
    "Object 0 (copy 4)",
    "Object 0 (copy 5)",
    "Fireball",
    "Umbrella",
    "pro-flash",
    "japanese animals statues",
}


def load_token() -> str:
    global TOKEN
    if TOKEN:
        return TOKEN
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("PIXELLAB_API_TOKEN="):
            TOKEN = line.split("=", 1)[1].strip()
            return TOKEN
    raise SystemExit("missing PIXELLAB_API_TOKEN")


def slug(s: str) -> str:
    s = s.strip().lower()
    s = s.replace(" ", "_")
    s = re.sub(r"[^a-z0-9_\-]+", "", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "unnamed"


def anim_slug(name: str) -> str:
    n = name.strip().lower()
    mapping = {
        "breathing-idle": "idle",
        "idle": "idle",
        "walk": "walk",
        "walking": "walk",
        "walking-6-frames": "walk",
        "walking-4-frames": "walk",
        "walking-8-frames": "walk",
        "running-6-frames": "run",
        "running-4-frames": "run",
        "running-8-frames": "run",
        "run": "run",
        "crouched-walking": "walk",
        "crouching": "crouch",
    }
    if n in mapping:
        return mapping[n]
    return slug(n)


def http_get(url: str, auth: bool = False, retries: int = 3) -> bytes:
    headers = {"User-Agent": "Mozilla/5.0"}
    if auth:
        headers["Authorization"] = f"Bearer {load_token()}"
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.read()
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last  # type: ignore


def list_all(mcp: PixelLabMCP, tool: str):
    offset = 0
    rows = []
    while True:
        t = mcp.tool_text(tool, {"offset": offset})
        m = re.search(r"showing\s+(\d+)-(\d+)\s+of\s+(\d+)", t, re.I)
        for line in t.splitlines():
            line = line.strip().lstrip("+ ")
            if re.match(r"^[0-9a-f-]{36}\s*\|", line):
                parts = [p.strip() for p in line.split("|")]
                oid = parts[0]
                name = parts[1] if len(parts) > 1 else ""
                rest = " | ".join(parts[2:])
                size_m = re.search(r"(\d+)x(\d+)", rest)
                state_m = re.search(r"state:([^\s|]+(?:\s+[^\s|]+)*)", rest)
                rows.append(
                    {
                        "id": oid,
                        "name": name,
                        "size": f"{size_m.group(1)}x{size_m.group(2)}" if size_m else "unknown",
                        "w": int(size_m.group(1)) if size_m else None,
                        "h": int(size_m.group(2)) if size_m else None,
                        "state": state_m.group(1).strip() if state_m else None,
                        "raw": line,
                    }
                )
        if not m:
            break
        end, total = int(m.group(2)), int(m.group(3))
        if end >= total:
            break
        offset = end
    return rows


def parse_character(text: str):
    meta = {}
    m = re.search(r"^name:\s*(.+)$", text, re.M)
    if m:
        meta["name"] = m.group(1).strip()
    m = re.search(r"state_name:\s*(.+)", text)
    if m:
        meta["state"] = m.group(1).strip()
    m = re.search(r"size:\s*(\d+)x(\d+)", text)
    if m:
        meta["w"], meta["h"] = int(m.group(1)), int(m.group(2))
    rotations = {}
    # Only parse URLs inside the rotations: section (before animations)
    rot_section = text
    if "rotations:" in text:
        rot_section = text.split("rotations:", 1)[1]
        rot_section = re.split(r"\n(?:animations|download|available_animations|actions):", rot_section, 1)[0]
    for d in [*DIRS, "unknown"]:
        mm = re.search(rf"(?m)^\s*{re.escape(d)}:\s*(https://\S+)", rot_section)
        if mm:
            rotations[d] = mm.group(1).strip().rstrip(")")
    # animations: legacy "  idle — 8 dir ..." OR new "  idle [group: uuid]"
    anims = {}
    anim_section = ""
    if "\nanimations" in text:
        anim_section = text.split("\nanimations", 1)[1]
        anim_section = re.split(r"\n(?:download|available_animations|actions):", anim_section, 1)[0]

    def _frames_from_block(block: str) -> dict:
        frames = {}
        for d in [*DIRS, "unknown"]:
            um = re.search(
                rf"(?m)^\s*{re.escape(d)}:\s*(https://\S*?/\{{i\}}\.png\S*)\s*\(i=(\d+)\.\.(\d+)\)",
                block,
            )
            if um:
                frames[d] = {
                    "template": um.group(1).strip().rstrip(")"),
                    "i0": int(um.group(2)),
                    "i1": int(um.group(3)),
                }
        return frames

    # New PixelLab object format: "  idle [group: …]" + optional description
    for am in re.finditer(
        r"(?m)^  ([A-Za-z0-9_\-]+) \[group:[^\]]+\]\n(.*?)(?=^  [A-Za-z0-9_\-]+ \[group:|\Z)",
        anim_section,
        re.S,
    ):
        aname = am.group(1).strip()
        block = am.group(2)
        frames = _frames_from_block(block)
        if not frames:
            continue
        desc = re.search(r"(?m)^    description:\s*(.+)$", block)
        # Zip folders use description slug when present (e.g. cute_cat_idle), else group name
        key = anim_slug(desc.group(1)) if desc else anim_slug(aname)
        anims[key] = frames

    # Legacy character format
    if not anims:
        for am in re.finditer(
            r"(?m)^  ([A-Za-z0-9_\- ]+?) —[^\n]*\n(.*?)(?=^  [A-Za-z0-9_\- ]+? —|\Z)",
            anim_section,
            re.S,
        ):
            aname = am.group(1).strip()
            frames = _frames_from_block(am.group(2))
            if frames:
                anims[aname] = frames
    return meta, rotations, anims


def save_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size == len(data):
        return False
    path.write_bytes(data)
    return True


def fetch_jobs(jobs: list[tuple[str, Path]], auth: bool = False) -> int:
    """Download (url, dest) jobs in parallel. Returns count of newly written files."""
    if not jobs:
        return 0
    written = 0

    def one(url: str, dest: Path) -> bool:
        if dest.exists() and dest.stat().st_size > 0:
            return False
        raw = http_get(url, auth=auth)
        return save_bytes(dest, raw)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = [pool.submit(one, url, dest) for url, dest in jobs]
        for fut in as_completed(futs):
            if fut.result():
                written += 1
    return written


def sync_character(mcp: PixelLabMCP, row: dict, force: bool = False) -> str:
    name = row["name"]
    if name in SKIP_CHAR_NAMES:
        return "skip-demo"
    # Prefer Boy_/Girl_/Main
    if not (
        name.startswith("Boy_")
        or name.startswith("Girl_")
        or name.startswith("Main Character")
    ):
        # still allow explicitly named game chars
        if name not in {"Main Skater"}:
            return "skip-other"

    text = mcp.tool_text("get_character", {"character_id": row["id"]})
    if "status: completed" not in text and "rotations:" not in text:
        return f"not-ready:{text[:80].replace(chr(10),' ')}"

    meta, rotations, anims = parse_character(text)
    char_slug = "main" if name.startswith("Main Character") else slug(name)
    state_slug = slug(meta.get("state") or row.get("state") or "default")
    size = f"{meta.get('w') or row['w']}x{meta.get('h') or row['h']}"
    out = ROOT / "assets" / "characters" / char_slug / size / "states" / state_slug

    # marker to skip if already synced with same id
    meta_path = out / "meta.json"
    if meta_path.exists() and not force:
        old = json.loads(meta_path.read_text())
        if old.get("id") == row["id"] and (out / "south.png").exists():
            # still ensure anims present if listed
            missing = False
            for aname, frames in anims.items():
                aslug = anim_slug(aname)
                for d, info in frames.items():
                    nframes = info["i1"] - info["i0"] + 1
                    folder = out / "animations" / aslug / d
                    if not folder.exists() or len(list(folder.glob("frame_*.png"))) < nframes:
                        missing = True
                        break
                if missing:
                    break
            if not missing and rotations and all((out / "rotations" / f"{d}.png").exists() for d in rotations):
                return "exists"

    jobs: list[tuple[str, Path]] = []
    for d, url in rotations.items():
        jobs.append((url, out / "rotations" / f"{d}.png"))
        if d == "south":
            jobs.append((url, out / "south.png"))

    for aname, frames in anims.items():
        aslug = anim_slug(aname)
        for d, info in frames.items():
            tmpl = info["template"]
            for i in range(info["i0"], info["i1"] + 1):
                url = tmpl.replace("{i}", str(i))
                dest = out / "animations" / aslug / d / f"frame_{i:03d}.png"
                jobs.append((url, dest))

    written = fetch_jobs(jobs)

    meta_out = {
        "id": row["id"],
        "name": meta.get("name") or name,
        "state": meta.get("state") or row.get("state"),
        "size": size,
        "animations": sorted({anim_slug(a) for a in anims}),
        "animation_raw_names": sorted(anims.keys()),
        "path": str(out.relative_to(ROOT)),
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta_out, indent=2) + "\n")
    return f"ok+{written}"


def object_out_path(row: dict) -> Path | None:
    name = row["name"]
    state = row.get("state") or "default"
    size = row["size"]
    if name in SKIP_OBJ_EXACT:
        return None
    # messy prompt names without clean state
    if name.startswith("Isometric") or name.startswith("⁠") or "pixel art" in name.lower():
        # keep university / high school / police under buildings with slug from name
        if "university" in name.lower():
            base = "university"
        elif "high school" in name.lower():
            base = "highSchool"
        elif "police" in name.lower():
            base = "policeStation"
        elif "gas station" in name.lower():
            return None  # prefer named gasStation entries
        else:
            return None
        daynight = "night" if (state or "").lower() == "night" else "day" if (state or "").lower() == "day" else slug(state)
        return ROOT / "assets" / "buildings" / base / size / daynight

    if name == "vehicles":
        # jeep_Day / fishingBoat_Night / car_3_Day
        st = state or "unknown"
        m = re.match(r"^(.*?)_(Day|Night)$", st, re.I)
        if m:
            veh, dn = m.group(1), m.group(2).lower()
        else:
            veh, dn = st, "default"
        return ROOT / "assets" / "vehicles" / slug(veh) / size / dn

    # known building-like single names
    building_names = {
        "5floorBuilding",
        "casino",
        "singleHouse",
        "thePub",
        "gothicChurch",
        "duplexHouse",
        "modernLuxuryVilla",
        "theater",
        "basketballCourt",
        "library",
        "tennisCourt",
        "airport",
        "postOffice",
        "nightClub",
        "amusementPark",
        "footballStadium",
        "courthouse",
        "cinema",
        "fireStation",
        "superMarket",
        "cafe",
        "bank",
        "petShop",
        "gasStation",
        "gasStation2",
        "gasStation3",
        "hospital",
    }
    if name in building_names:
        dn = slug(state) if state else "default"
        return ROOT / "assets" / "buildings" / slug(name) / size / dn

    if name in {"lights", "smallAnimals", "outdoorPark", "road", "balls"}:
        # Keep folder casing for smallAnimals (macOS-safe + matches existing tree)
        prop_folder = "smallAnimals" if name == "smallAnimals" else slug(name)
        # state like trafficLight_Day / dog_3 / bench_Night / bird
        st = state or "default"
        m = re.match(r"^(.*?)_(Day|Night)$", st, re.I)
        if m:
            item, dn = m.group(1), m.group(2).lower()
            return ROOT / "assets" / "props" / prop_folder / slug(item) / size / dn
        return ROOT / "assets" / "props" / prop_folder / slug(st) / size / "default"

    if name in {"skateboard"}:
        return ROOT / "assets" / "objects" / "skateboard" / size / slug(state or "default")

    if "night" in name.lower() or name in {"inside", "night_club_inside"} or "nightclub" in name.lower() or "side-scroller" in name.lower() or "side view" in name.lower():
        return ROOT / "assets" / "interiors" / slug(name) / size / slug(state or "default")

    # fallback misc
    return ROOT / "assets" / "objects" / "misc" / slug(name) / size / slug(state or "default")


def sync_object_from_urls(mcp: PixelLabMCP, row: dict, out: Path, meta_path: Path) -> str:
    text = mcp.tool_text("get_object", {"object_id": row["id"]})
    _, rotations, anims = parse_character(text)
    if not rotations and not anims:
        return "fail:no-urls"
    jobs: list[tuple[str, Path]] = []
    for d, u in rotations.items():
        jobs.append((u, out / "rotations" / f"{d}.png"))
        if d in {"south", "unknown"}:
            jobs.append((u, out / "south.png"))
    for aname, frames in anims.items():
        aslug = anim_slug(aname)
        for d, info in frames.items():
            for i in range(info["i0"], info["i1"] + 1):
                jobs.append(
                    (
                        info["template"].replace("{i}", str(i)),
                        out / "animations" / aslug / d / f"frame_{i:03d}.png",
                    )
                )
    written = fetch_jobs(jobs)
    meta = {
        "id": row["id"],
        "name": row["name"],
        "state": row.get("state"),
        "size": row["size"],
        "path": str(out.relative_to(ROOT)),
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    return f"ok-url+{written}"


def sync_object(mcp: PixelLabMCP, row: dict, force: bool = False) -> str:
    out = object_out_path(row)
    if out is None:
        return "skip"
    meta_path = out / "meta.json"
    if meta_path.exists() and not force:
        old = json.loads(meta_path.read_text())
        if old.get("id") == row["id"] and (
            (out / "south.png").exists() or (out / "rotations" / "south.png").exists()
            or (out / "rotations" / "unknown.png").exists()
        ):
            return "exists"

    # Prefer zip download (some 1-dir objects return a raw PNG instead)
    url = f"https://api.pixellab.ai/mcp/objects/{row['id']}/download"
    try:
        data = http_get(url, auth=True)
    except Exception:
        return sync_object_from_urls(mcp, row, out, meta_path)

    # Raw PNG response (not a zip)
    if data[:4] == b"\x89PNG":
        out.mkdir(parents=True, exist_ok=True)
        (out / "rotations").mkdir(exist_ok=True)
        save_bytes(out / "rotations" / "unknown.png", data)
        save_bytes(out / "south.png", data)
        # also pull any extra rotations/anims from get_object
        extra = sync_object_from_urls(mcp, row, out, meta_path)
        return f"ok-png+{extra}"

    # extract zip
    written = 0
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return sync_object_from_urls(mcp, row, out, meta_path)
    out.mkdir(parents=True, exist_ok=True)
    (out / "rotations").mkdir(exist_ok=True)
    for name in z.namelist():
        if name.endswith("/"):
            continue
        low = name.replace("\\", "/")
        if "rotations/" in low and low.endswith(".png"):
            dest = out / "rotations" / Path(low).name
        elif "animations/" in low:
            idx = low.find("animations/")
            dest = out / low[idx:]
        else:
            dest = out / Path(low).name
        raw = z.read(name)
        if save_bytes(dest, raw):
            written += 1
        if Path(low).name in {"south.png", "unknown.png"} or low.endswith("/south.png"):
            save_bytes(out / "south.png", raw)

    # object animations (animals etc.) via get_object text
    text = mcp.tool_text("get_object", {"object_id": row["id"]})
    _, _, anims = parse_character(text)
    anim_jobs: list[tuple[str, Path]] = []
    for aname, frames in anims.items():
        aslug = anim_slug(aname)
        for d, info in frames.items():
            for i in range(info["i0"], info["i1"] + 1):
                anim_jobs.append(
                    (
                        info["template"].replace("{i}", str(i)),
                        out / "animations" / aslug / d / f"frame_{i:03d}.png",
                    )
                )
    written += fetch_jobs(anim_jobs)

    # Discover animation folder names from extracted zip / disk
    anim_names = sorted(
        {
            p.name
            for p in (out / "animations").glob("*")
            if p.is_dir()
        }
    ) if (out / "animations").exists() else sorted({anim_slug(a) for a in anims})
    meta = {
        "id": row["id"],
        "name": row["name"],
        "state": row.get("state"),
        "size": row["size"],
        "path": str(out.relative_to(ROOT)),
        "animations": anim_names,
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    return f"ok+{written}"


def main():
    load_token()
    mcp = PixelLabMCP()
    chars = list_all(mcp, "list_characters")
    objs = list_all(mcp, "list_objects")
    print(f"inventory characters={len(chars)} objects={len(objs)} workers={WORKERS}")

    # Characters first
    for i, row in enumerate(chars, 1):
        try:
            status = sync_character(mcp, row)
        except Exception as e:
            status = f"ERR:{e}"
        print(f"[char {i}/{len(chars)}] {row['name']}/{row.get('state')} -> {status}")

    for i, row in enumerate(objs, 1):
        try:
            status = sync_object(mcp, row)
        except Exception as e:
            status = f"ERR:{e}"
        print(f"[obj {i}/{len(objs)}] {row['name']}/{row.get('state')} -> {status}")

    # write index
    index = {"characters": [], "objects": []}
    for p in sorted((ROOT / "assets" / "characters").rglob("meta.json")):
        index["characters"].append(json.loads(p.read_text()))
    for base in ["vehicles", "buildings", "props", "interiors", "objects"]:
        root = ROOT / "assets" / base
        if not root.exists():
            continue
        for p in sorted(root.rglob("meta.json")):
            index["objects"].append(json.loads(p.read_text()))
    (ROOT / "assets" / "INDEX.json").write_text(json.dumps(index, indent=2) + "\n")
    print(
        f"done chars_meta={len(index['characters'])} objs_meta={len(index['objects'])}"
    )


if __name__ == "__main__":
    main()
