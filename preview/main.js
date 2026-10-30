import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const REF = 92;
const selectedEl = document.getElementById("selected");
const app = document.getElementById("app");

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
const frustum = 420;
const camera = new THREE.OrthographicCamera(
  -frustum * aspect,
  frustum * aspect,
  frustum,
  -frustum,
  0.1,
  5000,
);
// High top-down: nearly straight above (sprites already bake perspective).
camera.position.set(0, 1000, 0.01);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 80);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 80);
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI * 0.12; // ~0–22° tilt only
controls.minZoom = 0.25;
controls.maxZoom = 6;
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
  new THREE.PlaneGeometry(2400, 2400),
  new THREE.MeshBasicMaterial({ map: makeGroundTexture() }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
ground.receiveShadow = false;
scene.add(ground);

// Soft plaza under characters
const plaza = new THREE.Mesh(
  new THREE.PlaneGeometry(520, 220),
  new THREE.MeshBasicMaterial({ color: 0x3a4a3c }),
);
plaza.rotation.x = -Math.PI / 2;
plaza.position.set(0, -0.2, 200);
scene.add(plaza);

const loader = new THREE.TextureLoader();
const pickables = [];
const byId = new Map();

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

function addSprite(item, tex) {
  const img = tex.image;
  const w = img.width;
  const h = img.height;
  const geo = new THREE.PlaneGeometry(w, h);
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
  mesh.renderOrder = Math.round(1000 - item.z + (item.layer === "ground" ? -500 : 0));
  mesh.userData = {
    id: item.id,
    label: item.label || item.id,
    w,
    h,
    src: item.src,
    vsRef: +(w / REF).toFixed(2),
  };
  if (item.highlight) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(REF * 0.55, REF * 0.62, 32),
      new THREE.MeshBasicMaterial({ color: 0xc6e86b, transparent: true, opacity: 0.7 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(item.x, 0.3, item.z);
    scene.add(ring);
  }
  scene.add(mesh);
  pickables.push(mesh);
  byId.set(item.id, mesh);
  return mesh;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function onPointer(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  if (!hits.length) {
    selectedEl.textContent = "Click any asset…";
    return;
  }
  const d = hits[0].object.userData;
  selectedEl.innerHTML = `<strong>${d.label}</strong> · canvas <strong>${d.w}×${d.h}</strong> · vs main 92 → <strong>${d.vsRef}×</strong><br/><span style="color:#9bb09a">${d.src}</span>`;
}

renderer.domElement.addEventListener("pointerdown", onPointer);

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
  const root = new URL("..", import.meta.url);
  const jobs = manifest.items.map(async (item) => {
    const url = new URL(`../${item.src}`, import.meta.url).href;
    try {
      const tex = await pixelTexture(url);
      addSprite(item, tex);
    } catch (err) {
      console.warn("failed", item.id, url, err);
    }
  });
  await Promise.all(jobs);
  selectedEl.innerHTML = `Loaded <strong>${pickables.length}</strong> sprites · reference main = <strong>${REF}px</strong>`;
  // keep root referenced for debugging paths
  void root;
}

boot();

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
