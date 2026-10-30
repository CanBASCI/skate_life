import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Player } from "./player.js";

const REF = 92;
/** Buildings are already max PixelLab canvas (256); enlarge in-scene vs char/vehicles. */
const BUILDING_SCALE = 1.85;
/** Static manifest ids replaced by the controllable animated player. */
const SKIP_STATIC_IDS = new Set(["main", "crouch"]);

const selectedEl = document.getElementById("selected");
const app = document.getElementById("app");
let player = null;
let lastTs = performance.now();
let followPlayer = true;

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
scene.fog = new THREE.Fog(0x1a2220, 900, 2200);

const aspect = window.innerWidth / window.innerHeight;
const frustum = 520;
const camera = new THREE.OrthographicCamera(
  -frustum * aspect,
  frustum * aspect,
  frustum,
  -frustum,
  0.1,
  5000,
);
// High top-down. camera.up -Z => +Z is toward bottom of screen (= "front").
camera.position.set(0, 1000, 0.01);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 80);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 80);
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI * 0.12;
controls.minZoom = 0.2;
controls.maxZoom = 6;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.PAN,
  TWO: THREE.TOUCH.DOLLY_PAN,
};
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.95));
const sun = new THREE.DirectionalLight(0xfff2d6, 0.35);
sun.position.set(200, 400, 100);
scene.add(sun);

function makeGroundTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const a = "#2a3830";
  const b = "#24312a";
  const tile = 8;
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      g.fillStyle = ((x + y) / tile) % 2 === 0 ? a : b;
      g.fillRect(x, y, tile, tile);
    }
  }
  g.strokeStyle = "#334439";
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, size - 1, size - 1);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3200, 3200),
  new THREE.MeshBasicMaterial({ map: makeGroundTexture() }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
scene.add(ground);

const plaza = new THREE.Mesh(
  new THREE.PlaneGeometry(520, 220),
  new THREE.MeshBasicMaterial({ color: 0x3a4a3c }),
);
plaza.rotation.x = -Math.PI / 2;
plaza.position.set(0, -0.2, 200);
scene.add(plaza);

const loader = new THREE.TextureLoader();
const pickables = [];
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function pixelTexture(url) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        resolve(tex);
      },
      undefined,
      reject,
    );
  });
}

/** Screen-bottom (+Z) draws in front of screen-top (−Z). */
function syncDepth(mesh) {
  const z = mesh.position.z;
  const layerBias = mesh.userData.layer === "ground" ? -10000 : 0;
  mesh.renderOrder = Math.round(z * 10 + layerBias);
  // Tiny Y lift by Z so overlaps resolve consistently if depthWrite on later
  if (mesh.userData.layer !== "ground") {
    mesh.position.y = 0.5 + z * 0.0001;
  }
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
  const geo = new THREE.PlaneGeometry(w * scale, h * scale);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  const y = item.layer === "ground" ? 0.05 : 0.5;
  mesh.position.set(item.x, y, item.z);
  mesh.userData = {
    id: item.id,
    label: item.label || item.id,
    w,
    h,
    scale,
    src: item.src,
    layer: item.layer || "sprite",
    vsRef: +((w * scale) / REF).toFixed(2),
    ring: null,
  };
  syncDepth(mesh);

  scene.add(mesh);
  pickables.push(mesh);
  return mesh;
}

function showSelection(mesh) {
  const d = mesh.userData;
  const scaleNote =
    d.scale !== 1
      ? ` · display <strong>×${d.scale}</strong> → <strong>${Math.round(d.w * d.scale)}×${Math.round(d.h * d.scale)}</strong>`
      : "";
  selectedEl.innerHTML =
    `<strong>${d.label}</strong> · canvas <strong>${d.w}×${d.h}</strong>${scaleNote}` +
    `<br/>pos <strong>x=${mesh.position.x.toFixed(0)} z=${mesh.position.z.toFixed(0)}</strong>` +
    `<br/><span style="color:#9bb09a">drag to move · lower on screen = in front</span>`;
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
  const hits = raycaster.intersectObjects(pickables, false);
  if (!hits.length) {
    selectedEl.textContent = "Click / drag an asset…";
    return;
  }
  const mesh = hits[0].object;
  dragging = mesh;
  controls.enabled = false;
  const gp = groundHit();
  if (gp) {
    dragOffset.set(mesh.position.x - gp.x, 0, mesh.position.z - gp.z);
  } else {
    dragOffset.set(0, 0, 0);
  }
  showSelection(mesh);
  renderer.domElement.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!dragging) return;
  setPointerFromEvent(event);
  const gp = groundHit();
  if (!gp) return;
  dragging.position.x = gp.x + dragOffset.x;
  dragging.position.z = gp.z + dragOffset.z;
  if (dragging.userData.ring) {
    dragging.userData.ring.position.x = dragging.position.x;
    dragging.userData.ring.position.z = dragging.position.z;
  }
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
        const tex = await pixelTexture(url);
        addSprite(item, tex);
      } catch (err) {
        console.warn("failed", item.id, url, err);
      }
    });
  await Promise.all(jobs);

  selectedEl.innerHTML = `Loading player animations…`;
  player = await new Player(scene, { x: 0, z: 200, syncDepth }).load();
  controls.target.copy(player.mesh.position);
  camera.position.set(player.mesh.position.x, 1000, player.mesh.position.z + 0.01);

  selectedEl.innerHTML =
    `Ready · <kbd>WASD</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · ` +
    `<kbd>C</kbd> crouch · <kbd>V</kbd> vault · drag props to rearrange`;
}

boot();

function tick(now) {
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  if (player) {
    player.update(dt);
    if (followPlayer && !dragging) {
      const p = player.mesh.position;
      controls.target.lerp(new THREE.Vector3(p.x, 0, p.z), 1 - Math.pow(0.001, dt));
      camera.position.x = controls.target.x;
      camera.position.z = controls.target.z + 0.01;
    }
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
