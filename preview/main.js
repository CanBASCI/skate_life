import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Player, dirFromVector } from "./player.js?v=skateOllieTip";
import {
  loadCatalog,
  groupByCat,
  assetUrl,
  DIRS,
  OBJ_CAT_ORDER,
  OBJ_CAT_LABEL,
} from "./catalog.js";

const REF = 96;
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
const promptEl = document.getElementById("prompt");
const promptTextEl = document.getElementById("prompt-text");
const staminaEl = document.getElementById("stamina");
const staminaFillEl = document.getElementById("stamina-fill");
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
/** @type {THREE.Object3D | null} */
let occupiedVehicle = null;
let nearbyVehicle = null;
/** @type {THREE.Object3D | null} */
let occupiedSkateboard = null;
let nearbySkateboard = null;
/** @type {THREE.Object3D | null} */
let companion = null;
const texCache = new Map(); // url -> Promise<Texture>

/** Max distance from car body edge to show E (world units). */
const VEHICLE_ENTER_PAD = 36;

const FACE_VEC = {
  south: [0, 1],
  north: [0, -1],
  east: [1, 0],
  west: [-1, 0],
  "south-east": [Math.SQRT1_2, Math.SQRT1_2],
  "north-east": [Math.SQRT1_2, -Math.SQRT1_2],
  "south-west": [-Math.SQRT1_2, Math.SQRT1_2],
  "north-west": [-Math.SQRT1_2, -Math.SQRT1_2],
};
const DRIVE_SPEED = 240;
const DRIVE_BOOST = 340;
const COMPANION_PATH = "assets/props/smallAnimals/dog/32x32/default";
const COMPANION_FOLLOW_STOP = 38;
const COMPANION_FOLLOW_START = 52;
const COMPANION_SPEED = 105;

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
  let order = Math.round(obj.position.z * 10 + layerBias);
  // vault/jump: draw player in front of props/cars (sprites ignore depthTest paint order)
  if (
    obj.userData?.controllable &&
    player &&
    (player.busy === "vault" || player.busy === "jump" || player.skating)
  ) {
    order += 90000;
  }
  obj.renderOrder = order;
}

function defaultScale(item) {
  if (item.kind === "object" && item.path.includes("/buildings/")) return BUILDING_SCALE;
  // tuned vs 96px character; E-ride / parked board same scale
  if (isSkateboardPath(item.path)) return 0.7;
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
  const p = item.path || "";
  return /\/props\/road\//i.test(p) || /\/roadTiles\//i.test(p);
}

function isRoadTileItem(item) {
  return !!(item?.tileable || /\/roadTiles\//i.test(item?.path || ""));
}

/** Snap tileable roads so segments meet edge-to-edge. */
function snapRoadPos(x, z, tileSize = 64) {
  const s = tileSize || 64;
  return {
    x: Math.round(x / s) * s,
    z: Math.round(z / s) * s,
  };
}

function isBallPath(path) {
  return /\/props\/balls\//i.test(path || "");
}

function isVehiclePath(path) {
  return /\/vehicles\//i.test(path || "");
}

function isVehicleObj(obj) {
  return !!(obj?.userData?.vehicle || isVehiclePath(obj?.userData?.path));
}

function isSkateboardPath(path) {
  return /\/skateboard\//i.test(path || "");
}

function isSkateboardObj(obj) {
  return !!(obj?.userData?.skateboard || isSkateboardPath(obj?.userData?.path));
}

function nearestSkateboard(px, pz) {
  let best = null;
  let bestD = Infinity;
  for (const obj of pickables) {
    if (!isSkateboardObj(obj)) continue;
    if (obj === occupiedSkateboard) continue;
    if (!obj.visible) continue;
    const d = distToFootprint(px, pz, footprintOf(obj));
    if (d < bestD) {
      bestD = d;
      best = obj;
    }
  }
  return best && bestD <= VEHICLE_ENTER_PAD + 24 ? best : null;
}

/** SpriteMaterial.rotation sign so board nose (travel dir) tips “up” on screen. */
const OLLIE_TIP_ROT = {
  east: 0.38,
  west: -0.38,
  south: -0.22,
  north: 0.22,
  "south-east": 0.28,
  "south-west": -0.28,
  "north-east": 0.28,
  "north-west": -0.28,
};

/** Keep board under feet while riding (skate-idle art has no board drawn in). */
function syncSkateboardUnderPlayer() {
  const board = occupiedSkateboard;
  if (!board || !player?.mesh || !player.skating) return;
  board.visible = true;
  const dir = player.facing || board.userData.dir || "";
  const face = FACE_VEC[dir] || FACE_VEC.south;
  const u = player.ollieU || 0;
  const lift = Math.sin(Math.PI * u);
  // shift board slightly toward nose so the travel-end reads up during ollie
  const nose = lift * 5;
  board.position.x = player.mesh.position.x + face[0] * nose;
  board.position.z = player.mesh.position.z + face[1] * nose;
  // follow hop; nose a touch higher than feet at peak
  board.position.y = (player.mesh.position.y || 0) + 0.05 + lift * 3;
  if (player.facing && board.userData.dir !== player.facing) {
    applyFacing(board, player.facing);
  }
  // east/west deck sits mid-canvas with empty pad below — lift sprite so deck meets feet
  if (board.isSprite) {
    const horiz = dir === "east" || dir === "west";
    board.center.set(0.5, horiz ? -0.07 : -0.02);
  }
  if (board.material) {
    board.material.rotation = lift * (OLLIE_TIP_ROT[dir] || 0);
  }
  syncDepth(board);
  // character always paints above the deck
  board.renderOrder = (player.mesh.renderOrder || 0) - 20;
}

function enterSkateboard(board) {
  if (!player?.mesh || !board || player.skating) return;
  occupiedSkateboard = board;
  nearbySkateboard = null;
  board.userData._solidBeforeSkate = !!board.userData.solid;
  board.userData.solid = false;
  board.visible = true;
  player.mesh.position.x = board.position.x;
  player.mesh.position.z = board.position.z;
  player.ring.position.x = board.position.x;
  player.ring.position.z = board.position.z;
  if (board.userData.dir) player.facing = board.userData.dir;
  player.startSkating();
  syncSkateboardUnderPlayer();
  if (selected === board) selectObject(null);
  hidePrompt();
  statusEl.textContent = "Kaykaydasın";
}

function exitSkateboard() {
  const board = occupiedSkateboard;
  if (!player?.mesh || !board) return;
  const face = FACE_VEC[player.facing] || FACE_VEC.south;
  const side = [-face[1], face[0]];
  // leave board at feet; step player slightly aside so you aren't glued on the deck
  board.position.x = player.mesh.position.x;
  board.position.z = player.mesh.position.z;
  board.position.y = 0;
  if (player.facing) applyFacing(board, player.facing);
  if (board.isSprite) board.center.set(0.5, 0);
  if (board.material) board.material.rotation = 0;
  board.userData.solid = false;
  board.visible = true;
  syncDepth(board);

  occupiedSkateboard = null;
  player.stopSkating();

  const pr = player.radius || 22;
  const tryOffsets = [
    [side[0] * (pr + 14), side[1] * (pr + 14)],
    [-side[0] * (pr + 14), -side[1] * (pr + 14)],
    [face[0] * (pr + 16), face[1] * (pr + 16)],
    [-face[0] * (pr + 16), -face[1] * (pr + 16)],
  ];
  for (const [ox, oz] of tryOffsets) {
    const nx = board.position.x + ox;
    const nz = board.position.z + oz;
    if (!solidBlocked(nx, nz, pr)) {
      player.mesh.position.x = nx;
      player.mesh.position.z = nz;
      player.ring.position.x = nx;
      player.ring.position.z = nz;
      if (player.syncDepth) player.syncDepth(player.mesh);
      break;
    }
  }

  hidePrompt();
  statusEl.textContent = "Hazır";
}

function nearestVehicle(px, pz) {
  let best = null;
  let bestD = Infinity;
  for (const obj of pickables) {
    if (!isVehicleObj(obj)) continue;
    if (obj === occupiedVehicle) continue;
    // distance to car body edge (0 = touching / inside footprint)
    const d = distToFootprint(px, pz, footprintOf(obj));
    if (d < bestD) {
      bestD = d;
      best = obj;
    }
  }
  return best && bestD <= VEHICLE_ENTER_PAD ? best : null;
}

const _promptWorld = new THREE.Vector3();
const _promptNdc = new THREE.Vector3();
const _camUp = new THREE.Vector3();

function hidePrompt() {
  if (promptEl) promptEl.classList.add("hidden");
}

function hideStaminaBar() {
  if (staminaEl) staminaEl.classList.add("hidden");
}

/** Foot-run stamina bar above player (hidden on skate / vehicle / full+idle). */
function updateStaminaBar() {
  if (!staminaEl || !staminaFillEl || !player?.mesh) {
    hideStaminaBar();
    return;
  }
  if (player.skating || player.driving || occupiedVehicle) {
    hideStaminaBar();
    return;
  }
  const max = player.staminaMax || 100;
  const ratio = Math.max(0, Math.min(1, (player.stamina ?? max) / max));
  const show = player.sprinting || ratio < 0.999;
  if (!show) {
    hideStaminaBar();
    return;
  }
  staminaFillEl.style.width = `${ratio * 100}%`;
  // color: yellow → red as empty
  if (ratio > 0.45) staminaFillEl.style.background = "linear-gradient(90deg, #e0a040, #e8d060)";
  else staminaFillEl.style.background = "linear-gradient(90deg, #c04040, #e07050)";

  camera.updateMatrixWorld(true);
  // Sprite is billboarded: head ≈ feet + camera-up * spriteHeight (not world Y mid-body)
  const h = player.mesh.scale?.y || 96;
  const cy = player.mesh.center?.y ?? 0;
  _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  _promptWorld.copy(player.mesh.position).addScaledVector(_camUp, h * (1 - cy) + 10);
  _promptNdc.copy(_promptWorld).project(camera);
  if (Math.abs(_promptNdc.x) > 1.35 || Math.abs(_promptNdc.y) > 1.35) {
    hideStaminaBar();
    return;
  }
  const canvasRect = renderer.domElement.getBoundingClientRect();
  const sx = ((_promptNdc.x + 1) / 2) * canvasRect.width + canvasRect.left;
  const sy = ((-_promptNdc.y + 1) / 2) * canvasRect.height + canvasRect.top - 10;
  staminaEl.style.left = `${sx}px`;
  staminaEl.style.top = `${sy}px`;
  staminaEl.classList.remove("hidden");
}

/**
 * Screen-space E label above the vehicle sprite.
 * position:fixed + z-index 9999 — never under the WebGL canvas.
 */
function showPromptAbove(obj, text) {
  if (!obj || !promptEl) {
    hidePrompt();
    return;
  }
  if (promptTextEl) promptTextEl.textContent = text;
  camera.updateMatrixWorld(true);
  const h = (obj.userData?.h || 48) * (obj.userData?.scale || 1);
  // project a point near the top of the billboard (not feet) so label sits above the car
  _promptWorld.set(obj.position.x, Math.max(24, h * 0.92), obj.position.z);
  _promptNdc.copy(_promptWorld).project(camera);
  const canvasRect = renderer.domElement.getBoundingClientRect();
  let sx = ((_promptNdc.x + 1) / 2) * canvasRect.width + canvasRect.left;
  let sy = ((-_promptNdc.y + 1) / 2) * canvasRect.height + canvasRect.top - 12;
  // keep fully on screen so it can't vanish above/below the viewport
  sx = Math.min(Math.max(sx, canvasRect.left + 28), canvasRect.right - 28);
  sy = Math.min(Math.max(sy, canvasRect.top + 48), canvasRect.bottom - 48);
  promptEl.style.left = `${sx}px`;
  promptEl.style.top = `${sy}px`;
  promptEl.classList.remove("hidden");
}

function enterVehicle(veh) {
  if (!player?.mesh || !veh) return;
  occupiedVehicle = veh;
  nearbyVehicle = null;
  player.driving = true;
  player.setVisible(false);
  if (companion) companion.visible = false;
  veh.userData._solidBeforeDrive = !!veh.userData.solid;
  veh.userData.solid = false;
  veh.userData.occupied = true;
  if (selected === veh) selectObject(null);
  hidePrompt();
  statusEl.textContent = "Araçtasın";
}

function exitVehicle() {
  const veh = occupiedVehicle;
  if (!player?.mesh || !veh) return;

  // Place outside the vehicle footprint — old fixed 48px landed inside big car AABBs.
  const box = footprintOf(veh);
  const pr = player.radius || 22;
  const clearance = Math.max(box.hw, box.hd) + pr + 28;
  const face = veh.userData.dir || "south";
  const sideFirst = {
    east: [0, 1],
    west: [0, -1],
    north: [1, 0],
    south: [-1, 0],
    "north-east": [Math.SQRT1_2, Math.SQRT1_2],
    "north-west": [-Math.SQRT1_2, Math.SQRT1_2],
    "south-east": [Math.SQRT1_2, -Math.SQRT1_2],
    "south-west": [-Math.SQRT1_2, -Math.SQRT1_2],
  }[face] || [1, 0];
  const tryDirs = [
    sideFirst,
    [-sideFirst[0], -sideFirst[1]],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, -Math.SQRT1_2],
  ];

  let spot = null;
  for (const [dx, dz] of tryDirs) {
    for (const mul of [1, 1.35, 1.75, 2.3, 3]) {
      const x = veh.position.x + dx * clearance * mul;
      const z = veh.position.z + dz * clearance * mul;
      // still ignore veh.solid (it's false while driving) — test footprint manually
      if (circleHitsAabb(x, z, pr, box)) continue;
      if (solidBlocked(x, z, pr)) continue;
      spot = { x, z };
      break;
    }
    if (spot) break;
  }
  if (!spot) {
    spot = {
      x: veh.position.x + clearance * 3,
      z: veh.position.z + clearance * 3,
    };
  }

  player.mesh.position.set(spot.x, 0, spot.z);
  player.ring.position.x = spot.x;
  player.ring.position.z = spot.z;
  player.driving = false;
  player.setVisible(true);
  if (companion) {
    companion.visible = true;
    companion.position.set(
      spot.x - 28,
      0,
      spot.z - 28,
    );
    syncDepth(companion);
  }
  veh.userData.solid = veh.userData._solidBeforeDrive !== false;
  veh.userData.occupied = false;
  occupiedVehicle = null;
  hidePrompt();
  statusEl.textContent = "Hazır";
  if (player.syncDepth) player.syncDepth(player.mesh);
}

function driveVehicle(dt) {
  const veh = occupiedVehicle;
  if (!veh || !player) return;
  const { dx, dz } = player.inputVector();
  const moving = dx !== 0 || dz !== 0;
  const boost = player.keys.has("ShiftLeft") || player.keys.has("ShiftRight");
  const speed = boost ? DRIVE_BOOST : DRIVE_SPEED;
  if (moving) {
    const facing = dirFromVector(dx, dz);
    if (facing && facing !== veh.userData.dir) {
      applyFacing(veh, facing);
    }
    const x0 = veh.position.x;
    const z0 = veh.position.z;
    const nx = x0 + dx * speed * dt;
    const nz = z0 + dz * speed * dt;
    // vehicle footprint radius for driving collision
    const box = footprintOf(veh);
    const r = Math.max(box.hw, box.hd) * 0.55;
    if (!solidBlocked(nx, z0, r)) veh.position.x = nx;
    if (!solidBlocked(veh.position.x, nz, r)) veh.position.z = nz;
    player.vx = veh.position.x - x0;
    player.vz = veh.position.z - z0;
  } else {
    player.vx = 0;
    player.vz = 0;
  }
  // keep hidden player transform on vehicle for camera follow
  player.mesh.position.x = veh.position.x;
  player.mesh.position.z = veh.position.z;
  syncDepth(veh);
}

/** Buildings / vehicles / props / interiors block; roads, animals, balls, skateboards don't. */
function isSolidItem(item) {
  if (!item || item.kind === "character") return false;
  const p = item.path || "";
  if (usesGroundPlane(item) || /\/props\/road\//i.test(p)) return false;
  if (isAnimalPath(p)) return false;
  if (isBallPath(p)) return false;
  if (isSkateboardPath(p)) return false; // walk/stand on board — never trap on dismount
  return item.kind === "object";
}

/** Small cars only — no boats, buses, ambulance, ferry. */
function isVaultableCarPath(path) {
  const p = path || "";
  if (!/\/vehicles\//i.test(p)) return false;
  if (/boat|ferry|bus|ambulance|amblance|school/i.test(p)) return false;
  // car / car_2… / jeep / pickup / police
  return /\/vehicles\/(car|jeep|pickup|police)/i.test(p);
}

/** Low props + vaultable cars (bench/bank, table, park bits). */
function isVaultablePath(path) {
  const p = path || "";
  if (isVaultableCarPath(p)) return true;
  if (/\/buildings\//i.test(p) || /\/vehicles\//i.test(p) || /\/interiors\//i.test(p)) {
    return false;
  }
  if (/\/props\/road|roadTiles|\/balls\/|smallAnimals/i.test(p)) return false;
  if (/outdoorpark|outdoorPark|\/bench|\/table/i.test(p)) return true;
  return (
    /\/props\//i.test(p) &&
    /bench|table|fence|bin|trash|crate|barrier|bollard|planter|pot|stump|rock|log|light/i.test(p)
  );
}

function isVaultableObj(obj) {
  const d = obj?.userData;
  if (!d?.solid || d.ball || d.occupied) return false;
  // occupied vehicle / driving target: no vault
  if (d.vaultable) return true;
  return isVaultablePath(d.path);
}

function solidBlockedExcept(px, pz, radius, except) {
  for (const obj of pickables) {
    if (obj === except) continue;
    if (!obj.userData?.solid) continue;
    if (circleHitsAabb(px, pz, radius, footprintOf(obj))) return true;
  }
  return false;
}

/** Vaultable obstacle ahead of player → landing on the far side. */
function findVaultForPlayer() {
  if (!player?.mesh || player.driving) return null;
  const face = FACE_VEC[player.facing] || FACE_VEC.south;
  const fx = face[0];
  const fz = face[1];
  const px = player.mesh.position.x;
  const pz = player.mesh.position.z;
  const pr = player.radius || 22;
  let best = null;
  let bestScore = Infinity;
  for (const obj of pickables) {
    if (!isVaultableObj(obj)) continue;
    const box = footprintOf(obj);
    const d = distToFootprint(px, pz, box);
    if (d > 48) continue;
    const ox = box.x - px;
    const oz = box.z - pz;
    const forward = ox * fx + oz * fz;
    if (forward < -8) continue; // mostly behind
    const side = Math.abs(ox * -fz + oz * fx);
    const extent = Math.max(box.hw || 0, box.hd || 0) + 8;
    if (side > extent + 28) continue; // too far beside
    const score = d + Math.max(0, -forward) * 0.5 + side * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = obj;
    }
  }
  if (!best) return null;
  const box = footprintOf(best);
  const clear = Math.max(box.hw || 20, box.hd || 20) + pr + 18;
  const landX = box.x + fx * clear;
  const landZ = box.z + fz * clear;
  if (solidBlockedExcept(landX, landZ, pr, best)) {
    // try a bit further
    const landX2 = box.x + fx * clear * 1.35;
    const landZ2 = box.z + fz * clear * 1.35;
    if (solidBlockedExcept(landX2, landZ2, pr, best)) return null;
    return { landX: landX2, landZ: landZ2, ignore: best };
  }
  return { landX, landZ, ignore: best };
}

/** Opaque pixel bbox of a texture image (cached). Image y=0 is top. */
const alphaBoundsCache = new WeakMap();

function getAlphaBounds(image) {
  if (!image?.width) return null;
  if (alphaBoundsCache.has(image)) return alphaBoundsCache.get(image);
  const w = image.width;
  const h = image.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  const step = w * h > 20000 ? 2 : 1;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (data[(y * w + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bounds =
    maxX < 0
      ? { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1, w, h }
      : { minX, minY, maxX, maxY, w, h };
  alphaBoundsCache.set(image, bounds);
  return bounds;
}

/** Scan all 8 (or available) rotation textures → per-dir opaque bounds. */
function buildAlphaBoundsByDir(rotTextures) {
  const out = {};
  if (!rotTextures) return out;
  for (const dir of DIRS) {
    const tex = rotTextures[dir];
    if (!tex?.image) continue;
    try {
      out[dir] = getAlphaBounds(tex.image);
    } catch {
      /* skip */
    }
  }
  // also keep any non-compass keys (e.g. unknown)
  for (const [dir, tex] of Object.entries(rotTextures)) {
    if (out[dir] || !tex?.image) continue;
    try {
      out[dir] = getAlphaBounds(tex.image);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Per-dir OBB: long axis follows facing — including diagonals (NE/NW/SE/SW),
 * not just axis-aligned X/Z boxes. Size comes from that dir's opaque sprite.
 */
function vehicleFootprintFromBounds(obj, b, dir) {
  const sc = obj.userData.scale || 1;
  const face = FACE_VEC[dir] || FACE_VEC.south;
  const fx = face[0];
  const fz = face[1];
  const ax = Math.abs(fx);
  const az = Math.abs(fz);
  const ow = Math.max(8, (b.maxX - b.minX + 1) * sc);
  const oh = Math.max(8, (b.maxY - b.minY + 1) * sc);
  const GROUND_K = 0.55;
  // NS → image height is length; EW → image width; çapraz → ikisinin karışımı
  const den = ax + az || 1;
  const along = (az * oh * GROUND_K + ax * ow * 0.88) / den;
  const side = (az * ow * 0.88 + ax * oh * GROUND_K) / den;
  const halfLen = Math.max(12, along * 0.48);
  const halfWid = Math.max(10, side * 0.46);
  // mild rear bias (feet ≈ front); stronger for N/S where body rises in sprite
  const rearShift = along * (0.1 + 0.16 * az);
  return {
    kind: "obb",
    x: obj.position.x - fx * rearShift,
    z: obj.position.z - fz * rearShift,
    fx,
    fz,
    px: -fz,
    pz: fx,
    halfLen,
    halfWid,
    hw: halfWid,
    hd: halfLen,
  };
}

function footprintOf(obj) {
  const d = obj.userData || {};
  const w = (d.w || 32) * (d.scale || 1);
  const h = (d.h || 32) * (d.scale || 1);
  const p = d.path || "";
  if (/\/vehicles\//i.test(p) || d.vehicle) {
    const dir = d.dir || "south";
    const b = d.alphaBoundsByDir?.[dir] || d.alphaBounds;
    if (b && b.w > 0 && b.h > 0) {
      return vehicleFootprintFromBounds(obj, b, dir);
    }
    const face = FACE_VEC[dir] || FACE_VEC.south;
    const halfLen = w * 0.32;
    const halfWid = w * 0.24;
    const rearShift = w * 0.12;
    return {
      kind: "obb",
      x: obj.position.x - face[0] * rearShift,
      z: obj.position.z - face[1] * rearShift,
      fx: face[0],
      fz: face[1],
      px: -face[1],
      pz: face[0],
      halfLen,
      halfWid,
      hw: halfWid,
      hd: halfLen,
    };
  }
  let hw;
  let hd;
  if (/\/buildings\//i.test(p)) {
    hw = w * 0.32;
    hd = w * 0.22;
  } else if (/\/interiors\//i.test(p)) {
    hw = w * 0.42;
    hd = h * 0.36;
  } else {
    hw = w * 0.28;
    hd = Math.max(w * 0.2, h * 0.18);
  }
  return { kind: "aabb", x: obj.position.x, z: obj.position.z, hw, hd };
}

function circleHitsAabb(px, pz, radius, box) {
  if (box.kind === "obb") {
    const dx = px - box.x;
    const dz = pz - box.z;
    const localF = dx * box.fx + dz * box.fz;
    const localS = dx * box.px + dz * box.pz;
    const cx = Math.max(-box.halfLen, Math.min(localF, box.halfLen));
    const cz = Math.max(-box.halfWid, Math.min(localS, box.halfWid));
    const ex = localF - cx;
    const ez = localS - cz;
    return ex * ex + ez * ez < radius * radius;
  }
  const cx = Math.max(box.x - box.hw, Math.min(px, box.x + box.hw));
  const cz = Math.max(box.z - box.hd, Math.min(pz, box.z + box.hd));
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz < radius * radius;
}

/** Distance from point to footprint surface (0 if inside). */
function distToFootprint(px, pz, box) {
  if (box.kind === "obb") {
    const dx = px - box.x;
    const dz = pz - box.z;
    const localF = dx * box.fx + dz * box.fz;
    const localS = dx * box.px + dz * box.pz;
    const ox = Math.max(Math.abs(localF) - box.halfLen, 0);
    const oz = Math.max(Math.abs(localS) - box.halfWid, 0);
    return Math.hypot(ox, oz);
  }
  const ox = Math.max(Math.abs(px - box.x) - box.hw, 0);
  const oz = Math.max(Math.abs(pz - box.z) - box.hd, 0);
  return Math.hypot(ox, oz);
}

function solidBlocked(px, pz, radius) {
  for (const obj of pickables) {
    if (!obj.userData?.solid) continue;
    if (circleHitsAabb(px, pz, radius, footprintOf(obj))) return true;
  }
  return false;
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

async function resolveWalkSlug(path) {
  const listed = await listAnimSlugs(path);
  const hit =
    listed.find((a) => /^walk$/i.test(a)) ||
    listed.find((a) => /walk/i.test(a) && !/idle/i.test(a));
  return hit || null;
}

/** Load idle+walk clips for all dirs (companion pet). */
async function attachPetClips(obj, path) {
  const idleSlug = (await resolveIdleSlug(path)) || "dog_idle";
  const walkSlug = (await resolveWalkSlug(path)) || "walk";
  const dirs = obj.userData.dirs?.length ? obj.userData.dirs : DIRS;
  const clips = { idle: {}, walk: {} };
  await Promise.all(
    dirs.map(async (dir) => {
      clips.idle[dir] = await loadAnimFrames(path, idleSlug, dir);
      clips.walk[dir] = await loadAnimFrames(path, walkSlug, dir);
      if (!clips.idle[dir].length) {
        clips.idle[dir] = await loadAnimFrames(path, idleSlug, "south");
      }
      if (!clips.walk[dir].length) {
        clips.walk[dir] = clips.idle[dir];
      }
    }),
  );
  obj.userData.idleSlug = idleSlug;
  obj.userData.walkSlug = walkSlug;
  obj.userData.clips = clips;
  obj.userData.animName = "idle";
  const dir = obj.userData.dir || "south";
  const frames = clips.idle[dir] || clips.idle.south || [];
  if (!frames.length) return false;
  obj.userData.anim = { frames, frame: 0, accum: 0, fps: 3.5, dir };
  setMap(obj, frames[0]);
  return true;
}

function setPetClip(obj, animName, dir) {
  const clips = obj.userData.clips;
  if (!clips) return;
  const bucket = clips[animName] || clips.idle;
  let frames = bucket?.[dir] || bucket?.south || clips.idle?.south;
  if (!frames?.length) return;
  const same =
    obj.userData.animName === animName &&
    obj.userData.anim?.dir === dir &&
    obj.userData.anim?.frames === frames;
  if (same) return;
  obj.userData.animName = animName;
  obj.userData.dir = dir;
  obj.userData.anim = {
    frames,
    frame: 0,
    accum: 0,
    fps: animName === "walk" ? 9 : 3.5,
    dir,
  };
  setMap(obj, frames[0]);
}

async function spawnCompanion() {
  if (!player?.mesh) return;
  if (companion) {
    // toggle off
    scene.remove(companion);
    const i = pickables.indexOf(companion);
    if (i >= 0) pickables.splice(i, 1);
    if (selected === companion) selectObject(null);
    companion = null;
    statusEl.textContent = "Pet gitti";
    return;
  }
  const facing = player.facing || "south";
  const behind = {
    south: [0, -1],
    north: [0, 1],
    east: [-1, 0],
    west: [1, 0],
    "south-east": [-Math.SQRT1_2, -Math.SQRT1_2],
    "south-west": [Math.SQRT1_2, -Math.SQRT1_2],
    "north-east": [-Math.SQRT1_2, Math.SQRT1_2],
    "north-west": [Math.SQRT1_2, Math.SQRT1_2],
  }[facing] || [0, -1];
  const x = player.mesh.position.x + behind[0] * 42;
  const z = player.mesh.position.z + behind[1] * 42;
  statusEl.textContent = "Pet geliyor…";
  const item = {
    kind: "object",
    id: "companion-dog",
    label: "pet dog",
    path: COMPANION_PATH,
    thumbs: [
      assetUrl(`${COMPANION_PATH}/south.png`),
      assetUrl(`${COMPANION_PATH}/rotations/south.png`),
    ],
  };
  const obj = await spawnItem(item, x, z);
  obj.userData.companion = true;
  obj.userData.solid = false;
  await attachPetClips(obj, COMPANION_PATH);
  companion = obj;
  statusEl.textContent = "Pet yanında";
}

function tickCompanions(dt) {
  if (!companion || !player?.mesh) return;
  if (!pickables.includes(companion)) {
    companion = null;
    return;
  }
  // Hide with player while driving — don't keep walking beside the car
  if (occupiedVehicle) {
    companion.visible = false;
    return;
  }
  if (!companion.visible) companion.visible = true;
  const follow = player.mesh;
  const px = follow.position.x;
  const pz = follow.position.z;
  // stay slightly behind the leader's facing
  const face = occupiedVehicle
    ? occupiedVehicle.userData.dir || "south"
    : player.facing || "south";
  const behind = {
    south: [0, -1],
    north: [0, 1],
    east: [-1, 0],
    west: [1, 0],
    "south-east": [-Math.SQRT1_2, -Math.SQRT1_2],
    "south-west": [Math.SQRT1_2, -Math.SQRT1_2],
    "north-east": [-Math.SQRT1_2, Math.SQRT1_2],
    "north-west": [Math.SQRT1_2, Math.SQRT1_2],
  }[face] || [0, -1];
  const tx = px + behind[0] * 40;
  const tz = pz + behind[1] * 40;
  const dx = tx - companion.position.x;
  const dz = tz - companion.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > COMPANION_FOLLOW_START) {
    const nx = dx / dist;
    const nz = dz / dist;
    const step = Math.min(dist - COMPANION_FOLLOW_STOP, COMPANION_SPEED * dt);
    companion.position.x += nx * step;
    companion.position.z += nz * step;
    const facing = dirFromVector(nx, nz) || companion.userData.dir || "south";
    setPetClip(companion, "walk", facing);
  } else if (dist > COMPANION_FOLLOW_STOP) {
    const nx = dx / dist;
    const nz = dz / dist;
    companion.position.x += nx * COMPANION_SPEED * 0.45 * dt;
    companion.position.z += nz * COMPANION_SPEED * 0.45 * dt;
    const facing = dirFromVector(nx, nz) || companion.userData.dir || "south";
    setPetClip(companion, "walk", facing);
  } else {
    setPetClip(companion, "idle", companion.userData.dir || face);
  }
  syncDepth(companion);
}

function rotationUrl(path, dir) {
  return assetUrl(`${path.replace(/\/$/, "")}/rotations/${dir}.png`);
}

/** rotations/dir.png or flat dir.png (skateboard 68x68/base layout). */
function rotationUrlCandidates(path, dir) {
  const base = path.replace(/\/$/, "");
  return [
    assetUrl(`${base}/rotations/${dir}.png`),
    assetUrl(`${base}/${dir}.png`),
  ];
}

function imageExists(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

async function firstExistingUrl(urls) {
  for (const url of urls) {
    if (await imageExists(url)) return url;
  }
  return null;
}

async function probeDirs(path) {
  const available = [];
  await Promise.all(
    DIRS.map(async (dir) => {
      if (await firstExistingUrl(rotationUrlCandidates(path, dir))) available.push(dir);
    }),
  );
  if (!available.length) {
    for (const name of ["unknown", "south"]) {
      if (await firstExistingUrl(rotationUrlCandidates(path, name))) {
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

/** Prefetch all 8 (or available) rotation textures so facing is instant. */
async function loadRotationTextures(path, dirs) {
  const map = {};
  await Promise.all(
    dirs.map(async (dir) => {
      try {
        const url = await firstExistingUrl(rotationUrlCandidates(path, dir));
        if (url) map[dir] = await pixelTexture(url);
      } catch {
        /* missing dir */
      }
    }),
  );
  if (!map.south) {
    try {
      map.south = (await loadAnyTexture(rotationUrlCandidates(path, "south"))).tex;
    } catch {
      /* */
    }
  }
  return map;
}

function applyFacing(obj, dir) {
  const d = obj.userData;
  if (!dir) return false;
  const cached = d.rotTextures?.[dir];
  if (cached) {
    d.dir = dir;
    setMap(obj, cached);
    return true;
  }
  if (d.dirs?.includes(dir)) {
    // kick async load; still mark desired dir
    d.dir = dir;
    setDirection(obj, dir);
    return true;
  }
  return false;
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
  if (obj.userData.vehicle || isVehiclePath(obj.userData.path)) {
    try {
      const dir = obj.userData.dir || "south";
      const byDir = obj.userData.alphaBoundsByDir || {};
      // prefer precomputed for this exact dir (all 8); refresh if missing
      const b = byDir[dir] || getAlphaBounds(tex.image);
      byDir[dir] = b;
      obj.userData.alphaBoundsByDir = byDir;
      obj.userData.alphaBounds = b;
    } catch (err) {
      console.warn("alphaBounds", err);
    }
  }
  applyScale(obj);
}

async function setDirection(obj, dir) {
  const d = obj.userData;
  if (!d.dirs?.includes(dir) && !d.rotTextures?.[dir]) return;
  d.dir = dir;
  // Characters / pets with idle clips keep anim path
  if ((d.idleSlug || d.anim) && !d.vehicle && !d.rotTextures?.[dir]) {
    const ok = await attachIdle(obj, d.path, dir);
    if (ok) {
      refreshInspector();
      return;
    }
  }
  if (d.rotTextures?.[dir]) {
    setMap(obj, d.rotTextures[dir]);
    refreshInspector();
    return;
  }
  if (dir === "south" && d.fallbackSouth) {
    try {
      const { tex } = await loadAnyTexture(rotationUrlCandidates(d.path, "south"));
      d.rotTextures = d.rotTextures || {};
      d.rotTextures.south = tex;
      setMap(obj, tex);
      refreshInspector();
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    const url = await firstExistingUrl(rotationUrlCandidates(d.path, dir));
    if (!url) throw new Error("no rotation url");
    const tex = await pixelTexture(url);
    d.rotTextures = d.rotTextures || {};
    d.rotTextures[dir] = tex;
    if (!d.dirs.includes(dir)) d.dirs.push(dir);
    setMap(obj, tex);
    refreshInspector();
  } catch (err) {
    console.warn("dir failed", dir, err);
  }
}

async function spawnItem(item, x, z) {
  const { tex } = await loadAnyTexture(item.thumbs);
  let dirs = await probeDirs(item.path);
  // Vehicles/buildings/skateboard: always try full 8-dir atlas
  const wantFull =
    isVehiclePath(item.path) ||
    /\/buildings\//i.test(item.path || "") ||
    /\/skateboard\//i.test(item.path || "");
  const rotTextures = await loadRotationTextures(
    item.path,
    wantFull ? DIRS : dirs.length ? dirs : DIRS,
  );
  const fromTex = DIRS.filter((d) => rotTextures[d]);
  if (fromTex.length) dirs = fromTex;
  else if (rotTextures.unknown) dirs = ["unknown"];
  const scale = defaultScale(item);
  const w = tex.image.width;
  const h = tex.image.height;
  const tileable = isRoadTileItem(item);
  const tileSize = (item.tileSize || w || 64) * scale;
  if (tileable) {
    const sn = snapRoadPos(x, z, tileSize);
    x = sn.x;
    z = sn.z;
  }
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
    rotTextures,
    fallbackSouth: true,
    editable: true,
    solid: isSolidItem(item),
    ball: isBallPath(item.path),
    vehicle: isVehiclePath(item.path),
    skateboard: isSkateboardPath(item.path),
    vaultable: isVaultablePath(item.path),
    tileable,
    tileSize,
  };
  if (userData.vehicle) {
    // all 8 facings (DIRS) scanned up front — collision switches with dir
    userData.alphaBoundsByDir = buildAlphaBoundsByDir(rotTextures);
    userData.alphaBounds = userData.alphaBoundsByDir[dir] || null;
    const n = Object.keys(userData.alphaBoundsByDir).length;
    if (n < 8) {
      console.warn(`vehicle ${item.path}: alpha bounds for ${n}/8 dirs`, Object.keys(userData.alphaBoundsByDir));
    }
  }
  if (userData.ball) {
    const br = Math.max(10, ((w * scale) / 2) * 0.55);
    userData.physics = { vx: 0, vz: 0, r: br };
  }

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
  // Prefer cached rotation for initial facing
  if (rotTextures[dir]) setMap(obj, rotTextures[dir]);
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
  if (selected === companion) companion = null;
  if (selected === occupiedVehicle) return;
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
  if (occupiedVehicle) return;
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  raycaster.camera = camera;
  const hits = opaqueHits(raycaster.intersectObjects(pickables, false));
  if (!hits.length) {
    selectObject(null);
    return;
  }
  const obj = hits[0].object;
  if (!obj.userData.editable || obj.userData.occupied) {
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
  let nx = gp.x + dragOffset.x;
  let nz = gp.z + dragOffset.z;
  if (dragging.userData?.tileable) {
    const sn = snapRoadPos(nx, nz, dragging.userData.tileSize || 64);
    nx = sn.x;
    nz = sn.z;
  }
  dragging.position.x = nx;
  dragging.position.z = nz;
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
        let x = gp.x;
        let z = gp.z;
        if (isRoadTileItem(item)) {
          const sn = snapRoadPos(x, z, (item.tileSize || 64) * defaultScale(item));
          x = sn.x;
          z = sn.z;
        }
        await spawnItem(item, x, z);
        statusEl.textContent = "Hazır";
      } catch (err) {
        console.warn(err);
        statusEl.textContent = "Yüklenemedi";
      }
    }
    return;
  }
  if (!dragging) return;
  if (dragging.userData?.tileable) {
    const sn = snapRoadPos(
      dragging.position.x,
      dragging.position.z,
      dragging.userData.tileSize || 64,
    );
    dragging.position.x = sn.x;
    dragging.position.z = sn.z;
    syncDepth(dragging);
  }
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
  if (e.target.matches?.("input, textarea")) return;

  // P: spawn / dismiss companion pet
  if ((e.key === "p" || e.key === "P") && !e.repeat) {
    e.preventDefault();
    spawnCompanion();
    return;
  }

  // E: skateboard / vehicle enter-exit (priority over rotate)
  if ((e.key === "e" || e.key === "E") && !e.repeat) {
    if (player?.skating && occupiedSkateboard) {
      e.preventDefault();
      exitSkateboard();
      return;
    }
    if (occupiedVehicle) {
      e.preventDefault();
      exitVehicle();
      return;
    }
    if (nearbySkateboard) {
      e.preventDefault();
      enterSkateboard(nearbySkateboard);
      return;
    }
    if (nearbyVehicle) {
      e.preventDefault();
      enterVehicle(nearbyVehicle);
      return;
    }
  }

  if (!selected || !selected.userData.editable) return;
  if (occupiedVehicle || player?.skating) return;
  // clockwise compass so Q/E steps N→NE→E→… (not jumping to odd diagonals)
  const TURN_DIRS = [
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west",
  ];
  const available = selected.userData.dirs?.length ? selected.userData.dirs : DIRS;
  const dirs = TURN_DIRS.filter((d) => available.includes(d));
  if (!dirs.length) return;
  let idx = dirs.indexOf(selected.userData.dir);
  if (idx < 0) idx = 0;
  if (e.key === "q" || e.key === "Q") {
    idx = (idx - 1 + dirs.length) % dirs.length;
    setDirection(selected, dirs[idx]);
  } else if (
    (e.key === "e" || e.key === "E") &&
    !nearbyVehicle &&
    !nearbySkateboard
  ) {
    // rotate selection only when not in ride enter range
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
  player = await new Player(scene, {
    x: 0,
    z: 200,
    syncDepth,
    collides: solidBlocked,
    findVault: findVaultForPlayer,
    radius: 22,
  }).load();
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

const BALL_FRICTION = 2.8;
const BALL_BOUNCE = 0.55;
const BALL_KICK = 9.5;
const BALL_MAX_SPEED = 420;

function resolveBallVsSolid(ball, phy) {
  for (const obj of pickables) {
    if (!obj.userData?.solid) continue;
    const box = footprintOf(obj);
    if (!circleHitsAabb(ball.position.x, ball.position.z, phy.r, box)) continue;
    // push out of AABB + bounce velocity on dominant axis
    const dx = ball.position.x - box.x;
    const dz = ball.position.z - box.z;
    const px = box.hw + phy.r - Math.abs(dx);
    const pz = box.hd + phy.r - Math.abs(dz);
    if (px < pz) {
      ball.position.x += Math.sign(dx || 1) * px;
      phy.vx *= -BALL_BOUNCE;
    } else {
      ball.position.z += Math.sign(dz || 1) * pz;
      phy.vz *= -BALL_BOUNCE;
    }
  }
}

function kickBallsFromPlayer() {
  if (!player?.mesh) return;
  const px = player.mesh.position.x;
  const pz = player.mesh.position.z;
  const pr = player.radius || 22;
  for (const ball of pickables) {
    const phy = ball.userData?.physics;
    if (!ball.userData?.ball || !phy) continue;
    const dx = ball.position.x - px;
    const dz = ball.position.z - pz;
    const dist = Math.hypot(dx, dz) || 0.0001;
    const minDist = pr + phy.r;
    if (dist >= minDist) continue;
    // separate so we don't stick inside the player
    const push = (minDist - dist) / dist;
    ball.position.x += dx * push;
    ball.position.z += dz * push;
    const nx = dx / dist;
    const nz = dz / dist;
    const move = Math.hypot(player.vx || 0, player.vz || 0);
    const impulse = BALL_KICK * (0.35 + move * 18);
    phy.vx += nx * impulse + (player.vx || 0) * 28;
    phy.vz += nz * impulse + (player.vz || 0) * 28;
  }
}

function tickBallPhysics(dt) {
  kickBallsFromPlayer();
  const damp = Math.exp(-BALL_FRICTION * dt);
  for (const ball of pickables) {
    const phy = ball.userData?.physics;
    if (!ball.userData?.ball || !phy) continue;
    let sp = Math.hypot(phy.vx, phy.vz);
    if (sp > BALL_MAX_SPEED) {
      phy.vx = (phy.vx / sp) * BALL_MAX_SPEED;
      phy.vz = (phy.vz / sp) * BALL_MAX_SPEED;
      sp = BALL_MAX_SPEED;
    }
    ball.position.x += phy.vx * dt;
    ball.position.z += phy.vz * dt;
    phy.vx *= damp;
    phy.vz *= damp;
    if (Math.abs(phy.vx) < 1 && Math.abs(phy.vz) < 1) {
      phy.vx = 0;
      phy.vz = 0;
    }
    resolveBallVsSolid(ball, phy);
    // ball ↔ ball
    for (const other of pickables) {
      if (other === ball || !other.userData?.ball) continue;
      const op = other.userData.physics;
      if (!op) continue;
      const dx = ball.position.x - other.position.x;
      const dz = ball.position.z - other.position.z;
      const dist = Math.hypot(dx, dz) || 0.0001;
      const min = phy.r + op.r;
      if (dist >= min) continue;
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = (min - dist) * 0.5;
      ball.position.x += nx * overlap;
      ball.position.z += nz * overlap;
      other.position.x -= nx * overlap;
      other.position.z -= nz * overlap;
      const dvx = phy.vx - op.vx;
      const dvz = phy.vz - op.vz;
      const impact = dvx * nx + dvz * nz;
      if (impact > 0) continue;
      const j = impact * 0.9;
      phy.vx -= j * nx;
      phy.vz -= j * nz;
      op.vx += j * nx;
      op.vz += j * nz;
      syncDepth(other);
    }
    // light spin: cycle facing with speed (fire-and-forget)
    if (sp > 40 && ball.userData.dirs?.length > 1 && !ball.userData._spinBusy) {
      ball.userData._spinAcc = (ball.userData._spinAcc || 0) + sp * dt * 0.015;
      if (ball.userData._spinAcc >= 1) {
        ball.userData._spinAcc = 0;
        const dirs = ball.userData.dirs;
        let i = dirs.indexOf(ball.userData.dir);
        if (i < 0) i = 0;
        const next = dirs[(i + 1) % dirs.length];
        if (next !== ball.userData.dir) {
          ball.userData._spinBusy = true;
          setDirection(ball, next).finally(() => {
            ball.userData._spinBusy = false;
          });
        }
      }
    }
    syncDepth(ball);
  }
}

function updateVehiclePrompt() {
  if (!player?.mesh) return;
  if (occupiedVehicle) {
    nearbyVehicle = null;
    nearbySkateboard = null;
    hidePrompt();
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "Araçtasın";
    return;
  }
  if (player.skating && occupiedSkateboard) {
    nearbyVehicle = null;
    nearbySkateboard = null;
    hidePrompt();
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "Kaykaydasın";
    return;
  }
  const p = player.mesh.position;
  nearbySkateboard = nearestSkateboard(p.x, p.z);
  nearbyVehicle = nearestVehicle(p.x, p.z);
  // prefer skateboard if both in range
  if (nearbySkateboard) {
    showPromptAbove(nearbySkateboard, "Bin");
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "E · Kaykaya bin";
  } else if (nearbyVehicle) {
    showPromptAbove(nearbyVehicle, "Bin");
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "E · Bin";
  } else {
    hidePrompt();
    if (statusEl && !statusEl.dataset.busy && statusEl.textContent.startsWith("E ·")) {
      statusEl.textContent = "Hazır";
    }
  }
}

function tick(now) {
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  tickAnims(dt);
  if (player) {
    if (occupiedVehicle) driveVehicle(dt);
    else player.update(dt);
    if (player.skating) syncSkateboardUnderPlayer();
    tickCompanions(dt);
    tickBallPhysics(dt);
    if (!dragging && !placing) {
      const p = occupiedVehicle ? occupiedVehicle.position : player.mesh.position;
      const t = 1 - Math.pow(0.0008, dt);
      controls.target.x += (p.x - controls.target.x) * t;
      controls.target.z += (p.z - controls.target.z) * t;
      camera.position.x = controls.target.x + CAM_OFFSET.x;
      camera.position.y = controls.target.y + CAM_OFFSET.y;
      camera.position.z = controls.target.z + CAM_OFFSET.z;
    }
  }
  controls.update();
  updateVehiclePrompt();
  updateStaminaBar();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
