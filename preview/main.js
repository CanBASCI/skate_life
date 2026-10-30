import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Player } from "./player.js";

const REF = 92;
const BUILDING_SCALE = 1.85;
const SKIP_STATIC_IDS = new Set(["main", "crouch"]);
/** High top-down: elevated + south offset — not flattened straight-down. */
const CAM_OFFSET = new THREE.Vector3(0, 620, 520);

const selectedEl = document.getElementById("selected");
const app = document.getElementById("app");
let player = null;
let lastTs = performance.now();
const followPlayer = true;

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x1a2220, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x1a2220, 1100, 2600);

const aspect = window.innerWidth / window.innerHeight;
const frustum = 420;
const camera = new THREE.OrthographicCamera(
  -frustum * aspect,
  frustum * aspect,
  frustum,
  -frustum,
  0.1,
  5000,
);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 120);
controls.minPolarAngle = Math.PI * 0.28; // ~50° from horizon — high top-down
controls.maxPolarAngle = Math.PI * 0.42; // don't go flat side-view or nadir
controls.minZoom = 0.25;
controls.maxZoom = 5;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = {
  ONE: THREE.TOUCH.PAN,
  TWO: THREE.TOUCH.DOLLY_PAN,
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
ground.position.y = 0;
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

/** Crop remaining transparent margin at load (handles CDN/cache + union pads). */
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
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        try {
          resolve(tightTrimTexture(tex));
        } catch (err) {
          console.warn("trim failed", url, err);
          resolve(tex);
        }
      },
      undefined,
      reject,
    );
  });
}

/** Only solid pixels count — never fall back to full quad. */
function opaqueHits(hits, alphaThr = 8) {
  const out = [];
  for (const hit of hits) {
    if (!hit.uv) continue;
    const map = hit.object.material?.map;
    const data = map?.userData?.alpha;
    if (!data) continue;
    const x = Math.min(data.width - 1, Math.max(0, Math.floor(hit.uv.x * data.width)));
    // Sprite/Mesh UV v=0 at bottom; canvas y=0 at top
    const y = Math.min(
      data.height - 1,
      Math.max(0, Math.floor((1 - hit.uv.y) * data.height)),
    );
    const a = data.data[(y * data.width + x) * 4 + 3];
    if (a > alphaThr) out.push(hit);
  }
  return out;
}

/** +Z (south / screen-lower with our camera) draws in front. */
function syncDepth(obj) {
  const z = obj.position.z;
  const layerBias = obj.userData.layer === "ground" ? -10000 : 0;
  obj.renderOrder = Math.round(z * 10 + layerBias);
}

function defaultScale(item) {
  if (item.scale != null) return item.scale;
  if (item.src.includes("/buildings/")) return BUILDING_SCALE;
  return 1;
}

function addSprite(item, tex) {
  const img = tex.image;
  const w = img.width;
  const h = img.height;
  const scale = defaultScale(item);
  const displayW = w * scale;
  const displayH = h * scale;

  // Ground decals (road) stay flat on the floor.
  if (item.layer === "ground") {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(displayW, displayH),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        alphaTest: 0.05,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(item.x, 0.08, item.z);
    mesh.userData = {
      id: item.id,
      label: item.label || item.id,
      w,
      h,
      scale,
      src: item.src,
      layer: "ground",
      vsRef: +(displayW / REF).toFixed(2),
    };
    syncDepth(mesh);
    scene.add(mesh);
    pickables.push(mesh);
    return mesh;
  }

  // High top-down art: camera-facing billboards (not floor pancakes).
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.center.set(0.5, 0); // feet / base on ground
  sprite.scale.set(displayW, displayH, 1);
  sprite.position.set(item.x, 0, item.z);
  sprite.userData = {
    id: item.id,
    label: item.label || item.id,
    w,
    h,
    scale,
    src: item.src,
    layer: "sprite",
    vsRef: +(displayW / REF).toFixed(2),
  };
  syncDepth(sprite);
  scene.add(sprite);
  pickables.push(sprite);
  return sprite;
}

function showSelection(obj) {
  const d = obj.userData;
  const scaleNote =
    d.scale !== 1
      ? ` · display <strong>×${d.scale}</strong> → <strong>${Math.round(d.w * d.scale)}×${Math.round(d.h * d.scale)}</strong>`
      : "";
  selectedEl.innerHTML =
    `<strong>${d.label}</strong> · canvas <strong>${d.w}×${d.h}</strong>${scaleNote}` +
    `<br/>pos <strong>x=${obj.position.x.toFixed(0)} z=${obj.position.z.toFixed(0)}</strong>`;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hitPoint = new THREE.Vector3();
let dragging = null;
let dragOffset = new THREE.Vector3();

function setPointerFromEvent(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function groundHit() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.intersectPlane(groundPlane, hitPoint) ? hitPoint : null;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const hits = opaqueHits(raycaster.intersectObjects(pickables, false));
  if (!hits.length) {
    selectedEl.textContent = "Click / drag an asset…";
    return;
  }
  const obj = hits[0].object;
  dragging = obj;
  controls.enabled = false;
  const gp = groundHit();
  if (gp) dragOffset.set(obj.position.x - gp.x, 0, obj.position.z - gp.z);
  else dragOffset.set(0, 0, 0);
  showSelection(obj);
  renderer.domElement.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!dragging) return;
  setPointerFromEvent(event);
  const gp = groundHit();
  if (!gp) return;
  dragging.position.x = gp.x + dragOffset.x;
  dragging.position.z = gp.z + dragOffset.z;
  syncDepth(dragging);
  showSelection(dragging);
}

function onPointerUp(event) {
  if (!dragging) return;
  dragging = null;
  controls.enabled = true;
  try {
    renderer.domElement.releasePointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
}

renderer.domElement.addEventListener("pointerdown", onPointerDown);
renderer.domElement.addEventListener("pointermove", onPointerMove);
renderer.domElement.addEventListener("pointerup", onPointerUp);
renderer.domElement.addEventListener("pointercancel", onPointerUp);

function onResize() {
  const a = window.innerWidth / window.innerHeight;
  camera.left = -frustum * a;
  camera.right = frustum * a;
  camera.top = frustum;
  camera.bottom = -frustum;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);

async function boot() {
  const manifest = await fetch("./manifest.json").then((r) => r.json());
  const jobs = manifest.items
    .filter((item) => !SKIP_STATIC_IDS.has(item.id))
    .map(async (item) => {
      const url = new URL(`../${item.src}`, import.meta.url).href;
      try {
        addSprite(item, await pixelTexture(url));
      } catch (err) {
        console.warn("failed", item.id, url, err);
      }
    });
  await Promise.all(jobs);

  selectedEl.innerHTML = `Loading player animations…`;
  player = await new Player(scene, { x: 0, z: 200, syncDepth }).load();
  controls.target.set(player.mesh.position.x, 0, player.mesh.position.z);
  placeCamera(controls.target);

  selectedEl.innerHTML =
    `Ready · high top-down · <kbd>WASD</kbd> <kbd>Shift</kbd> <kbd>Space</kbd> <kbd>C</kbd> <kbd>V</kbd>`;
}

boot();

function tick(now) {
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  if (player) {
    player.update(dt);
    if (followPlayer && !dragging) {
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
