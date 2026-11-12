import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Player } from "./player.js";
import {
  loadCatalog,
  groupByCat,
  assetUrl,
  DIRS,
  OBJ_CAT_ORDER,
  OBJ_CAT_LABEL,
} from "./catalog.js";

const REF = 92;
const BUILDING_SCALE = 1.85;
const CAM_OFFSET = new THREE.Vector3(0, 620, 520);
const DIR_LABELS = {
  "north-west": "↖",
  north: "↑",
  "north-east": "↗",
  west: "←",
  south: "·",
  east: "→",
  "south-west": "↙",
  "south-east": "↘",
};

const statusEl = document.getElementById("status");
const app = document.getElementById("app");
const inspector = document.getElementById("inspector");
const inspLabel = document.getElementById("insp-label");
const inspX = document.getElementById("insp-x");
const inspZ = document.getElementById("insp-z");
const inspScale = document.getElementById("insp-scale");
const inspScaleVal = document.getElementById("insp-scale-val");
const inspDirs = document.getElementById("insp-dirs");
const inspDelete = document.getElementById("insp-delete");
const dragGhost = document.getElementById("drag-ghost");

let player = null;
let lastTs = performance.now();
let selected = null;
let catalogItemById = new Map();
let placing = null; // catalog item while dragging from palette
const texCache = new Map(); // url -> Promise<Texture>

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x1a2220, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x1a2220, 1100, 2600);

let aspect = 1;
const frustum = 420;
const camera = new THREE.OrthographicCamera(
  -frustum,
  frustum,
  frustum,
  -frustum,
  0.1,
  5000,
);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 120);
controls.minPolarAngle = Math.PI * 0.28;
controls.maxPolarAngle = Math.PI * 0.42;
controls.minZoom = 0.25;
controls.maxZoom = 5;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};

function placeCamera(target = controls.target) {
  camera.position.set(
    target.x + CAM_OFFSET.x,
    target.y + CAM_OFFSET.y,
    target.z + CAM_OFFSET.z,
  );
  camera.lookAt(target);
  controls.update();
}
placeCamera();
scene.add(new THREE.AmbientLight(0xffffff, 1));

function makeGroundTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const tile = 8;
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      g.fillStyle = ((x + y) / tile) % 2 === 0 ? "#2a3830" : "#24312a";
      g.fillRect(x, y, tile, tile);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(28, 28);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3600, 3600),
  new THREE.MeshBasicMaterial({ map: makeGroundTexture() }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const plaza = new THREE.Mesh(
  new THREE.PlaneGeometry(520, 220),
  new THREE.MeshBasicMaterial({ color: 0x3a4a3c }),
);
plaza.rotation.x = -Math.PI / 2;
plaza.position.set(0, 0.05, 200);
scene.add(plaza);

const loader = new THREE.TextureLoader();
const pickables = [];
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hitPoint = new THREE.Vector3();
let dragging = null;
let dragOffset = new THREE.Vector3();

function resize() {
  const w = app.clientWidth || window.innerWidth;
  const h = app.clientHeight || window.innerHeight;
  aspect = w / h;
  camera.left = -frustum * aspect;
  camera.right = frustum * aspect;
  camera.top = frustum;
  camera.bottom = -frustum;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", resize);
resize();

function tightTrimTexture(tex, thr = 1) {
  const img = tex.image;
  const src = document.createElement("canvas");
  src.width = img.width;
  src.height = img.height;
  const sg = src.getContext("2d", { willReadFrequently: true });
  sg.drawImage(img, 0, 0);
  const { data, width: w, height: h } = sg.getImageData(0, 0, src.width, src.height);
  let minx = w;
  let miny = h;
  let maxx = -1;
  let maxy = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > thr) {
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return tex;
  minx = Math.max(0, minx - 1);
  miny = Math.max(0, miny - 1);
  maxx = Math.min(w - 1, maxx + 1);
  maxy = Math.min(h - 1, maxy + 1);
  const tw = maxx - minx + 1;
  const th = maxy - miny + 1;
  if (tw === w && th === h && minx === 0 && miny === 0) {
    tex.userData = { alpha: sg.getImageData(0, 0, w, h) };
    return tex;
  }
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  const og = out.getContext("2d", { willReadFrequently: true });
  og.drawImage(src, minx, miny, tw, th, 0, 0, tw, th);
  const trimmed = new THREE.CanvasTexture(out);
  trimmed.magFilter = THREE.NearestFilter;
  trimmed.minFilter = THREE.NearestFilter;
  trimmed.generateMipmaps = false;
  trimmed.colorSpace = THREE.SRGBColorSpace;
  trimmed.userData = { alpha: og.getImageData(0, 0, tw, th) };
  tex.dispose();
  return trimmed;
}

function pixelTexture(url) {
  if (texCache.has(url)) return texCache.get(url);
  const p = new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        try {
          resolve(tightTrimTexture(tex));
        } catch {
          resolve(tex);
        }
      },
      undefined,
      reject,
    );
  });
  texCache.set(url, p);
  return p;
}

async function loadAnyTexture(urls) {
  for (const url of urls) {
    try {
      return { tex: await pixelTexture(url), url };
    } catch {
      /* next */
    }
  }
  throw new Error("no texture");
}

function opaqueHits(hits, alphaThr = 8) {
  const out = [];
  for (const hit of hits) {
    if (!hit.uv) continue;
    const map = hit.object.material?.map;
    const data = map?.userData?.alpha;
    if (!data) continue;
    const x = Math.min(data.width - 1, Math.max(0, Math.floor(hit.uv.x * data.width)));
    const y = Math.min(
      data.height - 1,
      Math.max(0, Math.floor((1 - hit.uv.y) * data.height)),
    );
    if (data.data[(y * data.width + x) * 4 + 3] > alphaThr) out.push(hit);
  }
  return out;
}

function syncDepth(obj) {
  const layerBias = obj.userData?.layer === "ground" ? -10000 : 0;
  obj.renderOrder = Math.round(obj.position.z * 10 + layerBias);
}

function defaultScale(item) {
  if (item.kind === "object" && item.path.includes("/buildings/")) return BUILDING_SCALE;
  return 1;
}

/** Animals + characters are billboards. Only true floor decals stay flat on ground.
 *  Buildings/vehicles are also billboards: their art is already high-top-down;
 *  laying them flat foreshortens depth and looks horizontally stretched. */
function isAnimalPath(path) {
  return /smallAnimals|smallanimals/i.test(path || "");
}

function usesGroundPlane(item) {
  if (item.kind !== "object") return false;
  return /\/props\/road\//i.test(item.path || "");
}

function wantsIdle(item) {
  return (
    item.kind === "character" ||
    isAnimalPath(item.path) ||
    /\/interiors\//i.test(item.path || "")
  );
}

const IDLE_NAME_CANDIDATES = [
  "idle",
  "sit",
  "dog_idle",
  "dog_standing_idle",
  "cute_cat_idle",
  "cute_fat_dog_idle",
  "bird_standing_idle",
  "standing_idle",
  "breathing-idle",
];

/** Static server directory listing of animations/ (Python http.server). */
async function listAnimSlugs(path) {
  try {
    const res = await fetch(assetUrl(`${path}/animations/`));
    if (!res.ok) return [];
    const html = await res.text();
    const slugs = [];
    for (const m of html.matchAll(/href="([^"?#]+)\/"/gi)) {
      let name = decodeURIComponent(m[1]);
      name = name.replace(/\/$/, "").split("/").pop();
      if (!name || name === ".." || name === ".") continue;
      slugs.push(name);
    }
    return [...new Set(slugs)];
  } catch {
    return [];
  }
}

async function resolveIdleSlug(path) {
  try {
    const meta = await fetch(assetUrl(`${path}/meta.json`)).then((r) => r.json());
    const anims = meta.animations || [];
    // Prefer idle-like, then sit loops, else whatever this state has (chair poses etc.)
    const hit =
      anims.find((a) => /idle/i.test(a)) ||
      anims.find((a) => /sit/i.test(a)) ||
      anims[0];
    if (hit) return hit;
  } catch {
    /* no meta */
  }
  for (const name of IDLE_NAME_CANDIDATES) {
    const url = assetUrl(`${path}/animations/${name}/south/frame_000.png`);
    if (await imageExists(url)) return name;
    if (await imageExists(assetUrl(`${path}/animations/${name}/unknown/frame_000.png`))) {
      return name;
    }
  }
  // Interiors / custom loops: pick first folder under animations/
  const listed = await listAnimSlugs(path);
  if (listed.length) {
    const prefer =
      listed.find((a) => /idle|disco|rotate|sit/i.test(a)) || listed[0];
    return prefer;
  }
  return null;
}

async function loadAnimFrames(path, slug, dir) {
  const frames = [];
  for (let i = 0; i < 48; i++) {
    const url = assetUrl(
      `${path}/animations/${slug}/${dir}/frame_${String(i).padStart(3, "0")}.png`,
    );
    try {
      frames.push(await pixelTexture(url));
    } catch {
      break;
    }
  }
  return frames;
}

async function attachIdle(obj, path, dir) {
  const slug = obj.userData.idleSlug || (await resolveIdleSlug(path));
  if (!slug) return false;
  obj.userData.idleSlug = slug;
  let frames = await loadAnimFrames(path, slug, dir);
  if (!frames.length && dir !== "south") {
    frames = await loadAnimFrames(path, slug, "south");
  }
  if (!frames.length) {
    frames = await loadAnimFrames(path, slug, "unknown");
  }
  if (!frames.length) return false;
  obj.userData.anim = {
    frames,
    frame: 0,
    accum: 0,
    fps: 3.5,
    dir,
  };
  setMap(obj, frames[0]);
  return true;
}

function rotationUrl(path, dir) {
  return assetUrl(`${path.replace(/\/$/, "")}/rotations/${dir}.png`);
}

function imageExists(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

async function probeDirs(path) {
  const available = [];
  await Promise.all(
    DIRS.map(async (dir) => {
      if (await imageExists(rotationUrl(path, dir))) available.push(dir);
    }),
  );
  if (!available.length) {
    for (const name of ["unknown", "south"]) {
      if (await imageExists(rotationUrl(path, name))) {
        available.push(name);
        break;
      }
    }
  }
  if (!available.length && (await imageExists(assetUrl(`${path}/south.png`)))) {
    available.push("south");
  }
  // keep compass order
  const order = [...DIRS, "unknown"];
  return order.filter((d) => available.includes(d));
}

function applyScale(obj) {
  const d = obj.userData;
  const displayW = d.w * d.scale;
  const displayH = d.h * d.scale;
  if (d.layer === "ground") {
    // PlaneGeometry(1,1) unit quad → scale to pixel size
    obj.scale.set(displayW, displayH, 1);
  } else {
    obj.scale.set(displayW, displayH, 1);
  }
}

function setMap(obj, tex) {
  obj.material.map = tex;
  obj.material.needsUpdate = true;
  obj.userData.w = tex.image.width;
  obj.userData.h = tex.image.height;
  applyScale(obj);
}

async function setDirection(obj, dir) {
  const d = obj.userData;
  if (!d.dirs.includes(dir)) return;
  d.dir = dir;
  if (d.idleSlug || d.anim) {
    const ok = await attachIdle(obj, d.path, dir);
    if (ok) {
      refreshInspector();
      return;
    }
  }
  if (dir === "south" && d.fallbackSouth) {
    try {
      const { tex } = await loadAnyTexture([
        rotationUrl(d.path, "south"),
        assetUrl(`${d.path}/south.png`),
      ]);
      setMap(obj, tex);
      refreshInspector();
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    const tex = await pixelTexture(rotationUrl(d.path, dir));
    setMap(obj, tex);
    refreshInspector();
  } catch (err) {
    console.warn("dir failed", dir, err);
  }
}

async function spawnItem(item, x, z) {
  const { tex } = await loadAnyTexture(item.thumbs);
  const dirs = await probeDirs(item.path);
  const scale = defaultScale(item);
  const w = tex.image.width;
  const h = tex.image.height;
  const dir = dirs.includes("south") ? "south" : dirs[0] || "south";
  const userData = {
    kind: item.kind,
    catalogId: item.id,
    label: item.label,
    path: item.path,
    w,
    h,
    scale,
    dir,
    dirs,
    fallbackSouth: true,
    editable: true,
  };

  let obj;
  if (usesGroundPlane(item)) {
    // Flat on ground — isometric building art must NOT stand up as billboards
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
    });
    obj = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    obj.rotation.x = -Math.PI / 2;
    obj.position.set(x, 0.08, z);
    obj.scale.set(w * scale, h * scale, 1);
    userData.layer = "ground";
  } else {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
    });
    obj = new THREE.Sprite(mat);
    obj.center.set(0.5, 0);
    obj.scale.set(w * scale, h * scale, 1);
    obj.position.set(x, 0, z);
    userData.layer = "sprite";
  }

  obj.userData = userData;
  syncDepth(obj);
  scene.add(obj);
  pickables.push(obj);

  if (wantsIdle(item)) {
    statusEl.textContent = "Idle yükleniyor…";
    await attachIdle(obj, item.path, dir);
    statusEl.textContent = "Hazır";
  }

  selectObject(obj);
  return obj;
}

function selectObject(obj) {
  selected = obj;
  if (!obj) {
    inspector.classList.add("hidden");
    return;
  }
  inspector.classList.remove("hidden");
  refreshInspector();
}

function refreshInspector() {
  if (!selected) return;
  const d = selected.userData;
  inspLabel.textContent = d.label || d.id || "item";
  inspX.value = Math.round(selected.position.x);
  inspZ.value = Math.round(selected.position.z);
  inspScale.value = d.scale;
  inspScaleVal.textContent = Number(d.scale).toFixed(2);

  inspDirs.innerHTML = "";
  inspDirs.style.gridTemplateAreas = `
    "nw n ne"
    "w  c e"
    "sw s se"
  `;
  const areaMap = {
    "north-west": "nw",
    north: "n",
    "north-east": "ne",
    west: "w",
    east: "e",
    "south-west": "sw",
    south: "s",
    "south-east": "se",
  };
  for (const dir of DIRS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = DIR_LABELS[dir] || dir[0];
    btn.title = dir;
    btn.style.gridArea = areaMap[dir];
    const can =
      d.dirs.includes(dir) || (dir === "south" && d.dirs.includes("unknown"));
    btn.disabled = !can;
    if (d.dir === dir || (d.dir === "unknown" && dir === "south")) {
      btn.classList.add("active");
    }
    if (can) {
      btn.addEventListener("click", () => {
        const target = d.dirs.includes(dir) ? dir : "unknown";
        setDirection(selected, target);
      });
    }
    inspDirs.appendChild(btn);
  }
  const mid = document.createElement("button");
  mid.type = "button";
  mid.textContent = "◎";
  mid.disabled = true;
  mid.style.gridArea = "c";
  mid.title = d.dir;
  inspDirs.appendChild(mid);
}

inspX.addEventListener("change", () => {
  if (!selected) return;
  selected.position.x = Number(inspX.value) || 0;
  syncDepth(selected);
});
inspZ.addEventListener("change", () => {
  if (!selected) return;
  selected.position.z = Number(inspZ.value) || 0;
  syncDepth(selected);
});
inspScale.addEventListener("input", () => {
  if (!selected) return;
  selected.userData.scale = Number(inspScale.value);
  inspScaleVal.textContent = selected.userData.scale.toFixed(2);
  applyScale(selected);
});
inspDelete.addEventListener("click", () => {
  if (!selected || !selected.userData.editable) return;
  scene.remove(selected);
  const i = pickables.indexOf(selected);
  if (i >= 0) pickables.splice(i, 1);
  selected.material?.map?.dispose?.();
  selected.material?.dispose?.();
  selectObject(null);
});

function setPointerFromEvent(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function groundHit() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.intersectPlane(groundPlane, hitPoint) ? hitPoint.clone() : null;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  if (placing) return;
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  raycaster.camera = camera;
  const hits = opaqueHits(raycaster.intersectObjects(pickables, false));
  if (!hits.length) {
    selectObject(null);
    return;
  }
  const obj = hits[0].object;
  if (!obj.userData.editable) {
    selectObject(null);
    return;
  }
  dragging = obj;
  selectObject(obj);
  controls.enabled = false;
  const gp = groundHit();
  if (gp) dragOffset.set(obj.position.x - gp.x, 0, obj.position.z - gp.z);
  else dragOffset.set(0, 0, 0);
  renderer.domElement.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (placing) {
    dragGhost.style.left = `${event.clientX}px`;
    dragGhost.style.top = `${event.clientY}px`;
    return;
  }
  if (!dragging) return;
  setPointerFromEvent(event);
  const gp = groundHit();
  if (!gp) return;
  dragging.position.x = gp.x + dragOffset.x;
  dragging.position.z = gp.z + dragOffset.z;
  syncDepth(dragging);
  if (selected === dragging) {
    inspX.value = Math.round(dragging.position.x);
    inspZ.value = Math.round(dragging.position.z);
  }
}

async function onPointerUp(event) {
  if (placing) {
    setPointerFromEvent(event);
    const gp = groundHit();
    const item = placing;
    endPaletteDrag();
    if (gp) {
      statusEl.textContent = "Yerleştiriliyor…";
      try {
        await spawnItem(item, gp.x, gp.z);
        statusEl.textContent = "Hazır";
      } catch (err) {
        console.warn(err);
        statusEl.textContent = "Yüklenemedi";
      }
    }
    return;
  }
  if (!dragging) return;
  dragging = null;
  controls.enabled = true;
  try {
    renderer.domElement.releasePointerCapture(event.pointerId);
  } catch {
    /* */
  }
}

renderer.domElement.addEventListener("pointerdown", onPointerDown);
renderer.domElement.addEventListener("pointermove", onPointerMove);
renderer.domElement.addEventListener("pointerup", onPointerUp);
renderer.domElement.addEventListener("pointercancel", onPointerUp);

window.addEventListener("keydown", (e) => {
  if (!selected || !selected.userData.editable) return;
  if (e.target.matches?.("input, textarea")) return;
  const dirs = selected.userData.dirs.length
    ? selected.userData.dirs
    : DIRS;
  if (!dirs.length) return;
  let idx = dirs.indexOf(selected.userData.dir);
  if (idx < 0) idx = 0;
  if (e.key === "q" || e.key === "Q") {
    idx = (idx - 1 + dirs.length) % dirs.length;
    setDirection(selected, dirs[idx]);
  } else if (e.key === "e" || e.key === "E") {
    idx = (idx + 1) % dirs.length;
    setDirection(selected, dirs[idx]);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    inspDelete.click();
  }
});

function endPaletteDrag() {
  placing = null;
  dragGhost.classList.add("hidden");
  dragGhost.style.backgroundImage = "";
}

function startPaletteDrag(item, event) {
  placing = item;
  dragGhost.classList.remove("hidden");
  dragGhost.style.backgroundImage = `url("${item.thumbs[0]}")`;
  dragGhost.style.left = `${event.clientX}px`;
  dragGhost.style.top = `${event.clientY}px`;
  controls.enabled = false;
}

function bindThumbFallback(img, urls) {
  let i = 0;
  img.src = urls[0];
  img.onerror = () => {
    i += 1;
    if (i < urls.length) img.src = urls[i];
    else img.onerror = null;
  };
}

function renderPalette(root, groups, filterText) {
  root.innerHTML = "";
  const q = (filterText || "").trim().toLowerCase();
  for (const g of groups) {
    const items = q
      ? g.items.filter((it) => it.label.toLowerCase().includes(q) || g.key.includes(q))
      : g.items;
    if (!items.length) continue;
    const cat = document.createElement("div");
    cat.className = "cat";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "cat-head";
    head.innerHTML = `<span>${g.label}</span><span>${items.length}</span>`;
    head.addEventListener("click", () => cat.classList.toggle("collapsed"));
    const grid = document.createElement("div");
    grid.className = "cat-grid";
    for (const item of items) {
      catalogItemById.set(item.id + ":" + item.path, item);
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.draggable = true;
      tile.title = item.label;
      const img = document.createElement("img");
      img.alt = "";
      bindThumbFallback(img, item.thumbs);
      const span = document.createElement("span");
      span.textContent = item.label;
      tile.append(img, span);
      tile.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ id: item.id, path: item.path }));
        e.dataTransfer.effectAllowed = "copy";
        startPaletteDrag(item, e);
      });
      tile.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        // click-drag without HTML5 drag for canvas drop reliability
        e.preventDefault();
        startPaletteDrag(item, e);
        const move = (ev) => onPointerMove(ev);
        const up = async (ev) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          controls.enabled = true;
          // if released over canvas
          const rect = renderer.domElement.getBoundingClientRect();
          const over =
            ev.clientX >= rect.left &&
            ev.clientX <= rect.right &&
            ev.clientY >= rect.top &&
            ev.clientY <= rect.bottom;
          if (over && placing) await onPointerUp(ev);
          else endPaletteDrag();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
      grid.appendChild(tile);
    }
    cat.append(head, grid);
    root.appendChild(cat);
  }
}

async function boot() {
  statusEl.textContent = "Katalog…";
  const catalog = await loadCatalog();
  renderPalette(
    document.getElementById("obj-cats"),
    groupByCat(catalog.objects, OBJ_CAT_ORDER, OBJ_CAT_LABEL),
    "",
  );
  renderPalette(
    document.getElementById("char-cats"),
    groupByCat(catalog.characters, null, null),
    "",
  );
  document.getElementById("obj-filter").addEventListener("input", (e) => {
    renderPalette(
      document.getElementById("obj-cats"),
      groupByCat(catalog.objects, OBJ_CAT_ORDER, OBJ_CAT_LABEL),
      e.target.value,
    );
  });
  document.getElementById("char-filter").addEventListener("input", (e) => {
    renderPalette(
      document.getElementById("char-cats"),
      groupByCat(catalog.characters, null, null),
      e.target.value,
    );
  });

  statusEl.textContent = "Oyuncu…";
  player = await new Player(scene, { x: 0, z: 200, syncDepth }).load();
  // player not in pickables editor list
  controls.target.set(player.mesh.position.x, 0, player.mesh.position.z);
  placeCamera(controls.target);
  statusEl.textContent = "Hazır";
}

boot().catch((err) => {
  console.error(err);
  statusEl.textContent = "Hata: " + err.message;
});

function tickAnims(dt) {
  for (const obj of pickables) {
    const anim = obj.userData?.anim;
    if (!anim?.frames?.length) continue;
    anim.accum += dt;
    const step = 1 / (anim.fps || 3.5);
    while (anim.accum >= step) {
      anim.accum -= step;
      anim.frame = (anim.frame + 1) % anim.frames.length;
    }
    const tex = anim.frames[anim.frame];
    if (obj.material.map !== tex) {
      obj.material.map = tex;
      obj.material.needsUpdate = true;
    }
  }
}

function tick(now) {
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  tickAnims(dt);
  if (player) {
    player.update(dt);
    if (!dragging && !placing) {
      const p = player.mesh.position;
      const t = 1 - Math.pow(0.0008, dt);
      controls.target.x += (p.x - controls.target.x) * t;
      controls.target.z += (p.z - controls.target.z) * t;
      camera.position.x = controls.target.x + CAM_OFFSET.x;
      camera.position.y = controls.target.y + CAM_OFFSET.y;
      camera.position.z = controls.target.z + CAM_OFFSET.z;
    }
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
