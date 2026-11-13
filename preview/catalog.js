export const DIRS = [
  "north-west",
  "north",
  "north-east",
  "west",
  "south",
  "east",
  "south-west",
  "south-east",
];

export const OBJ_CAT_ORDER = [
  "roads",
  "buildings",
  "vehicles",
  "props",
  "interiors",
  "objects",
];
export const OBJ_CAT_LABEL = {
  roads: "Roads",
  buildings: "Buildings",
  vehicles: "Vehicles",
  props: "Props",
  interiors: "Interiors",
  objects: "Misc",
};

/** Tileable flat roads live under props/roadTiles (and legacy props/road). */
export function objectCat(entry) {
  const path = entry.path || "";
  if (/\/roadTiles\//i.test(path) || /\/props\/road\//i.test(path)) return "roads";
  const parts = path.split("/");
  return parts[1] || "objects";
}

export function assetUrl(rel) {
  return new URL(`../${rel.replace(/^\.?\/?/, "")}`, import.meta.url).href;
}

export function thumbUrls(path) {
  const base = path.replace(/\/$/, "");
  return [
    assetUrl(`${base}/south.png`),
    assetUrl(`${base}/rotations/south.png`),
    assetUrl(`${base}/rotations/unknown.png`),
    assetUrl(`${base}/unknown.png`),
  ];
}

function charGroupKey(entry) {
  const path = entry.path || "";
  const m = path.match(/assets\/characters\/([^/]+)/);
  return m ? m[1] : entry.name || "char";
}

export async function loadCatalog() {
  const index = await fetch(assetUrl("assets/INDEX.json")).then((r) => r.json());

  const objects = (index.objects || []).map((o) => {
    const cat = objectCat(o);
    const label =
      cat === "roads"
        ? o.state || o.name || "road"
        : [o.name, o.state].filter(Boolean).join(" · ");
    return {
      kind: "object",
      id: o.id,
      cat,
      label,
      path: o.path,
      size: o.size || (o.w && o.h ? `${o.w}x${o.h}` : undefined),
      tileable: !!o.tileable || /\/roadTiles\//i.test(o.path || ""),
      tileSize: o.tileSize || (/\/roadTiles\//i.test(o.path || "") ? 64 : undefined),
      thumbs: thumbUrls(o.path),
    };
  });

  const characters = (index.characters || []).map((c) => {
    const group = charGroupKey(c);
    return {
      kind: "character",
      id: c.id,
      cat: group,
      label: [c.name, c.state].filter(Boolean).join(" · "),
      path: c.path,
      size: c.size,
      animations: c.animations || [],
      thumbs: thumbUrls(c.path),
    };
  });

  return { objects, characters };
}

export function groupByCat(items, order, labels) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.cat)) map.set(item.cat, []);
    map.get(item.cat).push(item);
  }
  const keys = order
    ? [
        ...order.filter((k) => map.has(k)),
        ...[...map.keys()].filter((k) => !order.includes(k)).sort(),
      ]
    : [...map.keys()].sort();
  return keys.map((key) => ({
    key,
    label: (labels && labels[key]) || key,
    items: map.get(key),
  }));
}
