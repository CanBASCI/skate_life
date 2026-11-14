import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Player, dirFromVector, FEET_NUDGE_Z } from "./player.js?v=tdLock";
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
const hudEl = document.getElementById("hud");
const promptEl = document.getElementById("prompt");
const promptKeyEl = document.getElementById("prompt-key");
const promptTextEl = document.getElementById("prompt-text");
const staminaEl = document.getElementById("stamina");
const staminaFillEl = document.getElementById("stamina-fill");
const stageEl = document.getElementById("stage");
const app = document.getElementById("app");
const inspector = document.getElementById("inspector");
const viewportToggle = document.getElementById("viewport-toggle");
const bgToggle = document.getElementById("bg-toggle");
const colToggle = document.getElementById("col-toggle");
const VP_STORAGE_KEY = "skate_life_viewport";
const BG_STORAGE_KEY = "skate_life_bg";
const COL_DEBUG_KEY = "skate_life_col_debug";
const UI_CHROME_KEY = "skate_life_ui_chrome_hidden";
const SCENE_STORAGE_KEY = "skate_life_scene_v1";
const layoutEl = document.getElementById("layout");
const uiToggleBtn = document.getElementById("ui-toggle");
const uiRestartBtn = document.getElementById("ui-restart");
// Default: menus + WASD HUD hidden; only show if user previously chose "Menü".
let uiChromeHidden = localStorage.getItem(UI_CHROME_KEY) !== "0";
/**
 * Session cast only — travels between scenes while the tab is open.
 * Cleared on hard refresh / Yeniden Başla (never restored from localStorage).
 * @type {{ path: string, id?: string|null, scale?: number, dir?: string }[]}
 */
let persistentParty = [];
/** After first scene load, live cast snapshots update party on switch. */
let partySnapshotEnabled = false;
let sessionRestarting = false;

function applyUiChromeHidden(hidden) {
  uiChromeHidden = !!hidden;
  layoutEl?.classList.toggle("ui-chrome-hidden", uiChromeHidden);
  if (uiToggleBtn) {
    uiToggleBtn.setAttribute("aria-pressed", uiChromeHidden ? "true" : "false");
    uiToggleBtn.textContent = uiChromeHidden ? "Menü" : "Gizle";
    uiToggleBtn.title = uiChromeHidden
      ? "Menüleri ve WASD bilgisini göster"
      : "Menüleri ve WASD bilgisini gizle";
  }
  try {
    localStorage.setItem(UI_CHROME_KEY, uiChromeHidden ? "1" : "0");
  } catch {
    /* ignore */
  }
  // Wait for grid columns to reflow, then size canvas to #stage only
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      resize();
    });
  });
}

uiToggleBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  applyUiChromeHidden(!uiChromeHidden);
});

/** Soft restart: empty cast, street — no full page refresh. */
async function restartSession() {
  if (sessionRestarting) return;
  sessionRestarting = true;
  statusEl.textContent = "Yeniden başlıyor…";
  try {
    persistentParty = [];
    partySnapshotEnabled = false;
    tennisCastCount = 0;
    truthDareCrowdCount = 0;
    redLightCastCount = 0;
    truthDareActive = false;
    truthDareSnapshot = new Map();
    try {
      clearTruthDareFormationLocks();
    } catch {
      /* */
    }
    try {
      stopRedLightGame({ clearDq: true });
    } catch {
      /* */
    }
    clearNpcScriptMoves();
    if (player?.scriptMove) player.scriptMove = null;
    if (player?.mesh?.userData) {
      player.mesh.userData.tennisTeam = null;
      player.mesh.userData.formationSlot = null;
      player.mesh.userData.formationMove = false;
      player.mesh.userData.redLightDq = false;
      player.mesh.userData.redLightEliminating = false;
      player.mesh.userData.redLightFinished = false;
      player.mesh.userData.redLightFinishing = false;
      player.mesh.visible = true;
    }
    clearTennisCast();
    clearCrowdExtras();
    for (const obj of [...listPartyCharacters()]) {
      clearNpcScriptMoves(obj);
      detachPlacedObject(obj);
      disposePlacedObject(obj);
    }
    if (companion) {
      detachPlacedObject(companion);
      disposePlacedObject(companion);
      companion = null;
    }
    try {
      syncTennisLiveSimUi();
      syncTruthDareCrowdUi();
      syncRedLightCastUi();
    } catch {
      /* UI helpers may not be ready */
    }
    if (sceneCatalog.some((s) => s.id === "street")) {
      await loadNamedScene("street");
    }
    persistentParty = [];
    statusEl.textContent = "Yeniden başladı · street · boş cast";
  } catch (err) {
    console.warn("restartSession", err);
    statusEl.textContent = "Yeniden başlatılamadı";
  } finally {
    sessionRestarting = false;
  }
}

uiRestartBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  restartSession().catch((err) => console.warn(err));
});

/** @type {"fill" | "9x16"} */
let viewportMode =
  localStorage.getItem(VP_STORAGE_KEY) === "9x16" ? "9x16" : "fill";
/** @type {"grass" | "black"} */
let bgMode = localStorage.getItem(BG_STORAGE_KEY) === "black" ? "black" : "grass";
/** Show green feet collision disks (player + pet). */
let colDebugVisible = localStorage.getItem(COL_DEBUG_KEY) !== "hide";
/** @type {THREE.Group | null} */
let petColRing = null;
const PET_COL_RADIUS = 12;
const PET_FEET_NUDGE_Z = -10;
let scenePersistTimer = 0;
let sceneLoading = false;
/** Bumped when a named scene file is the source of truth (AI / slot load). */
let sceneRevision = 0;
/** @type {string | null} */
let activeSceneId = null;
/** Street layout + walkZone / garage intro (street + truth-or-dare fork). */
function isStreetLikeScene(id = activeSceneId) {
  return id === "street" || id === "dogrulukmu_cesaretmi";
}
function isNightClubScene(id = activeSceneId) {
  return id === "night_club_inside";
}
function isRedLightScene(id = activeSceneId) {
  return id === "red_light_green_light";
}
function isFootballScene(id = activeSceneId) {
  return id === "football";
}
function isTennisScene(id = activeSceneId) {
  return id === "tennis";
}
function isTruthDareScene(id = activeSceneId) {
  return id === "dogrulukmu_cesaretmi";
}
/** After lineup: stay on seat/row — chat + /dance /jump /sit only. */
function isTruthDarePositionLocked(obj) {
  if (!truthDareActive || !isTruthDareScene()) return false;
  if (!obj?.userData) return false;
  return !!obj.userData.formationSlot && !obj.userData.formationMove;
}
/** Football / tennis — walkZone, top-layer actors, soft push. */
function isPlayfieldScene(id = activeSceneId) {
  return isFootballScene(id) || isTennisScene(id);
}
/** Scenes with shared walkZone (chars + ball bounce). */
function isWalkZoneScene(id = activeSceneId) {
  return isStreetLikeScene(id) || isRedLightScene(id) || isPlayfieldScene(id);
}
/** Crowd spawn buttons: street family + night club. */
function isCrowdScene(id = activeSceneId) {
  return isStreetLikeScene(id) || isNightClubScene(id);
}
/** @type {{ id: string, label?: string, file?: string }[]} */
let sceneCatalog = [];
const sceneCopyBtn = document.getElementById("scene-copy");
const sceneLoadBtn = document.getElementById("scene-load");
const sceneClearBtn = document.getElementById("scene-clear");
const sceneSlotsEl = document.getElementById("scene-slots");
const sceneModal = document.getElementById("scene-modal");
const sceneJsonEl = document.getElementById("scene-json");
const sceneModalCancel = document.getElementById("scene-modal-cancel");
const sceneModalApply = document.getElementById("scene-modal-apply");
const truthDareCrowdEl = document.getElementById("truth-dare-crowd");
const tennisLiveSimEl = document.getElementById("tennis-live-sim");
const tennisLiveStatsEl = document.getElementById("tennis-live-stats");
/** TikTok like/gift sim for tennis 2v2 — likes + gift count per team. */
const tennisLive = {
  a: { likes: 0, gifts: 0, power: 0 },
  b: { likes: 0, gifts: 0, power: 0 },
};
const TENNIS_LIKE_POWER = 1;
const TENNIS_GIFT_POWER = 12;
/** 0 | 2 | 4 — random cast size on tennis court */
let tennisCastCount = 0;
const redLightCastEl = document.getElementById("red-light-cast");
const TRUTH_DARE_CROWD_COUNTS = [5, 10, 20, 30, 40, 50];
const RED_LIGHT_CAST_MAX = 10;
/** @type {Map<object, { x: number, z: number, dir: string, sitting: boolean, isPlayer: boolean }>} */
let truthDareSnapshot = new Map();
let truthDareActive = false;
let truthDareCrowdCount = 0;
/** Desired cast size on red_light (Main + NPCs), 1–10. */
let redLightCastCount = 0;
/** dog_3 counter game (red_light_green_light). */
const RED_LIGHT_COUNT_MIN = 2;
const RED_LIGHT_COUNT_MAX = 5;
const RED_LIGHT_COUNT_BEAT = 1.05;
const RED_LIGHT_WATCH_SEC = 3;
const RED_LIGHT_MOVE_EPS = 10;
/** @type {{
 *   active: boolean,
 *   pendingStart: boolean,
 *   phase: 'idle'|'counting'|'watching',
 *   countNum: number,
 *   phaseT: number,
 *   cornerI: number,
 *   dogKey: string|null,
 *   entranceGen: number,
 *   pendingSince: number,
 *   settleAcc: number,
 *   entranceExpect: number,
 *   entranceArrived: number,
 *   minStartAt: number,
 * }} */
const redLightGame = {
  active: false,
  pendingStart: false,
  phase: "idle",
  countNum: RED_LIGHT_COUNT_MIN,
  phaseT: 0,
  cornerI: 0,
  dogKey: null,
  entranceGen: 0,
  pendingSince: 0,
  settleAcc: 0,
  entranceExpect: 0,
  entranceArrived: 0,
  minStartAt: 0,
};
const RED_LIGHT_SETTLE_HOLD = 0.35;
const RED_LIGHT_FORCE_START = 6;
const RED_LIGHT_MIN_LINEUP_SEC = 1.25;

function randomRedLightCount() {
  const lo = RED_LIGHT_COUNT_MIN;
  const hi = RED_LIGHT_COUNT_MAX;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
const TRUTH_DARE_RUN_SPEED = 190;
const TRUTH_DARE_WALK_SPEED = 110;
const TRUTH_DARE_ROW_SIZE = 8;
const TRUTH_DARE_ROW_GAP_Z = 48;
const TRUTH_DARE_COL_GAP_X = 44;
const TRUTH_DARE_FRONT_Z = 200;
/** Fixed playable frame center for 9:16 (camera does not follow the player). */
const MAP_VIEW = { x: 0, z: 200 };
const BG_PRESETS = {
  grass: {
    clear: 0x1a2220,
    fogNear: 1100,
    fogFar: 2600,
    plaza: 0x3a4a3c,
  },
  black: {
    // R11 G13 B42 — deep navy (shown as Lacivert in UI)
    clear: 0x0b0d2a,
    fogNear: 1400,
    fogFar: 3200,
    plaza: 0x0b0d2a,
  },
};
const inspLabel = document.getElementById("insp-label");
const inspX = document.getElementById("insp-x");
const inspZ = document.getElementById("insp-z");
const inspScale = document.getElementById("insp-scale");
const inspScaleVal = document.getElementById("insp-scale-val");
const inspDirs = document.getElementById("insp-dirs");
const inspDance = document.getElementById("insp-dance");
const inspDelete = document.getElementById("insp-delete");
const inspCol = document.getElementById("insp-col");
const inspColOn = document.getElementById("insp-col-on");
const inspColReset = document.getElementById("insp-col-reset");
/** Free position of #inspector after first drag (px, relative to #stage parent). */
let inspPos = /** @type {{ left: number, top: number } | null} */ (null);

function inspParentSize() {
  const parent = inspector?.parentElement;
  return {
    w: parent?.clientWidth || window.innerWidth,
    h: parent?.clientHeight || window.innerHeight,
  };
}

function clampInspPos(left, top) {
  const { w: pw, h: ph } = inspParentSize();
  const panelW = inspector?.offsetWidth || 0;
  const panelH = inspector?.offsetHeight || 0;
  const pad = 8;
  return {
    left: Math.max(pad, Math.min(pw - panelW - pad, left)),
    top: Math.max(pad, Math.min(ph - panelH - pad, top)),
  };
}

function applyInspPos(left, top) {
  if (!inspector) return;
  inspPos = clampInspPos(left, top);
  inspector.classList.add("insp-moved");
  inspector.style.setProperty("--insp-left", `${inspPos.left}px`);
  inspector.style.setProperty("--insp-top", `${inspPos.top}px`);
  inspector.style.setProperty("--insp-bottom", "auto");
  inspector.style.setProperty("--insp-transform", "none");
}

inspLabel?.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !inspector) return;
  e.preventDefault();
  e.stopPropagation();
  inspLabel.setPointerCapture(e.pointerId);
  inspector.classList.add("insp-dragging");
  const rect = inspector.getBoundingClientRect();
  const parent = inspector.parentElement?.getBoundingClientRect();
  const originLeft = rect.left - (parent?.left || 0);
  const originTop = rect.top - (parent?.top || 0);
  // Switch to top/left coords on first drag (leave centered bottom layout)
  if (!inspPos) applyInspPos(originLeft, originTop);
  const startX = e.clientX;
  const startY = e.clientY;
  const fromLeft = inspPos.left;
  const fromTop = inspPos.top;
  const onMove = (ev) => {
    applyInspPos(fromLeft + (ev.clientX - startX), fromTop + (ev.clientY - startY));
  };
  const onUp = (ev) => {
    try {
      inspLabel.releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    inspector.classList.remove("insp-dragging");
    inspLabel.removeEventListener("pointermove", onMove);
    inspLabel.removeEventListener("pointerup", onUp);
    inspLabel.removeEventListener("pointercancel", onUp);
  };
  inspLabel.addEventListener("pointermove", onMove);
  inspLabel.addEventListener("pointerup", onUp);
  inspLabel.addEventListener("pointercancel", onUp);
});

window.addEventListener("resize", () => {
  if (inspPos && inspector && !inspector.classList.contains("hidden")) {
    applyInspPos(inspPos.left, inspPos.top);
  }
  if (hudPos && hudEl) applyHudPos(hudPos.left, hudPos.top);
});

/**
 * Street gather from scene JSON `player` — garage exits walk here.
 * Fixed until the scene is reloaded; does not follow Main while he moves.
 */
let streetGatherTarget = { x: -0.33, z: 188.96 };

/** Free position of #hud after first drag (px, relative to #stage). */
let hudPos = /** @type {{ left: number, top: number } | null} */ (null);

function hudParentSize() {
  const parent = hudEl?.parentElement;
  return {
    w: parent?.clientWidth || window.innerWidth,
    h: parent?.clientHeight || window.innerHeight,
  };
}

function clampHudPos(left, top) {
  const { w: pw, h: ph } = hudParentSize();
  const panelW = hudEl?.offsetWidth || 0;
  const panelH = hudEl?.offsetHeight || 0;
  const pad = 8;
  return {
    left: Math.max(pad, Math.min(pw - panelW - pad, left)),
    top: Math.max(pad, Math.min(ph - panelH - pad, top)),
  };
}

function applyHudPos(left, top) {
  if (!hudEl) return;
  hudPos = clampHudPos(left, top);
  hudEl.classList.add("hud-moved");
  hudEl.style.setProperty("--hud-left", `${hudPos.left}px`);
  hudEl.style.setProperty("--hud-top", `${hudPos.top}px`);
}

hudEl?.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !hudEl) return;
  e.preventDefault();
  e.stopPropagation();
  hudEl.setPointerCapture(e.pointerId);
  hudEl.classList.add("hud-dragging");
  const rect = hudEl.getBoundingClientRect();
  const parent = hudEl.parentElement?.getBoundingClientRect();
  const originLeft = rect.left - (parent?.left || 0);
  const originTop = rect.top - (parent?.top || 0);
  if (!hudPos) applyHudPos(originLeft, originTop);
  const startX = e.clientX;
  const startY = e.clientY;
  const fromLeft = hudPos.left;
  const fromTop = hudPos.top;
  const onMove = (ev) => {
    applyHudPos(fromLeft + (ev.clientX - startX), fromTop + (ev.clientY - startY));
  };
  const onUp = (ev) => {
    try {
      hudEl.releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    hudEl.classList.remove("hud-dragging");
    hudEl.removeEventListener("pointermove", onMove);
    hudEl.removeEventListener("pointerup", onUp);
    hudEl.removeEventListener("pointercancel", onUp);
  };
  hudEl.addEventListener("pointermove", onMove);
  hudEl.addEventListener("pointerup", onUp);
  hudEl.addEventListener("pointercancel", onUp);
});

const dragGhost = document.getElementById("drag-ghost");
/** @type {THREE.Group | null} */
let colGizmo = null;
const COL_GIZMO_COLOR = 0x5ec8ff;
const COL_HANDLE_HIT_R = 28;
const COL_MAX_PTS = 16;
/** Street walk zone can use more vertices than night_club. */
const STREET_WALK_MAX_PTS = 32;
/** @type {{ obj?: THREE.Object3D, street?: boolean, index: number, from: any } | null} */
let colCornerDrag = null;

let player = null;
let lastTs = performance.now();
let selected = null;
/** @type {THREE.Object3D | null} */
let selectionOutline = null;
const SELECT_OUTLINE_COLOR = 0x3ddc6a;
let catalogItemById = new Map();
let placing = null; // catalog item while dragging from palette
/** @type {{ x:number, z:number } | null} */
let dragFrom = null;
/** @type {{ undo:()=>void, discard?:()=>void }[]} */
const undoStack = [];
const UNDO_MAX = 60;
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
/** World units behind Main — was 38/52 stop/start, spawn/target ~40–42. */
const COMPANION_FOLLOW_STOP = 24;
const COMPANION_FOLLOW_START = 36;
const COMPANION_OFFSET = 26;
const COMPANION_SPEED = 105;

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(BG_PRESETS[bgMode].clear, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(
  BG_PRESETS[bgMode].clear,
  BG_PRESETS[bgMode].fogNear,
  BG_PRESETS[bgMode].fogFar,
);

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

const grassGroundTex = makeGroundTexture();
const grassGroundMat = new THREE.MeshBasicMaterial({ map: grassGroundTex });
const blackGroundMat = new THREE.MeshBasicMaterial({ color: 0x0b0d2a });
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3600, 3600),
  bgMode === "black" ? blackGroundMat : grassGroundMat,
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const plaza = new THREE.Mesh(
  new THREE.PlaneGeometry(520, 220),
  new THREE.MeshBasicMaterial({ color: BG_PRESETS[bgMode].plaza }),
);
plaza.rotation.x = -Math.PI / 2;
plaza.position.set(0, 0.05, 200);
scene.add(plaza);

function applyBackgroundMode(mode) {
  bgMode = mode === "black" ? "black" : "grass";
  try {
    localStorage.setItem(BG_STORAGE_KEY, bgMode);
  } catch {
    /* */
  }
  const preset = BG_PRESETS[bgMode];
  renderer.setClearColor(preset.clear, 1);
  if (scene.fog) {
    scene.fog.color.setHex(preset.clear);
    scene.fog.near = preset.fogNear;
    scene.fog.far = preset.fogFar;
  }
  ground.material = bgMode === "black" ? blackGroundMat : grassGroundMat;
  plaza.material.color.setHex(preset.plaza);
  stageEl?.classList.toggle("bg-black", bgMode === "black");
  bgToggle?.querySelectorAll("button[data-bg]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-bg") === bgMode);
  });
}

const loader = new THREE.TextureLoader();
const pickables = [];
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hitPoint = new THREE.Vector3();
let dragging = null;
let dragOffset = new THREE.Vector3();

function syncCameraRig(target = null) {
  if (target) controls.target.set(target.x, 0, target.z);
  camera.position.set(
    controls.target.x + CAM_OFFSET.x,
    controls.target.y + CAM_OFFSET.y,
    controls.target.z + CAM_OFFSET.z,
  );
  camera.lookAt(controls.target);
  controls.update();
}

function setCameraFollowEnabled(on) {
  controls.enablePan = on;
  controls.enableRotate = on;
  controls.enableZoom = on;
  controls.enableDamping = on;
}

function applyViewportMode(mode) {
  viewportMode = mode === "9x16" ? "9x16" : "fill";
  try {
    localStorage.setItem(VP_STORAGE_KEY, viewportMode);
  } catch {
    /* */
  }
  stageEl?.classList.toggle("vp-9x16", viewportMode === "9x16");
  viewportToggle?.querySelectorAll("button[data-vp]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-vp") === viewportMode);
  });
  if (viewportMode === "9x16") {
    // Whole map framed once; player walks inside the fixed 9:16 view (incl. corners).
    setCameraFollowEnabled(false);
    syncCameraRig(MAP_VIEW);
  } else {
    setCameraFollowEnabled(true);
    const p = occupiedVehicle?.position || player?.mesh?.position;
    if (p) syncCameraRig({ x: p.x, z: p.z });
  }
  resize();
}

function resize() {
  // Soft keyboard / iOS focus-zoom must not reflow the WebGL stage
  if (chatKeyboardOpen) return;
  // Always measure #stage (center column) — never lockedShell, or Menü açılınca
  // canvas full-width kalıp oyun sağa kaymış gibi görünür
  const sw = stageEl?.clientWidth || window.innerWidth;
  const sh = stageEl?.clientHeight || window.innerHeight;
  let w;
  let h;
  if (viewportMode === "9x16") {
    const target = 9 / 16;
    if (sw / Math.max(sh, 1) > target) {
      h = sh;
      w = Math.round(h * target);
    } else {
      w = sw;
      h = Math.round(w / target);
    }
    app.style.width = `${w}px`;
    app.style.height = `${h}px`;
    app.style.left = `${Math.round((sw - w) / 2)}px`;
    app.style.top = `${Math.round((sh - h) / 2)}px`;
    app.style.right = "auto";
    app.style.bottom = "auto";
  } else {
    app.style.width = "";
    app.style.height = "";
    app.style.left = "";
    app.style.top = "";
    app.style.right = "";
    app.style.bottom = "";
    w = app.clientWidth || sw;
    h = app.clientHeight || sh;
  }
  aspect = w / Math.max(h, 1);
  camera.left = -frustum * aspect;
  camera.right = frustum * aspect;
  camera.top = frustum;
  camera.bottom = -frustum;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

/** Mobile soft keyboard / iOS focus-zoom — freeze shell px while typing. */
let chatKeyboardOpen = false;
let lockedShell = { w: 0, h: 0 };
/** Snapshot taken on chat focus — restore exactly on blur (ignore mid-keyboard sizes). */
let shellBeforeKeyboard = null;

function applyAppShellSize(w, h) {
  lockedShell = { w: Math.round(w), h: Math.round(h) };
  const root = document.documentElement;
  root.style.setProperty("--app-width", `${lockedShell.w}px`);
  root.style.setProperty("--app-height", `${lockedShell.h}px`);
  // Only pin height against keyboard; width stays 100% so Menü grid can reflow
  if (layoutEl) {
    layoutEl.style.width = "";
    layoutEl.style.height = `${lockedShell.h}px`;
  }
}

function measureAppShell() {
  // Prefer layout viewport; avoid visualViewport (shrinks with keyboard / zoom)
  const w =
    window.screen?.width && window.outerWidth
      ? Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth)
      : document.documentElement.clientWidth || window.innerWidth;
  const h = Math.max(
    window.innerHeight || 0,
    document.documentElement.clientHeight || 0,
  );
  return { w: Math.round(w), h: Math.round(h) };
}

function lockAppShell({ force = false } = {}) {
  if (chatKeyboardOpen && !force) return;
  if (chatKeyboardOpen && force && shellBeforeKeyboard) {
    applyAppShellSize(shellBeforeKeyboard.w, shellBeforeKeyboard.h);
    return;
  }
  const { w, h } = measureAppShell();
  // Same-ish width + height drop ≈ keyboard — keep previous shell
  if (
    !force &&
    lockedShell.h > 0 &&
    Math.abs(w - lockedShell.w) < 60 &&
    h < lockedShell.h * 0.9
  ) {
    return;
  }
  // Width jitter from URL bar / keyboard — keep width stable unless rotate
  if (
    !force &&
    lockedShell.w > 0 &&
    Math.abs(w - lockedShell.w) < 60 &&
    Math.abs(h - lockedShell.h) < 120
  ) {
    return;
  }
  if (
    force ||
    lockedShell.h === 0 ||
    Math.abs(w - lockedShell.w) >= 60 ||
    h >= lockedShell.h
  ) {
    applyAppShellSize(
      Math.abs(w - lockedShell.w) < 60 && lockedShell.w ? lockedShell.w : w,
      Math.abs(w - lockedShell.w) >= 60 ? h : Math.max(h, lockedShell.h || h),
    );
  }
}

function onShellViewportChange() {
  if (chatKeyboardOpen) return;
  lockAppShell({ force: false });
  resize();
}

window.addEventListener("resize", onShellViewportChange);
window.addEventListener("orientationchange", () => {
  chatKeyboardOpen = false;
  shellBeforeKeyboard = null;
  setTimeout(() => {
    lockAppShell({ force: true });
    resize();
  }, 300);
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", onShellViewportChange);
  window.visualViewport.addEventListener("scroll", () => {
    // iOS sometimes pans the visual viewport while keyboard is up — pin scroll
    if (!chatKeyboardOpen || !window.visualViewport) return;
    const vv = window.visualViewport;
    if (vv.offsetTop || vv.offsetLeft) {
      window.scrollTo(0, 0);
    }
  });
}
lockAppShell({ force: true });
applyUiChromeHidden(uiChromeHidden);
viewportToggle?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-vp]");
  if (!btn) return;
  applyViewportMode(btn.getAttribute("data-vp"));
});
bgToggle?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-bg]");
  if (!btn) return;
  applyBackgroundMode(btn.getAttribute("data-bg"));
});
colToggle?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-col]");
  if (!btn) return;
  applyColDebugVisible(btn.getAttribute("data-col") !== "hide");
});
applyBackgroundMode(bgMode);
applyViewportMode(viewportMode);

function makeColRing(radius, x, z, nudgeZ = 0) {
  const ring = new THREE.Group();
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.2, z + nudgeZ);
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 40),
    new THREE.MeshBasicMaterial({
      color: 0x3ddc6a,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }),
  );
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(1, radius - 1.2), radius + 0.4, 40),
    new THREE.MeshBasicMaterial({
      color: 0x9ef0a8,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  fill.renderOrder = 99990;
  rim.renderOrder = 99991;
  ring.add(fill, rim);
  ring.userData.skipPick = true;
  return ring;
}

function disposePetColRing() {
  if (!petColRing) return;
  petColRing.parent?.remove(petColRing);
  petColRing.traverse((n) => {
    n.geometry?.dispose?.();
    if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
    else n.material?.dispose?.();
  });
  petColRing = null;
}

function syncPetColRing() {
  if (!companion || !companion.visible) {
    if (petColRing) petColRing.visible = false;
    return;
  }
  if (!petColRing) {
    petColRing = makeColRing(
      PET_COL_RADIUS,
      companion.position.x,
      companion.position.z,
      PET_FEET_NUDGE_Z,
    );
    scene.add(petColRing);
  }
  petColRing.position.x = companion.position.x;
  petColRing.position.z = companion.position.z + PET_FEET_NUDGE_Z;
  petColRing.position.y = 0.2;
  petColRing.visible = colDebugVisible;
}

function applyColDebugVisible(show) {
  colDebugVisible = !!show;
  try {
    localStorage.setItem(COL_DEBUG_KEY, colDebugVisible ? "show" : "hide");
  } catch {
    /* */
  }
  player?.setColRingEnabled(colDebugVisible);
  if (petColRing) petColRing.visible = colDebugVisible && !!companion?.visible;
  else if (colDebugVisible && companion) syncPetColRing();
  colToggle?.querySelectorAll("button[data-col]").forEach((btn) => {
    const want = btn.getAttribute("data-col") === "show";
    btn.classList.toggle("active", want === colDebugVisible);
  });
}
applyColDebugVisible(colDebugVisible);

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

/** Characters/animals keep native frame canvas (like Main). Tight-trim
 *  per pose changes w×h every frame → sprite looks like it pulses. */
function shouldTightTrimUrl(url) {
  const s = String(url || "");
  if (/\/characters\//i.test(s)) return false;
  if (/\/animals\//i.test(s)) return false;
  return true;
}

function attachAlphaUserData(tex) {
  try {
    const img = tex.image;
    if (!img) return tex;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    tex.userData = { alpha: g.getImageData(0, 0, c.width, c.height) };
  } catch {
    /* */
  }
  return tex;
}

function pixelTexture(url, opts = {}) {
  const trim = opts.trim != null ? !!opts.trim : shouldTightTrimUrl(url);
  const key = trim ? url : `${url}#notrim`;
  if (texCache.has(key)) return texCache.get(key);
  const p = new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        if (!trim) {
          resolve(attachAlphaUserData(tex));
          return;
        }
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
  texCache.set(key, p);
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

/** Higher = preferred when several sprites overlap under the cursor. */
function pickPriority(obj) {
  const d = obj?.userData || {};
  const p = d.path || "";
  let score = obj.renderOrder || 0;
  // Characters / animals / balls always beat courts & cutaway rooms
  if (d.kind === "character" || isAnimalPath(p) || d.companion) score += 1_000_000;
  if (d.ball || isBallPath(p)) score += 900_000;
  // Buildings / props above ground tiles (grass always ray-hits under feet)
  if (d.layer === "ground" || d.tileable) score -= 800_000;
  if (/\/buildings\//i.test(p)) score += 100_000;
  if (isInteriorPath(p) || /night_club_inside/i.test(p)) score -= 1_000_000;
  return score;
}

/**
 * Pets are ~32px — court/ground sprites eat mesh raycasts under the cursor.
 * Prefer editable actors whose feet sit near the ground hit.
 */
function pickActorNearGround(gx, gz) {
  let best = null;
  let bestD = Infinity;
  for (const obj of pickables) {
    const d = obj?.userData;
    if (!d?.editable || d.occupied) continue;
    const animal = isAnimalPath(d.path) || !!d.companion;
    const ball = !!d.ball || isBallPath(d.path);
    const char = d.kind === "character";
    if (!animal && !ball && !char) continue;
    const radius = animal ? 52 : ball ? 40 : 44;
    const dist = Math.hypot(gx - obj.position.x, gz - obj.position.z);
    if (dist <= radius && dist < bestD) {
      bestD = dist;
      best = obj;
    }
  }
  return best;
}

function opaqueHits(hits, alphaThr = 8) {
  const out = [];
  for (const hit of hits) {
    const ud = hit.object?.userData;
    // Flat / tileable roads: pick by mesh so drag-move works reliably
    if (ud?.layer === "ground" || ud?.tileable) {
      out.push(hit);
      continue;
    }
    if (!hit.uv) {
      // Sprites sometimes lack UV — still allow pets/chars/balls
      if (isForegroundActor(hit.object) || ud?.ball) out.push(hit);
      continue;
    }
    const map = hit.object.material?.map;
    const data = map?.userData?.alpha;
    if (!data) {
      if (isForegroundActor(hit.object) || ud?.ball) out.push(hit);
      continue;
    }
    const x = Math.min(data.width - 1, Math.max(0, Math.floor(hit.uv.x * data.width)));
    const y = Math.min(
      data.height - 1,
      Math.max(0, Math.floor((1 - hit.uv.y) * data.height)),
    );
    if (data.data[(y * data.width + x) * 4 + 3] > alphaThr) out.push(hit);
  }
  // Match what you see: topmost / character wins over night_club black plate
  out.sort((a, b) => pickPriority(b.object) - pickPriority(a.object));
  return out;
}

/** Cutaway room visual footprint — actors here must draw above the room art. */
function interiorCoverOrder(px, pz) {
  let best = 0;
  for (const room of pickables) {
    const d = room.userData;
    if (!d || !isInteriorPath(d.path)) continue;
    const w = (d.w || 64) * (d.scale || 1);
    const h = (d.h || 64) * (d.scale || 1);
    const bx = room.position.x;
    const bz = room.position.z;
    // Wide zone: full sprite width + most of the cutaway height (incl. north of foot)
    const hw = w * 0.55;
    const zSouth = bz + h * 0.12;
    const zNorth = bz - h * 0.85;
    if (Math.abs(px - bx) > hw || pz > zSouth || pz < zNorth) continue;
    const roomBias = /night_club_inside/i.test(d.path) ? -4500 : -3500;
    const roomOrder = Math.round(bz * 10 + roomBias);
    best = Math.max(best, roomOrder + 200);
  }
  return best;
}

/** Player, pets, placed characters, animals — never under night_club_inside. */
function isForegroundActor(obj) {
  const d = obj?.userData;
  if (!d) return false;
  if (d.controllable || d.companion) return true;
  if (d.kind === "character") return true;
  if (isAnimalPath(d.path)) return true;
  return false;
}

/** red_light / football / tennis: chars / pets / balls draw above courts & buildings. */
function isPlayfieldTopLayer(obj) {
  if (!(isRedLightScene() || isPlayfieldScene()) || !obj?.userData) return false;
  if (isForegroundActor(obj)) return true;
  if (obj.userData.ball || isBallPath(obj.userData.path)) return true;
  return false;
}

/** @deprecated alias — prefer isPlayfieldTopLayer */
function isRedLightTopLayer(obj) {
  return isPlayfieldTopLayer(obj);
}

function syncDepth(obj) {
  const p = obj.userData?.path || "";
  let layerBias = 0;
  if (obj.userData?.layer === "ground") layerBias = -10000;
  // Cutaway rooms stay behind characters / pets / props in the scene
  else if (/night_club_inside/i.test(p)) layerBias = -4500;
  else if (isInteriorPath(p)) layerBias = -3500;
  // Buildings / courts stay visually behind actors on playfields
  else if (
    (isPlayfieldScene() || isRedLightScene()) &&
    /\/buildings\//i.test(p)
  ) {
    layerBias = -2000;
  }

  let order = Math.round(obj.position.z * 10 + layerBias);
  if (isForegroundActor(obj)) {
    const cover = interiorCoverOrder(obj.position.x, obj.position.z);
    if (cover) order = Math.max(order, cover);
  }
  // red_light / football: characters + pets + balls above court/props
  if (isPlayfieldTopLayer(obj)) order += 200000;
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
  // roads / tileable paths — user prefers large default
  if (/\/props\/ground\//i.test(item.path || "")) return 1;
  if (isRoadTileItem(item) || /\/props\/road\//i.test(item.path || "")) return 3;
  if (/americanschoolbus|schoolBus/i.test(item.path || "")) return 1.7;
  if (/\/ambulance\//i.test(item.path || "")) return 1.7;
  if (/boat|ferry/i.test(item.path || "")) return 1.5;
  if (/outdoorPark\/bench|outdoorpark\/bench/i.test(item.path || "")) return 0.8;
  if (/outdoorPark\/table|outdoorpark\/table/i.test(item.path || "")) return 1;
  if (/outdoorPark\/tree|outdoorpark\/tree/i.test(item.path || "")) return 1;
  if (/night_club_inside/i.test(item.path || "")) return 2.8;
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
  return /\/props\/road\//i.test(p) || /\/props\/ground\//i.test(p);
}

function isRoadTileItem(item) {
  // Catalog flag OR any flat ground/road path (Shift+ok çoğaltma)
  if (item?.tileable) return true;
  return usesGroundPlane(item);
}

function isTileableObj(obj) {
  const d = obj?.userData;
  if (!d) return false;
  if (d.tileable || d.layer === "ground") return true;
  return /\/props\/(ground|road)\//i.test(d.path || "");
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
    if (obj === occupiedSkateboard || obj.userData?.rider) continue;
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

/** Keep board under rider feet (Main or cast — other players). */
function syncSkateboardUnderRider(rider) {
  const board = findSkateRiddenBy(rider);
  if (!board || !rider) return;
  const isMain = rider === player?.mesh;
  if (isMain && !player.skating) return;
  if (!isMain && !rider.userData?.skating) return;
  board.visible = true;
  const dir = (isMain ? player.facing : rider.userData.dir) || board.userData.dir || "";
  const face = FACE_VEC[dir] || FACE_VEC.south;
  const u = isMain ? player.ollieU || 0 : rider.userData.ollieU || 0;
  const lift = Math.sin(Math.PI * u);
  const nose = lift * 5;
  board.position.x = rider.position.x + face[0] * nose;
  board.position.z = rider.position.z + face[1] * nose;
  board.position.y = (rider.position.y || 0) + 0.05 + lift * 3;
  if (dir && board.userData.dir !== dir) applyFacing(board, dir);
  if (board.isSprite) {
    const horiz = dir === "east" || dir === "west";
    board.center.set(0.5, horiz ? -0.07 : -0.02);
  }
  if (board.material) {
    board.material.rotation = lift * (OLLIE_TIP_ROT[dir] || 0);
  }
  syncDepth(board);
  board.renderOrder = (rider.renderOrder || 0) - 20;
}

function syncSkateboardUnderPlayer() {
  if (player?.mesh) syncSkateboardUnderRider(player.mesh);
}

function enterSkateboard(board, rider = player?.mesh) {
  if (!board || !rider || board.userData?.rider) return false;
  const isMain = rider === player?.mesh;
  if (isMain) {
    if (!player || player.skating || player.driving) return false;
    occupiedSkateboard = board;
    nearbySkateboard = null;
    if (board.userData.dir) player.facing = board.userData.dir;
    player.startSkating();
  } else {
    if (rider.userData?.skating || rider.userData?.driving) return false;
    clearNpcScriptMoves(rider);
    rider.userData.skating = true;
    rider.userData.sitting = false;
    rider.userData.dancing = false;
    if (board.userData.dir) {
      rider.userData.dir = board.userData.dir;
      applyFacing(rider, board.userData.dir);
    }
  }
  board.userData.rider = rider;
  board.userData._solidBeforeSkate = !!board.userData.solid;
  board.userData.solid = false;
  board.visible = true;
  rider.position.x = board.position.x;
  rider.position.z = board.position.z;
  rider.position.y = 0;
  if (isMain) player.syncRing(board.position.x, board.position.z);
  syncSkateboardUnderRider(rider);
  if (selected === board) selectObject(null);
  hidePrompt();
  statusEl.textContent = isMain ? "Kaykaydasın" : "Karakter kaykaya bindi";
  return true;
}

function exitSkateboard(rider = player?.mesh) {
  if (!rider) return false;
  const board = findSkateRiddenBy(rider);
  if (!board) return false;
  const isMain = rider === player?.mesh;
  const facing = isMain ? player.facing : rider.userData.dir || "south";
  const face = FACE_VEC[facing] || FACE_VEC.south;
  const side = [-face[1], face[0]];
  board.position.x = rider.position.x;
  board.position.z = rider.position.z;
  board.position.y = 0;
  if (facing) applyFacing(board, facing);
  if (board.isSprite) board.center.set(0.5, 0);
  if (board.material) board.material.rotation = 0;
  board.userData.solid = false;
  board.userData.rider = null;
  board.visible = true;
  syncDepth(board);

  if (isMain) {
    occupiedSkateboard = null;
    player.stopSkating();
  } else {
    rider.userData.skating = false;
    rider.userData.ollieU = 0;
  }

  const pr = isMain ? player.radius || 22 : NPC_WALK_RADIUS;
  const tryOffsets = [
    [side[0] * (pr + 14), side[1] * (pr + 14)],
    [-side[0] * (pr + 14), -side[1] * (pr + 14)],
    [face[0] * (pr + 16), face[1] * (pr + 16)],
    [-face[0] * (pr + 16), -face[1] * (pr + 16)],
  ];
  for (const [ox, oz] of tryOffsets) {
    const nx = board.position.x + ox;
    const nz = board.position.z + oz;
    const clear = isMain
      ? !playerFeetCollidesAtMesh(nx, nz, pr)
      : !actorBlocked(rider, nx, nz + FEET_NUDGE_Z, pr);
    if (clear) {
      rider.position.x = nx;
      rider.position.z = nz;
      if (isMain) {
        player.syncRing(nx, nz);
        if (player.syncDepth) player.syncDepth(player.mesh);
      } else syncDepth(rider);
      break;
    }
  }

  hidePrompt();
  statusEl.textContent = "Hazır";
  return true;
}

function nearestVehicle(px, pz) {
  let best = null;
  let bestD = Infinity;
  for (const obj of pickables) {
    if (!isVehicleObj(obj)) continue;
    if (obj.userData?.traffic) continue;
    if (obj === occupiedVehicle || obj.userData?.driver) continue;
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
const _promptFeetNdc = new THREE.Vector3();
const _camUp = new THREE.Vector3();
/** Label CSS size tracks on-screen sprite height (ref ≈ desktop 9:16). */
const WORLD_LABEL_REF_PX = 118;

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
function showPromptAbove(obj, text, key = "/E") {
  if (!obj || !promptEl) {
    hidePrompt();
    return;
  }
  if (promptKeyEl) promptKeyEl.textContent = key;
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

const worldLabelsRoot = document.getElementById("world-labels");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send");
const PLAYER_CHAT_NAME = "Main";
const BUBBLE_DURATION_MS = 4500;
/** @type {Map<string, { root: HTMLElement, nameEl: HTMLElement, bubbleEl: HTMLElement, hideAt: number, obj: THREE.Object3D | null }>} */
const worldLabelMap = new Map();

const WORLD_NAME_MAX = 6;

function shortCharacterName(label, path) {
  let name = "";
  if (label) {
    const head = String(label).split("·")[0].trim();
    if (head) name = head;
  }
  if (!name) {
    const m = String(path || "").match(/assets\/characters\/([^/]+)/i);
    name = m ? m[1] : "NPC";
  }
  if (name.length > WORLD_NAME_MAX) return `${name.slice(0, WORLD_NAME_MAX)}…`;
  return name;
}

function labelKeyFor(obj) {
  if (!obj) return null;
  if (player?.mesh && obj === player.mesh) return "player";
  return obj.uuid || obj.userData?.catalogKey || null;
}

function isGirlCharacterPath(path) {
  return /\/characters\/girl_/i.test(String(path || ""));
}

function applyWorldLabelGender(nameEl, path) {
  if (!nameEl) return;
  nameEl.classList.toggle("girl", isGirlCharacterPath(path));
}

function ensureWorldLabel(key, displayName, path = null) {
  let entry = worldLabelMap.get(key);
  if (entry) {
    if (entry.nameEl.textContent !== displayName) {
      entry.nameEl.textContent = displayName;
    }
    if (path != null) applyWorldLabelGender(entry.nameEl, path);
    return entry;
  }
  const root = document.createElement("div");
  root.className = "world-label hidden";
  root.dataset.key = key;
  const nameEl = document.createElement("div");
  nameEl.className = "world-label-name";
  nameEl.textContent = displayName;
  applyWorldLabelGender(nameEl, path);
  const bubbleEl = document.createElement("div");
  bubbleEl.className = "world-label-bubble hidden";
  // order: bubble above name
  root.append(bubbleEl, nameEl);
  worldLabelsRoot?.appendChild(root);
  entry = { root, nameEl, bubbleEl, hideAt: 0, obj: null };
  worldLabelMap.set(key, entry);
  return entry;
}

function removeWorldLabel(key) {
  const entry = worldLabelMap.get(key);
  if (!entry) return;
  entry.root.remove();
  worldLabelMap.delete(key);
}

function projectHeadScreen(obj) {
  if (!obj || !renderer?.domElement) return null;
  camera.updateMatrixWorld(true);
  // Sprite top in world units (center.y=0 → full scale.y above feet)
  const h = obj.scale?.y || (obj.userData?.h || 96) * (obj.userData?.scale || 1) || 96;
  const cy = obj.center?.y ?? 0;
  const isChar =
    (player?.mesh && obj === player.mesh) || obj.userData?.kind === "character";
  // Untrimmed 96×96 frames keep empty pad above the head — sit just above
  // the visible crown, with a little air (not canvas-top float, not glued on).
  const headFrac = isChar ? 0.87 : 1;
  const pad = isChar ? 2 : 2;
  _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  // CSS translate(-50%, -100%) sits the name on this anchor
  _promptWorld
    .copy(obj.position)
    .addScaledVector(_camUp, h * (1 - cy) * headFrac + pad);
  _promptNdc.copy(_promptWorld).project(camera);
  if (Math.abs(_promptNdc.x) > 1.4 || Math.abs(_promptNdc.y) > 1.4) return null;
  const canvasRect = renderer.domElement.getBoundingClientRect();
  const sx = ((_promptNdc.x + 1) / 2) * canvasRect.width + canvasRect.left;
  const sy = ((-_promptNdc.y + 1) / 2) * canvasRect.height + canvasRect.top + 2;
  // Feet → head screen height so labels shrink with the viewport/sprites
  _promptFeetNdc.copy(obj.position).project(camera);
  const feetSy =
    ((-_promptFeetNdc.y + 1) / 2) * canvasRect.height + canvasRect.top;
  const spritePx = Math.max(8, Math.abs(feetSy - sy));
  const scale = Math.min(1.2, Math.max(0.52, spritePx / WORLD_LABEL_REF_PX));
  return { sx, sy, scale };
}

function speakAs(
  obj,
  text,
  { danger = false, success = false, holdMs = BUBBLE_DURATION_MS } = {},
) {
  const msg = String(text || "").trim();
  if (!msg || !obj) return;
  const key = labelKeyFor(obj);
  if (!key) return;
  const name =
    key === "player"
      ? PLAYER_CHAT_NAME
      : shortCharacterName(obj.userData?.label, obj.userData?.path);
  const entry = ensureWorldLabel(key, name, obj.userData?.path);
  entry.obj = obj;
  entry.bubbleEl.textContent = msg;
  entry.bubbleEl.classList.toggle("bubble-danger", !!danger);
  entry.bubbleEl.classList.toggle("bubble-success", !!success && !danger);
  entry.bubbleEl.classList.remove("hidden");
  entry.hideAt = performance.now() + (Number(holdMs) > 0 ? holdMs : BUBBLE_DURATION_MS);
  entry.root.classList.remove("hidden");
}

function chatSpeaker() {
  if (selected?.userData?.kind === "character" && selected.visible !== false) {
    return selected;
  }
  return player?.mesh || null;
}

/** 1 chat "birim" ≈ half a ground tile — /R3 feels like a clear step. */
const CHAT_MOVE_UNIT = 48;
/** Speech bubble / chat message max length (commands ignored). */
const CHAT_MSG_MAX = 48;
/** @type {{ obj: THREE.Object3D, dx: number, dz: number, left: number, speed: number, wait?: number }[]} */
let npcScriptMoves = [];

const CHAT_DIR_ALIASES = {
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  r: "east", // right
  l: "west", // left
  ne: "north-east",
  "n-e": "north-east",
  nw: "north-west",
  "n-w": "north-west",
  se: "south-east",
  "s-e": "south-east",
  sw: "south-west",
  "s-w": "south-west",
  north: "north",
  south: "south",
  east: "east",
  west: "west",
  "north-east": "north-east",
  "north-west": "north-west",
  "south-east": "south-east",
  "south-west": "south-west",
};

function parseChatDirToken(tok) {
  const key = String(tok || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  return CHAT_DIR_ALIASES[key] || null;
}

function clearNpcScriptMoves(obj = null) {
  if (!obj) {
    npcScriptMoves = [];
    return;
  }
  npcScriptMoves = npcScriptMoves.filter((sm) => sm.obj !== obj);
}

function enqueueNpcWalk(obj, dx, dz, dist, speed = 110, wait = 0, opts = {}) {
  if (!obj || !(dist > 0)) return;
  clearNpcScriptMoves(obj);
  // Free from formation pin so /N20 etc. can actually move
  if (obj.userData) obj.userData.formationSlot = null;
  const len = Math.hypot(dx, dz) || 1;
  npcScriptMoves.push({
    obj,
    dx: dx / len,
    dz: dz / len,
    left: dist,
    speed,
    wait: Math.max(0, wait),
    stuck: 0,
    gait: opts.gait || "walk",
    onDone: typeof opts.onDone === "function" ? opts.onDone : null,
  });
}

function finishNpcWalk(obj, sm = null) {
  if (!obj?.userData) {
    try {
      sm?.onDone?.();
    } catch {
      /* */
    }
    return;
  }
  if (obj.userData.driving) {
    try {
      sm?.onDone?.();
    } catch {
      /* */
    }
    return; // stay hidden in vehicle
  }
  if (obj.userData.skating) {
    syncSkateboardUnderRider(obj);
    try {
      sm?.onDone?.();
    } catch {
      /* */
    }
    return;
  }
  const dir = obj.userData.dir || "south";
  if (!sm?.onDone) {
    attachIdle(obj, obj.userData.path, dir, { allowSouthFallback: true }).catch(
      () => {},
    );
  }
  try {
    sm?.onDone?.();
  } catch {
    /* */
  }
}

const NPC_WALK_RADIUS = 18;

/** Axis-separate slide (same idea as Player.tryMove) — don't freeze on corners. */
function npcTryStep(obj, dx, dz, radius = NPC_WALK_RADIUS) {
  if (!obj) return 0;
  // Driving cast: move the vehicle instead of the hidden body
  if (obj.userData?.driving) {
    const veh = findVehicleDrivenBy(obj);
    if (!veh) return 0;
    return npcTryStepVehicle(veh, dx, dz, radius);
  }
  const x0 = obj.position.x;
  const z0 = obj.position.z;
  const nx = x0 + dx;
  const nz = z0 + dz;
  const blockedAt = (x, z) => actorBlocked(obj, x, z, radius);
  if (dx && !blockedAt(nx, z0 + FEET_NUDGE_Z)) {
    obj.position.x = nx;
  }
  if (dz && !blockedAt(obj.position.x, nz + FEET_NUDGE_Z)) {
    obj.position.z = nz;
  }
  const moved = Math.hypot(obj.position.x - x0, obj.position.z - z0);
  // Frame delta for ball kick impulse (cast = other players)
  obj.userData._moveDx = obj.position.x - x0;
  obj.userData._moveDz = obj.position.z - z0;
  if (moved > 0) {
    syncDepth(obj);
    if (obj.userData.skating) syncSkateboardUnderRider(obj);
  }
  return moved;
}

function npcTryStepVehicle(veh, dx, dz, radius = NPC_WALK_RADIUS) {
  const x0 = veh.position.x;
  const z0 = veh.position.z;
  const nx = x0 + dx;
  const nz = z0 + dz;
  // Vehicles use solidBlockedExcept self
  if (dx && !solidBlockedExcept(nx, z0, radius, veh)) veh.position.x = nx;
  if (dz && !solidBlockedExcept(veh.position.x, nz, radius, veh)) veh.position.z = nz;
  if (veh.position.x !== x0 || veh.position.z !== z0) syncDepth(veh);
  return Math.hypot(veh.position.x - x0, veh.position.z - z0);
}

function findVehicleDrivenBy(rider) {
  if (!rider) return null;
  if (rider === player?.mesh) return occupiedVehicle;
  return pickables.find((o) => o.userData?.driver === rider) || null;
}

function findSkateRiddenBy(rider) {
  if (!rider) return null;
  if (rider === player?.mesh) return occupiedSkateboard;
  return pickables.find((o) => o.userData?.rider === rider) || null;
}

/** Push spawn out of solids (garage lip / trees) before scripted walk. */
function findClearSpawn(x, z, preferDx = -1, preferDz = 0, radius = NPC_WALK_RADIUS) {
  if (!solidBlocked(x, z + FEET_NUDGE_Z, radius)) return { x, z };
  const len = Math.hypot(preferDx, preferDz) || 1;
  const ux = preferDx / len;
  const uz = preferDz / len;
  const ring = [
    [ux, uz],
    [-ux, -uz],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, -Math.SQRT1_2],
  ];
  for (let d = 16; d <= 260; d += 14) {
    for (const [rx, rz] of ring) {
      const nx = x + rx * d;
      const nz = z + rz * d;
      if (!solidBlocked(nx, nz + FEET_NUDGE_Z, radius)) return { x: nx, z: nz };
    }
  }
  return { x, z };
}

function tickNpcScriptMove(dt) {
  for (let i = npcScriptMoves.length - 1; i >= 0; i--) {
    const sm = npcScriptMoves[i];
    if (!sm?.obj?.parent || sm.obj.visible === false) {
      npcScriptMoves.splice(i, 1);
      continue;
    }
    if ((sm.wait || 0) > 0) {
      sm.wait -= dt;
      continue;
    }
    const step = Math.min(sm.left, sm.speed * dt);
    const moved = npcTryStep(sm.obj, sm.dx * step, sm.dz * step);
    // Like Main scriptMove: keep burning distance while sliding past blockers
    sm.left -= Math.max(moved, step * 0.25);
    if (moved < 0.04) sm.stuck = (sm.stuck || 0) + dt;
    else sm.stuck = 0;
    // Night club crowd enter: wait longer before snap-finish
    const stuckLimit =
      isNightClubScene() &&
      sm.obj?.userData?.crowdExtra &&
      sm.obj?.userData?.formationMove
        ? 3.2
        : 1.4;
    if (sm.left <= 0.5 || (sm.stuck || 0) > stuckLimit) {
      finishNpcWalk(sm.obj, sm);
      npcScriptMoves.splice(i, 1);
    }
  }
}

/** Swap …/states/<x>/… → …/states/<state>/… */
function characterStatePath(path, state) {
  const p = String(path || "");
  if (!/\/states\//i.test(p)) return null;
  return p.replace(/\/states\/[^/]+/i, `/states/${state}`);
}

async function listCharacterStateFolders(path) {
  const m = String(path || "").match(/^(.*\/states)\/([^/]+)/i);
  if (!m) return [];
  try {
    const res = await fetch(assetUrl(`${m[1]}/`));
    if (!res.ok) return [];
    const html = await res.text();
    const names = [];
    for (const hit of html.matchAll(/href="([^"?#]+)\/"/gi)) {
      let name = decodeURIComponent(hit[1]);
      name = name.replace(/\/$/, "").split("/").pop();
      if (!name || name === ".." || name === ".") continue;
      names.push(name);
    }
    return [...new Set(names)];
  } catch {
    return [];
  }
}

/** Pick sit/stand folder — sit_chair, sit_onground, outfit_sit_*, etc. */
function pickCharacterStateFolder(folders, current, wantSit) {
  const list = folders || [];
  if (!list.length) return wantSit ? "sit" : "stand";
  const cur = String(current || "");
  const isSitName = (n) => /sit/i.test(n);
  const isStandName = (n) => /stand/i.test(n) && !/sit/i.test(n);
  const ranked = list
    .filter((n) => (wantSit ? isSitName(n) : isStandName(n)))
    .map((n) => {
      let score = 0;
      const curKey = cur.replace(/_?(stand|sit).*$/i, "").toLowerCase();
      const nKey = n.replace(/_?(stand|sit).*$/i, "").toLowerCase();
      if (curKey && nKey && (nKey.startsWith(curKey) || curKey.startsWith(nKey))) {
        score += 50;
      }
      if (wantSit && /^sit$/i.test(n)) score += 10;
      if (!wantSit && /^stand$/i.test(n)) score += 10;
      return { n, score };
    })
    .sort((a, b) => b.score - a.score);
  if (ranked.length) return ranked[0].n;
  return wantSit ? "sit" : "stand";
}

async function resolveCharacterStatePath(path, wantSit) {
  const m = String(path || "").match(/^(.*\/states)\/([^/]+)/i);
  if (!m) return null;
  const folders = await listCharacterStateFolders(path);
  const folder = pickCharacterStateFolder(folders, m[2], wantSit);
  return `${m[1]}/${folder}`;
}

async function setCharacterSitPose(obj, sitting) {
  if (!obj?.userData || obj.userData.kind !== "character") return false;
  const token = nextCharacterAnimToken(obj);
  const nextPath =
    (await resolveCharacterStatePath(obj.userData.path, !!sitting)) ||
    characterStatePath(obj.userData.path, sitting ? "sit" : "stand");
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!nextPath) {
    statusEl.textContent = "Bu karakterde sit/stand yok";
    return false;
  }
  const dir = obj.userData.dir || "south";
  const dirs = obj.userData.dirs?.length ? obj.userData.dirs : DIRS;
  const rotTextures = await loadRotationTextures(nextPath, dirs);
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!Object.keys(rotTextures).length) {
    statusEl.textContent = sitting ? "Sit animasyonu yok" : "Stand bulunamadı";
    return false;
  }
  obj.userData.path = nextPath;
  obj.userData.rotTextures = rotTextures;
  obj.userData.idleSlug = null;
  obj.userData.dancing = false;
  obj.userData.animName = null;
  obj.userData.anim = null;
  obj.userData.sitting = !!sitting;
  const faceTex = rotTextures[dir] || rotTextures.south || Object.values(rotTextures)[0];
  if (faceTex) setMap(obj, faceTex);
  await attachIdle(obj, nextPath, dir, { allowSouthFallback: true });
  if (!sceneLoading) schedulePersistScene();
  statusEl.textContent = sitting ? "Oturuyor" : "Ayağa kalktı";
  return true;
}

async function handleChatCommand(raw) {
  const text = String(raw || "").trim();
  const who = chatSpeaker();
  if (!who) {
    statusEl.textContent = "Komut için karakter yok";
    return;
  }
  const isPlayer = !!(player?.mesh && who === player.mesh);
  // Case-insensitive: /Dance /R3 /jump …
  const lower = text.toLowerCase();
  const name =
    isPlayer
      ? PLAYER_CHAT_NAME
      : shortCharacterName(who.userData?.label, who.userData?.path);

  if (
    isRedLightDq(who) ||
    who.userData?.redLightEliminating ||
    (redLightGame.active &&
      (isRedLightFinished(who) || isRedLightFinishing(who)))
  ) {
    statusEl.textContent =
      isRedLightFinished(who) || isRedLightFinishing(who)
        ? `${name} üstte — oyun bitene kadar komut yok`
        : `${name} diskalifiye — oyun bitene kadar komut yok`;
    return;
  }

  const tdLocked = isTruthDarePositionLocked(who);
  if (tdLocked) {
    // Allow chat + /dance /jump /sit /stop — no walk / mount / relocate
    if (
      lower === "/e" ||
      /^\/(n|s|e|w|r|l|ne|nw|se|sw|n-e|n-w|s-e|s-w)\s*\d/i.test(lower)
    ) {
      statusEl.textContent =
        "doğrulukmu — yerinde kal · yazı /dance /jump /sit /stop";
      return;
    }
  }

  if (lower === "/play") {
    if (!isRedLightScene()) {
      statusEl.textContent = "/play sadece red light sahnesinde";
      return;
    }
    if (redLightGame.active || redLightGame.pendingStart) {
      statusEl.textContent = "Red light zaten başlıyor / oynanıyor";
      return;
    }
    await startRedLightPlay();
    return;
  }

  if (lower === "/dance") {
    if (isRedLightScene()) {
      statusEl.textContent = "Red light — sadece yürüme";
      return;
    }
    if (isPlayer) {
      if (player.driving) {
        statusEl.textContent = "Araçtayken dans yok";
        return;
      }
      player.startDance();
      statusEl.textContent = `${name}: dance`;
      return;
    }
    await setCharacterDancing(who, true);
    return;
  }

  if (lower === "/jump") {
    if (isRedLightScene()) {
      statusEl.textContent = "Red light — sadece yürüme";
      return;
    }
    if (isPlayer) {
      if (player.driving) {
        statusEl.textContent = "Araçtayken zıplama yok";
        return;
      }
      if (!player.startJump()) {
        statusEl.textContent = "Şu an zıplanamaz";
        return;
      }
      statusEl.textContent = `${name}: jump`;
      return;
    }
    if (who.userData?.driving) {
      statusEl.textContent = "Araçtayken zıplama yok";
      return;
    }
    const ok = await attachJump(who, who.userData.path, who.userData.dir || "south");
    statusEl.textContent = ok ? `${name}: jump` : "Bu karakterde jump yok";
    return;
  }

  if (lower === "/sit") {
    if (isPlayer) {
      if (player.driving || player.skating) {
        statusEl.textContent = "Şu an oturulamaz";
        return;
      }
      if (!player.startSit()) {
        statusEl.textContent = "Şu an oturulamaz";
        return;
      }
      statusEl.textContent = `${name}: sit`;
      return;
    }
    clearNpcScriptMoves(who);
    await setCharacterSitPose(who, true);
    return;
  }

  // /e — mount nearby skate/vehicle (Main or selected cast)
  if (lower === "/e") {
    if (isPlayer) {
      if (player.skating || occupiedVehicle) {
        statusEl.textContent = "Zaten bindin — inmek için /stop";
        return;
      }
      if (nearbySkateboard) {
        enterSkateboard(nearbySkateboard, player.mesh);
        statusEl.textContent = `${name}: kaykaya bindi`;
        return;
      }
      if (nearbyVehicle) {
        enterVehicle(nearbyVehicle, player.mesh);
        statusEl.textContent = `${name}: araca bindi`;
        return;
      }
      statusEl.textContent = "Bin yok — önce E/Bin çıkan kaykaya veya araca yaklaş";
      return;
    }
    if (who.userData?.skating || who.userData?.driving) {
      statusEl.textContent = "Zaten bindi — inmek için /stop";
      return;
    }
    const board = nearestSkateboard(who.position.x, who.position.z);
    const veh = nearestVehicle(who.position.x, who.position.z);
    if (board) {
      enterSkateboard(board, who);
      statusEl.textContent = `${name}: kaykaya bindi`;
      return;
    }
    if (veh) {
      enterVehicle(veh, who);
      statusEl.textContent = `${name}: araca bindi`;
      return;
    }
    statusEl.textContent = "Bin yok — karakteri kaykaya/araca yaklaştır";
    return;
  }

  if (lower === "/stop") {
    if (tdLocked) {
      // Cancel dance/sit/jump in place — keep formation slot
      if (isPlayer) {
        if (player.busy === "dance") player.stopDance?.();
        else if (player.sitting) {
          player.sitting = false;
          player.anim = "idle";
          player.frame = 0;
          player.accum = 0;
          player.applyFrame?.();
        } else if (player.busy === "jump") {
          player.busy = null;
          player.anim = "idle";
          player.frame = 0;
          player.accum = 0;
          player.applyFrame?.();
        }
        statusEl.textContent = `${name}: stop`;
        return;
      }
      clearNpcScriptMoves(who);
      if (who.userData?.busy === "jump") finishNpcJump(who);
      if (who.userData?.dancing || who.userData?.animName === "dance") {
        await setCharacterDancing(who, false);
      } else if (
        who.userData?.sitting ||
        /\/states\/sit/i.test(who.userData?.path || "")
      ) {
        await setCharacterSitPose(who, false);
      } else {
        statusEl.textContent = `${name}: stop`;
      }
      return;
    }
    if (isPlayer) {
      // /stop = in (vehicle/skate) when mounted; else cancel dance/sit/walk
      if (player.skating && occupiedSkateboard) {
        exitSkateboard(player.mesh);
        statusEl.textContent = `${name}: kaykaydan indi`;
        return;
      }
      if (occupiedVehicle) {
        exitVehicle(player.mesh);
        statusEl.textContent = `${name}: araçtan indi`;
        return;
      }
      player.stopActions();
      statusEl.textContent = `${name}: stop`;
      return;
    }
    if (who.userData?.skating && findSkateRiddenBy(who)) {
      exitSkateboard(who);
      statusEl.textContent = `${name}: kaykaydan indi`;
      return;
    }
    if (who.userData?.driving && findVehicleDrivenBy(who)) {
      exitVehicle(who);
      statusEl.textContent = `${name}: araçtan indi`;
      return;
    }
    clearNpcScriptMoves(who);
    if (who.userData?.busy === "jump") finishNpcJump(who);
    if (who.userData?.dancing || who.userData?.animName === "dance") {
      await setCharacterDancing(who, false);
    }
    if (who.userData?.sitting || /\/states\/sit/i.test(who.userData?.path || "")) {
      await setCharacterSitPose(who, false);
    } else {
      statusEl.textContent = `${name}: stop`;
    }
    return;
  }

  // /R3  /NE2  /w 10 — other scenes: distance units; red_light: seconds walking
  const m = lower.match(
    /^\/(n|s|e|w|r|l|ne|nw|se|sw|n-e|n-w|s-e|s-w)\s*(\d+(?:\.\d+)?)\s*$/i,
  );
    if (m) {
    if (tdLocked) {
      statusEl.textContent =
        "doğrulukmu — yerinde kal · yazı /dance /jump /sit /stop";
      return;
    }
    const dirName = parseChatDirToken(m[1]);
    const birim = Number(m[2]);
    if (!dirName || !Number.isFinite(birim) || birim <= 0) {
      statusEl.textContent = isRedLightScene()
        ? "Komut: /N3 = 3 sn yürü · /stop"
        : "Komut: /play /R3 /N2 · /dance /jump /sit /stop";
      return;
    }
    const vec = FACE_VEC[dirName];
    if (!vec) {
      statusEl.textContent = "Bilinmeyen yön";
      return;
    }
    const rl = isRedLightScene();
    // red_light: Main full walk; NPCs keep quarter pace
    const walkSpd =
      TRUTH_DARE_WALK_SPEED * (rl && !isPlayer ? 0.25 : 1);
    // red_light: number = seconds → distance = speed × time
    const dist = rl ? walkSpd * birim : birim * CHAT_MOVE_UNIT;
    const [dx, dz] = vec;
    const moveLabel = rl
      ? `${name}: ${dirName} ${birim}s`
      : `${name}: ${dirName} × ${birim}`;
    if (isPlayer) {
      if (player.driving) {
        statusEl.textContent = "Araçtayken yürüme komutu yok";
        return;
      }
      player.startScriptMove(dx, dz, dist, walkSpd, { anim: "walk" });
      statusEl.textContent = moveLabel;
      return;
    }
    who.userData.dir = dirName;
    if (who.userData.driving) {
      if (rl) {
        statusEl.textContent = "Red light — sadece yürüme";
        return;
      }
      const veh = findVehicleDrivenBy(who);
      if (veh) applyFacing(veh, dirName);
      enqueueNpcWalk(who, dx, dz, dist, 180);
      statusEl.textContent = `${name}: sürüş ${dirName} × ${birim}`;
      return;
    }
    applyFacing(who, dirName);
    if (who.userData.sitting || /\/states\/sit/i.test(who.userData.path || "")) {
      await setCharacterSitPose(who, false);
    }
    who.userData.dancing = false;
    if (!who.userData.skating) {
      await attachWalk(who, who.userData.path, dirName, { allowSouthFallback: true });
    }
    enqueueNpcWalk(
      who,
      dx,
      dz,
      dist,
      who.userData.skating && !rl ? 200 : walkSpd,
    );
    statusEl.textContent = moveLabel;
    return;
  }

  statusEl.textContent =
    "Komut: /play /R3 /dance /jump /sit /e /stop (büyük/küçük harf OK)";
}

function dismissChatKeyboard() {
  if (!chatInput) return;
  chatInput.blur();
  chatKeyboardOpen = false;
  if (shellBeforeKeyboard) {
    applyAppShellSize(shellBeforeKeyboard.w, shellBeforeKeyboard.h);
  } else {
    lockAppShell({ force: true });
  }
  shellBeforeKeyboard = null;
  requestAnimationFrame(() => resize());
}

function sendChatMessage() {
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;
  const who = chatSpeaker();
  if (!who) return;

  if (text.startsWith("/")) {
    chatInput.value = "";
    handleChatCommand(text).catch((err) => {
      console.warn(err);
      statusEl.textContent = err.message || String(err);
    });
    if (window.matchMedia?.("(pointer: coarse)")?.matches) dismissChatKeyboard();
    return;
  }

  const msg = text.slice(0, CHAT_MSG_MAX);
  speakAs(who, msg);
  chatInput.value = "";
  statusEl.textContent =
    who === player?.mesh
      ? `${PLAYER_CHAT_NAME}: ${msg}`
      : `${shortCharacterName(who.userData?.label, who.userData?.path)}: ${msg}`;
  if (window.matchMedia?.("(pointer: coarse)")?.matches) dismissChatKeyboard();
}

/** Match sprite depth: higher world Z = closer to camera / more “in front”. */
function worldLabelStackOrder(obj) {
  const z = obj?.position?.z ?? 0;
  // Keep within a safe CSS z-index range; bubble slightly above that name
  return Math.max(1, Math.round(z * 10) + 1000);
}

function placeWorldLabel(entry, obj, scr) {
  entry.root.classList.remove("hidden");
  entry.root.style.left = `${scr.sx}px`;
  entry.root.style.top = `${scr.sy}px`;
  const s = Number.isFinite(scr.scale) ? scr.scale : 1;
  entry.root.style.transform = `translate(-50%, -100%) scale(${s})`;
  const base = worldLabelStackOrder(obj);
  const talking = entry.hideAt && performance.now() < entry.hideAt;
  entry.root.style.zIndex = String(talking ? base + 1 : base);
}

function syncWorldLabels() {
  if (!worldLabelsRoot) return;
  const now = performance.now();
  const live = new Set();

  if (player?.mesh && player.mesh.visible !== false && !player.driving) {
    const key = "player";
    live.add(key);
    const entry = ensureWorldLabel(key, PLAYER_CHAT_NAME);
    entry.obj = player.mesh;
    const scr = projectHeadScreen(player.mesh);
    if (!scr) {
      entry.root.classList.add("hidden");
    } else {
      placeWorldLabel(entry, player.mesh, scr);
    }
    if (entry.hideAt && now >= entry.hideAt) {
      entry.bubbleEl.classList.add("hidden");
      entry.bubbleEl.textContent = "";
      entry.hideAt = 0;
    }
  }

  for (const obj of pickables) {
    if (obj.userData?.kind !== "character") continue;
    if (obj.visible === false) continue;
    const key = labelKeyFor(obj);
    if (!key) continue;
    live.add(key);
    const name = shortCharacterName(obj.userData?.label, obj.userData?.path);
    const entry = ensureWorldLabel(key, name, obj.userData?.path);
    entry.obj = obj;
    const scr = projectHeadScreen(obj);
    if (!scr) {
      entry.root.classList.add("hidden");
    } else {
      placeWorldLabel(entry, obj, scr);
    }
    if (entry.hideAt && now >= entry.hideAt) {
      entry.bubbleEl.classList.add("hidden");
      entry.bubbleEl.textContent = "";
      entry.hideAt = 0;
    }
  }

  // dog_3 bubble: /play hint, Yerlerinize, or countdown
  if (isRedLightScene()) {
    const dog = findRedLightCounterDog();
    if (dog) {
      const key = labelKeyFor(dog);
      if (key) {
        live.add(key);
        redLightGame.dogKey = key;
        const entry = ensureWorldLabel(key, " ", dog.userData?.path);
        entry.root.classList.add("rl-dog-label");
        entry.nameEl.textContent = "";
        entry.nameEl.classList.add("hidden");
        entry.bubbleEl.classList.add("rl-countdown");
        entry.obj = dog;
        const scr = projectHeadScreen(dog);
        if (!scr) {
          entry.root.classList.add("hidden");
        } else {
          // Don't shrink with tiny 32px dog sprite — keep ~20px readable
          placeWorldLabel(entry, dog, { ...scr, scale: 1 });
        }
        // Sticky /play while waiting — don't let hideAt clear it
        const waitingPlay =
          !redLightGame.active && !redLightGame.pendingStart;
        if (waitingPlay) {
          if (
            entry.bubbleEl.classList.contains("hidden") ||
            entry.bubbleEl.textContent !== "/play"
          ) {
            entry.bubbleEl.textContent = "/play";
            entry.bubbleEl.classList.remove("hidden");
          }
          entry.hideAt = now + 60000;
        } else if (entry.hideAt && now >= entry.hideAt) {
          entry.bubbleEl.classList.add("hidden");
          entry.bubbleEl.textContent = "";
          entry.hideAt = 0;
        }
      }
    }
  }

  for (const key of [...worldLabelMap.keys()]) {
    if (!live.has(key)) removeWorldLabel(key);
  }
}

chatSendBtn?.addEventListener("click", () => sendChatMessage());
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    sendChatMessage();
  } else if (e.key === "Escape") {
    e.preventDefault();
    dismissChatKeyboard();
  }
});
chatInput?.addEventListener("focus", () => {
  player?.keys?.clear?.();
  // Freeze current shell BEFORE keyboard / iOS zoom mutates viewport
  lockAppShell({ force: true });
  shellBeforeKeyboard = { w: lockedShell.w, h: lockedShell.h };
  chatKeyboardOpen = true;
});
chatInput?.addEventListener("blur", () => {
  // Wait for keyboard close / zoom-out, then restore pre-focus shell exactly
  setTimeout(() => {
    if (document.activeElement === chatInput) return;
    chatKeyboardOpen = false;
    if (shellBeforeKeyboard) {
      applyAppShellSize(shellBeforeKeyboard.w, shellBeforeKeyboard.h);
    } else {
      lockAppShell({ force: true });
    }
    shellBeforeKeyboard = null;
    resize();
  }, 280);
});

document.getElementById("chat-cmds")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cmd]");
  if (!btn || !chatInput) return;
  const cmd = btn.getAttribute("data-cmd");
  if (!cmd) return;
  e.preventDefault();
  chatInput.value = cmd;
  sendChatMessage();
});

function enterVehicle(veh, rider = player?.mesh) {
  if (!veh || !rider || veh.userData?.driver || veh === occupiedVehicle) return false;
  const isMain = rider === player?.mesh;
  if (isMain) {
    if (!player || player.driving || player.skating) return false;
    occupiedVehicle = veh;
    nearbyVehicle = null;
    player.driving = true;
    player.setVisible(false);
    if (companion) companion.visible = false;
  } else {
    if (rider.userData?.driving || rider.userData?.skating) return false;
    clearNpcScriptMoves(rider);
    rider.userData.driving = true;
    rider.userData.skating = false;
    rider.userData.dancing = false;
    rider.userData.sitting = false;
    rider.visible = false;
  }
  veh.userData.driver = rider;
  veh.userData._solidBeforeDrive = !!veh.userData.solid;
  veh.userData.solid = false;
  veh.userData.occupied = true;
  if (selected === veh) selectObject(null);
  hidePrompt();
  statusEl.textContent = isMain ? "Araçtasın" : "Karakter araca bindi";
  return true;
}

function exitVehicle(rider = player?.mesh) {
  if (!rider) return false;
  const veh = findVehicleDrivenBy(rider);
  if (!veh) return false;
  const isMain = rider === player?.mesh;

  // Place outside the vehicle footprint — old fixed 48px landed inside big car AABBs.
  const box = footprintOf(veh);
  const pr = isMain ? player.radius || 22 : NPC_WALK_RADIUS;
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
      if (circleHitsAabb(x, z, pr, box)) continue;
      const blocked = isMain
        ? playerFeetCollidesAtMesh(x, z, pr)
        : actorBlocked(rider, x, z + FEET_NUDGE_Z, pr);
      if (blocked) continue;
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

  rider.position.set(spot.x, 0, spot.z);
  if (isMain) {
    player.syncRing(spot.x, spot.z);
    player.driving = false;
    player.setVisible(true);
    if (companion) {
      companion.visible = true;
      companion.position.set(spot.x - 28, 0, spot.z - 28);
      syncDepth(companion);
    }
    occupiedVehicle = null;
    if (player.syncDepth) player.syncDepth(player.mesh);
  } else {
    rider.userData.driving = false;
    rider.visible = true;
    syncDepth(rider);
  }
  veh.userData.solid = veh.userData._solidBeforeDrive !== false;
  veh.userData.occupied = false;
  veh.userData.driver = null;
  hidePrompt();
  statusEl.textContent = "Hazır";
  return true;
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

function isInteriorPath(path) {
  return /\/interiors\//i.test(path || "");
}

/** Object-tied walkable polygon (night_club / stadium / tennis court). Street uses sceneWalkZone. */
function hasEditableCollision(path) {
  return /night_club_inside|footballstadium|tenniscourt/i.test(path || "");
}

function defaultColData() {
  return {
    enabled: false,
    // Default rectangle in sprite fractions (relative to object foot)
    pts: [
      { fx: -0.42, fz: -0.45 },
      { fx: 0.42, fz: -0.45 },
      { fx: 0.42, fz: 0.12 },
      { fx: -0.42, fz: 0.12 },
    ],
  };
}

/** Street scene: one shared walkable polygon (world XZ). Balls/skate ignore it. */
/** @type {{ enabled: boolean, pts: [number, number][] }} */
let sceneWalkZone = {
  enabled: false,
  pts: [],
};

const _walkRay = new THREE.Raycaster();
const _walkNdc = new THREE.Vector2();
const _walkHit = new THREE.Vector3();

/** Ground XZ under a canvas UV (0..1). */
function groundAtCanvasUv(u, v) {
  if (!renderer?.domElement) return null;
  _walkNdc.set(u * 2 - 1, -(v * 2 - 1));
  _walkRay.setFromCamera(_walkNdc, camera);
  return _walkRay.ray.intersectPlane(groundPlane, _walkHit)
    ? [_walkHit.x, _walkHit.z]
    : null;
}

/** Rectangle inset inside the current camera view (handles stay clickable). */
function streetWalkPtsFromView(inset = 0.12) {
  const a = inset;
  const b = 1 - inset;
  const corners = [
    groundAtCanvasUv(a, a),
    groundAtCanvasUv(b, a),
    groundAtCanvasUv(b, b),
    groundAtCanvasUv(a, b),
  ];
  if (corners.every(Boolean)) return corners;
  // Fallback around player / gather if unproject fails
  const cx = player?.mesh?.position.x ?? streetGatherTarget.x ?? 0;
  const cz = player?.mesh?.position.z ?? streetGatherTarget.z ?? 88;
  const hw = 160;
  const hd = 140;
  return [
    [cx - hw, cz - hd],
    [cx + hw, cz - hd],
    [cx + hw, cz + hd],
    [cx - hw, cz + hd],
  ];
}

function defaultStreetWalkPts() {
  return streetWalkPtsFromView(0.14);
}

function fitStreetWalkToView() {
  sceneWalkZone.pts = streetWalkPtsFromView(0.14);
  updateStreetWalkGizmo();
  schedulePersistScene();
  statusEl.textContent = "Street alan görünüme sığdırıldı — köşeleri sürükle";
}

function ensureStreetWalkZone() {
  if (!Array.isArray(sceneWalkZone.pts) || sceneWalkZone.pts.length < 3) {
    sceneWalkZone.pts = defaultStreetWalkPts();
  }
  return sceneWalkZone;
}

function streetWalkActive() {
  return isWalkZoneScene() && !!ensureStreetWalkZone().enabled;
}

/** Checkbox: show edit gizmo only — does not turn collision on/off. */
let streetWalkEditOpen = false;
/** Night club walk poly outline show/hide (collision stays as col.enabled). */
let nightClubColVisible = false;

/** True if most zone corners project off the canvas (can't grab handles). */
function streetWalkHandlesOffscreen() {
  const z = ensureStreetWalkZone();
  if (!z.pts?.length || !renderer?.domElement) return false;
  camera.updateMatrixWorld(true);
  let off = 0;
  const _p = new THREE.Vector3();
  for (const [x, zz] of z.pts) {
    _p.set(x, 0, zz).project(camera);
    if (Math.abs(_p.x) > 0.98 || Math.abs(_p.y) > 0.98) off += 1;
  }
  return off >= Math.ceil(z.pts.length * 0.5);
}

function ensureColData(obj) {
  const d = obj?.userData;
  if (!d) return defaultColData();
  if (!d.col) d.col = defaultColData();
  const col = d.col;
  if (!Array.isArray(col.pts) || col.pts.length < 3) {
    col.pts = defaultColData().pts.map((p) => ({ ...p }));
  }
  return col;
}

function insertColPtOnEdge(obj, edgeIndex, wx, wz) {
  const col = ensureColData(obj);
  if (col.pts.length >= COL_MAX_PTS) return -1;
  const { w, h } = colSpriteSize(obj);
  if (!w || !h) return -1;
  const pt = {
    fx: (wx - obj.position.x) / w,
    fz: (wz - obj.position.z) / h,
  };
  col.pts.splice(edgeIndex + 1, 0, pt);
  return edgeIndex + 1;
}

function removeColPt(obj, index) {
  const col = ensureColData(obj);
  if (col.pts.length <= 3) return false;
  if (index < 0 || index >= col.pts.length) return false;
  col.pts.splice(index, 1);
  return true;
}

function syncColSolid(obj) {
  if (!obj?.userData || !hasEditableCollision(obj.userData.path)) return;
  ensureColData(obj);
  obj.userData.solid = false;
}

function colSpriteSize(obj) {
  const d = obj.userData || {};
  return {
    w: (d.w || 32) * (d.scale || 1),
    h: (d.h || 32) * (d.scale || 1),
  };
}

/** 4 world XZ corners from stored fraction points. */
function getColWorldPts(obj) {
  const col = ensureColData(obj);
  const { w, h } = colSpriteSize(obj);
  return col.pts.map((p) => [
    obj.position.x + (Number(p.fx) || 0) * w,
    obj.position.z + (Number(p.fz) || 0) * h,
  ]);
}

function setColWorldPt(obj, index, wx, wz) {
  const col = ensureColData(obj);
  const { w, h } = colSpriteSize(obj);
  if (!w || !h) return;
  col.pts[index] = {
    fx: (wx - obj.position.x) / w,
    fz: (wz - obj.position.z) / h,
  };
}

function resetColPts(obj) {
  const col = ensureColData(obj);
  col.pts = defaultColData().pts.map((p) => ({ ...p }));
}

function colFootprint(obj) {
  if (!obj?.userData?.col || !hasEditableCollision(obj.userData.path)) return null;
  return { kind: "poly", pts: getColWorldPts(obj) };
}

function pointInPoly(px, pz, pts) {
  // ray cast
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    const hit =
      zi > pz !== zj > pz &&
      px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz || 1e-12;
  let t = (apx * abx + apz * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + abx * t;
  const qz = az + abz * t;
  return Math.hypot(px - qx, pz - qz);
}

function distToPolyEdge(px, pz, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    best = Math.min(best, distToSegment(px, pz, ax, az, bx, bz));
  }
  return best;
}

function pointInCol(px, pz, box, inset = 0) {
  if (!box?.pts?.length) return false;
  if (!pointInPoly(px, pz, box.pts)) return false;
  if (inset <= 0) return true;
  return distToPolyEdge(px, pz, box.pts) >= inset;
}

/**
 * Walkable-zone: destination must stay inside (street / red_light).
 * Balls are clamped in physics; night_club uses object col polys.
 */
function containmentBlocksFor(fromX, fromZ, px, pz, radius) {
  const r = Math.max(0, radius || 0);
  if (streetWalkActive()) {
    const pts = ensureStreetWalkZone().pts;
    if (pts?.length) {
      // Always require feet to remain inside — no leaving the play area
      if (!pointInPoly(px, pz, pts)) return true;
      if (r > 0 && distToPolyEdge(px, pz, pts) < r * 0.35) return true;
    }
  }
  for (const obj of pickables) {
    const col = obj.userData?.col;
    if (!col?.enabled || !hasEditableCollision(obj.userData?.path)) continue;
    const box = colFootprint(obj);
    if (!box) continue;
    if (!pointInCol(fromX, fromZ, box, 0)) continue;
    if (!pointInCol(px, pz, box, r)) return true;
  }
  return false;
}

/** Pull a world XZ point back inside the active walk zone. */
function projectIntoWalkZone(x, z, radius = 0) {
  if (!streetWalkActive()) return { x, z };
  const pts = ensureStreetWalkZone().pts;
  if (!pts?.length) return { x, z };
  const inset = Math.max(2, radius * 0.35);
  if (pointInPoly(x, z, pts) && distToPolyEdge(x, z, pts) >= inset) {
    return { x, z };
  }
  const hit = closestPolyEdgeHit(x, z, pts);
  if (!hit) return { x, z };
  // hit.nx is outward → step inward
  return { x: hit.qx - hit.nx * inset, z: hit.qz - hit.nz * inset };
}

function containmentBlocks(px, pz, radius) {
  if (!player?.mesh) return false;
  const cx = player.mesh.position.x;
  const cz = player.mesh.position.z + FEET_NUDGE_Z;
  return containmentBlocksFor(cx, cz, px, pz, radius);
}

/** Same blockers Main uses — solids, rooms, 9:16 frame, other cast. */
function actorBlocked(obj, px, pz, radius) {
  const r = radius || NPC_WALK_RADIUS;
  const fromX = obj.position.x;
  const fromZ = obj.position.z + FEET_NUDGE_Z;
  const formation = !!obj?.userData?.formationMove;
  const elimRun = !!obj?.userData?.redLightEliminating;
  // Entrance / DQ corner run: ignore walk-zone / frame / cast so they don't jam
  if (
    elimRun ||
    (formation &&
      ((isNightClubScene() && obj.userData?.crowdExtra) || isRedLightScene()))
  ) {
    return solidBlocked(px, pz, r);
  }
  // Truth-dare / street formation: still skip other cast so rows don't stall
  // red_light: soft-push only (no hard character block)
  return (
    solidBlocked(px, pz, r) ||
    containmentBlocksFor(fromX, fromZ, px, pz, r) ||
    viewBoundsBlock(px, pz, r) ||
    (!formation &&
      !charsCanPushEachOther() &&
      characterBlocked(px, pz, Math.max(r * 0.7, CHAR_SEP_MIN * 0.85), obj))
  );
}

const _viewClampA = new THREE.Vector3();
const _viewClampB = new THREE.Vector3();

/**
 * 9:16 uses a fixed camera — block walking past the visible frame
 * (feet + approx head so the sprite doesn't clip off-screen).
 */
function viewBoundsBlock(px, pz, radius = 22) {
  if (viewportMode !== "9x16") return false;
  camera.updateMatrixWorld(true);
  const edge = 0.92;
  const pad = Math.max(8, radius * 0.35);
  // Sample a few points around the feet + head height along camera-up
  _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const samples = [
    [px, pz],
    [px + pad, pz],
    [px - pad, pz],
    [px, pz + pad],
    [px, pz - pad],
  ];
  for (const [sx, sz] of samples) {
    _viewClampA.set(sx, 0, sz).project(camera);
    if (Math.abs(_viewClampA.x) > edge || Math.abs(_viewClampA.y) > edge) {
      return true;
    }
    _viewClampB.set(sx, 0, sz).addScaledVector(_camUp, 78).project(camera);
    if (Math.abs(_viewClampB.x) > edge || Math.abs(_viewClampB.y) > edge) {
      return true;
    }
  }
  return false;
}

/** Soft personal space at feet — stops cast stacking on the same pixel. */
const CHAR_SEP_MIN = 30;
const CHAR_SEP_PUSH = 70;
/** red_light / football / tennis: no hard char-block — movers shove via soft-sep. */
function charsCanPushEachOther(id = activeSceneId) {
  return isRedLightScene(id) || isPlayfieldScene(id);
}

function isSeparableCharacter(obj) {
  if (!obj?.visible || obj.visible === false) return false;
  // DQ corner sprint — ghost through other cast (no soft-sep bump)
  if (obj.userData?.redLightEliminating) return false;
  // Night club crowd only — dense enter/pack; street / doğrulukmu keep soft-sep
  if (obj.userData?.crowdExtra && isNightClubScene()) return false;
  if (obj === player?.mesh) return !occupiedVehicle;
  return obj.userData?.kind === "character" && obj.userData?.editable !== false;
}

function listSeparableCharacters() {
  const out = [];
  if (player?.mesh && isSeparableCharacter(player.mesh)) out.push(player.mesh);
  for (const obj of pickables) {
    if (obj === player?.mesh) continue;
    if (isSeparableCharacter(obj)) out.push(obj);
  }
  return out;
}

/** Another cast member's feet too close to (px,pz)? */
function characterBlocked(px, pz, radius, exceptObj = null) {
  const need = radius > 0 ? radius : CHAR_SEP_MIN;
  for (const obj of listSeparableCharacters()) {
    if (obj === exceptObj) continue;
    if (dragging && obj === dragging) continue;
    // Night club crowd only — don't block peers at the gate
    if (obj.userData?.crowdExtra && isNightClubScene()) continue;
    const ox = obj.position.x;
    const oz = obj.position.z + FEET_NUDGE_Z;
    const dx = px - ox;
    const dz = pz - oz;
    if (dx * dx + dz * dz < need * need) return true;
  }
  return false;
}

function trySepMove(obj, dx, dz) {
  if (!obj || (!dx && !dz)) return;
  const x0 = obj.position.x;
  const z0 = obj.position.z;
  const nx = x0 + dx;
  const nz = z0 + dz;
  const r = obj === player?.mesh ? player.radius || 22 : NPC_WALK_RADIUS;
  const feet = (x, z) => ({ x, z: z + FEET_NUDGE_Z });
  const blocked = (x, z) =>
    solidBlocked(x, z, r) ||
    containmentBlocksFor(feet(x0, z0).x, feet(x0, z0).z, x, z, r);
  if (dx && !blocked(nx, z0 + FEET_NUDGE_Z)) obj.position.x = nx;
  if (dz && !blocked(obj.position.x, nz + FEET_NUDGE_Z)) {
    obj.position.z = nz;
  }
  if (obj.position.x !== x0 || obj.position.z !== z0) {
    syncDepth(obj);
    if (obj === player?.mesh) player.syncRing?.();
  }
}

function actorMoveSpeed(obj) {
  if (obj === player?.mesh) {
    return Math.hypot(player?.vx || 0, player?.vz || 0);
  }
  return Math.hypot(obj.userData?._moveDx || 0, obj.userData?._moveDz || 0);
}

/** Gentle push-apart so sprites don't fully overlap. */
function tickCharacterSeparation(dt) {
  // Pin truth-dare row/seat slots so soft-sep can't shove someone forward
  for (const o of listSeparableCharacters()) {
    const slot = o.userData?.formationSlot;
    if (!slot || o.userData?.formationMove) continue;
    if (Math.hypot(o.position.x - slot.x, o.position.z - slot.z) > 0.5) {
      o.position.x = slot.x;
      o.position.z = slot.z;
      syncDepth(o);
      if (o === player?.mesh) player.syncRing?.(slot.x, slot.z);
    }
  }
  const pushMode = charsCanPushEachOther();
  const sepMin = pushMode ? 36 : CHAR_SEP_MIN;
  const sepPush = pushMode ? CHAR_SEP_PUSH * 2.2 : CHAR_SEP_PUSH;
  const actors = listSeparableCharacters().filter(
    (o) => o !== dragging && !o.userData?.formationSlot && !o.userData?.formationMove,
  );
  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i];
      const b = actors[j];
      const ax = a.position.x;
      const az = a.position.z + FEET_NUDGE_Z;
      const bx = b.position.x;
      const bz = b.position.z + FEET_NUDGE_Z;
      let dx = bx - ax;
      let dz = bz - az;
      let dist = Math.hypot(dx, dz);
      if (dist >= sepMin) continue;
      if (dist < 0.05) {
        const ang = (i * 1.7 + j * 2.3) % (Math.PI * 2);
        dx = Math.cos(ang);
        dz = Math.sin(ang);
        dist = 0.05;
      }
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = sepMin - dist;
      const push = Math.min(overlap * (pushMode ? 0.85 : 0.6), sepPush * dt);
      const aPlayer = a === player?.mesh;
      const bPlayer = b === player?.mesh;
      let pushA = push;
      let pushB = push;
      if (pushMode) {
        // Mover shoves the other more; both can still give way
        const aSp = actorMoveSpeed(a);
        const bSp = actorMoveSpeed(b);
        if (aSp > 0.4 && aSp >= bSp * 0.8) {
          pushA = push * 0.25;
          pushB = push * 1.15;
        } else if (bSp > 0.4 && bSp >= aSp * 0.8) {
          pushB = push * 0.25;
          pushA = push * 1.15;
        }
      } else if (aPlayer && !bPlayer) {
        // Prefer sliding NPCs; nudge Main only lightly
        pushA = push * 0.2;
        pushB = push * 0.95;
      } else if (bPlayer && !aPlayer) {
        pushB = push * 0.2;
        pushA = push * 0.95;
      }
      trySepMove(a, -nx * pushA, -nz * pushA);
      trySepMove(b, nx * pushB, nz * pushB);
    }
  }
}

/** px/pz = feet world position (mesh.z + FEET_NUDGE_Z). */
function playerCollides(px, pz, radius) {
  const forming = !!player?.mesh?.userData?.formationMove;
  const elimRun = !!player?.mesh?.userData?.redLightEliminating;
  const skipChar = forming || elimRun || charsCanPushEachOther();
  // Red light entrance / DQ run: don't freeze Main on walk-zone edge or cast
  if ((forming || elimRun) && isRedLightScene()) {
    return solidBlocked(px, pz, radius);
  }
  return (
    solidBlocked(px, pz, radius) ||
    containmentBlocks(px, pz, radius) ||
    viewBoundsBlock(px, pz, radius) ||
    (!skipChar &&
      characterBlocked(
        px,
        pz,
        Math.max(radius * 0.7, CHAR_SEP_MIN * 0.85),
        player?.mesh,
      ))
  );
}

function playerFeetCollidesAtMesh(mx, mz, radius) {
  return playerCollides(mx, mz + FEET_NUDGE_Z, radius);
}

/** Buildings / vehicles / props block; interiors are walk-in rooms; roads/animals/balls/boards don't. */
function isSolidItem(item) {
  if (!item || item.kind === "character") return false;
  const p = item.path || "";
  if (usesGroundPlane(item) || /\/props\/road\//i.test(p)) return false;
  if (isInteriorPath(p)) return false; // cutaway rooms — walk onto the floor
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
  if (/\/buildings\//i.test(p) || /\/vehicles\//i.test(p) || isInteriorPath(p)) {
    return false;
  }
  if (/\/props\/road|\/props\/ground|\/balls\/|smallAnimals/i.test(p)) return false;
  // Trees block; don't vault over canopy — only low park props
  if (/\/tree\//i.test(p)) return false;
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

function solidBlockedExcept(px, pz, radius, except, { physics = false } = {}) {
  if (!physics && streetWalkActive()) return false;
  for (const obj of pickables) {
    if (obj === except) continue;
    if (!obj.userData?.solid) continue;
    if (obj.userData.skateboard || isSkateboardPath(obj.userData.path)) continue;
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
  const pz = player.mesh.position.z + FEET_NUDGE_Z;
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
  if (solidBlockedExcept(landX, landZ + FEET_NUDGE_Z, pr, best)) {
    // try a bit further
    const landX2 = box.x + fx * clear * 1.35;
    const landZ2 = box.z + fz * clear * 1.35;
    if (solidBlockedExcept(landX2, landZ2 + FEET_NUDGE_Z, pr, best)) return null;
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
  let cx = obj.position.x;
  let cz = obj.position.z;
  if (/\/buildings\//i.test(p)) {
    // Sprite foot is at the south (bottom) of the art — centered AABB stuck out too far in front.
    hw = w * 0.3;
    hd = w * 0.15;
    cz -= hd * 0.65; // shift north so less collision hangs under the facade
  } else if (/\/tree\//i.test(p) || /outdoorPark\/tree/i.test(p)) {
    // Tall billboard: collide only with the trunk near the feet, not the canopy
    hw = Math.max(11, w * 0.11);
    hd = Math.max(10, w * 0.09);
  } else if (isInteriorPath(p)) {
    // unused for collision (interiors are non-solid); kept for selection/overlap helpers
    hw = w * 0.42;
    hd = h * 0.36;
  } else {
    hw = w * 0.28;
    hd = Math.max(w * 0.2, h * 0.18);
  }
  return { kind: "aabb", x: cx, z: cz, hw, hd };
}

function circleHitsAabb(px, pz, radius, box) {
  if (box.kind === "poly" && box.pts?.length) {
    if (pointInPoly(px, pz, box.pts)) return true;
    return distToPolyEdge(px, pz, box.pts) < radius;
  }
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
  if (box.kind === "poly" && box.pts?.length) {
    if (pointInPoly(px, pz, box.pts)) return 0;
    return distToPolyEdge(px, pz, box.pts);
  }
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

/**
 * Prop/building solids. On street with walk-zone on: characters ignore these
 * (only the zone matters). Balls/skate keep physics via { physics: true }.
 */
function solidBlocked(px, pz, radius, { physics = false } = {}) {
  if (!physics && streetWalkActive()) return false;
  for (const obj of pickables) {
    if (!obj.userData?.solid) continue;
    // Skateboards never solid-block characters
    if (obj.userData.skateboard || isSkateboardPath(obj.userData.path)) continue;
    if (circleHitsAabb(px, pz, radius, footprintOf(obj))) return true;
  }
  return false;
}

function wantsIdle(item) {
  return (
    item.kind === "character" ||
    isAnimalPath(item.path) ||
    isInteriorPath(item.path)
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

/** Bump so in-flight attachRun/Walk/Idle can't overwrite a newer pose. */
function nextCharacterAnimToken(obj) {
  if (!obj?.userData) return 0;
  obj.userData._animSeq = (obj.userData._animSeq || 0) + 1;
  return obj.userData._animSeq;
}

function isCharacterAnimToken(obj, token) {
  return !!obj?.userData && obj.userData._animSeq === token;
}

/** Stop gait immediately; async idle/sit must still be started by caller. */
function stopCharacterGait(obj) {
  if (!obj?.userData) return;
  nextCharacterAnimToken(obj);
  const name = obj.userData.animName;
  if (name === "run" || name === "walk") {
    obj.userData.animName = null;
    obj.userData.anim = null;
  }
}

async function attachIdle(obj, path, dir, { allowSouthFallback = true } = {}) {
  const token = nextCharacterAnimToken(obj);
  const slug = obj.userData.idleSlug || (await resolveIdleSlug(path));
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!slug) return false;
  obj.userData.idleSlug = slug;
  let frames = await loadAnimFrames(path, slug, dir);
  // Don't silently keep playing south idle for other facings when that dir has no clip —
  // caller can show the static rotation instead.
  if (!frames.length && allowSouthFallback && dir !== "south") {
    frames = await loadAnimFrames(path, slug, "south");
  }
  if (!frames.length) {
    frames = await loadAnimFrames(path, slug, "unknown");
  }
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!frames.length) return false;
  obj.userData.animName = "idle";
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

async function resolveDanceSlug(path) {
  let candidates = [];
  try {
    const meta = await fetch(assetUrl(`${path}/meta.json`)).then((r) => r.json());
    candidates = meta.animations || [];
  } catch {
    /* no meta */
  }
  if (!candidates.length) {
    candidates = await listAnimSlugs(path);
  }
  // Prefer exact "dance", then custom-dancing / any *danc* slug
  return (
    candidates.find((a) => /^dance$/i.test(a)) ||
    candidates.find((a) => /custom[-_]?danc/i.test(a)) ||
    candidates.find((a) => /danc/i.test(a)) ||
    null
  );
}

async function ensureDanceAvailable(obj) {
  if (!obj?.userData || obj.userData.kind !== "character") return false;
  // Re-probe if previously cached as missing (old resolver missed custom-dancing)
  if (obj.userData.danceSlug) return true;
  const slug = await resolveDanceSlug(obj.userData.path);
  obj.userData.danceSlug = slug;
  return !!slug;
}

async function attachDance(obj, path, dir, { allowSouthFallback = true } = {}) {
  const token = nextCharacterAnimToken(obj);
  const slug =
    obj.userData.danceSlug ||
    (await resolveDanceSlug(path)) ||
    null;
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!slug) return false;
  obj.userData.danceSlug = slug;
  let frames = await loadAnimFrames(path, slug, dir);
  if (!frames.length && allowSouthFallback && dir !== "south") {
    frames = await loadAnimFrames(path, slug, "south");
  }
  if (!frames.length) {
    frames = await loadAnimFrames(path, slug, "unknown");
  }
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!frames.length) return false;
  obj.userData.animName = "dance";
  obj.userData.dancing = true;
  obj.userData.anim = {
    frames,
    frame: 0,
    accum: 0,
    fps: 10,
    dir,
  };
  setMap(obj, frames[0]);
  return true;
}

async function setCharacterDancing(obj, on) {
  if (!obj?.userData || obj.userData.kind !== "character") return false;
  const dir = obj.userData.dir || "south";
  if (on) {
    const ok = await attachDance(obj, obj.userData.path, dir);
    if (!ok) {
      obj.userData.dancing = false;
      statusEl.textContent = "Bu karakterde dance yok";
      return false;
    }
    if (!sceneLoading) schedulePersistScene();
    statusEl.textContent = "Dans açık";
    return true;
  }
  obj.userData.dancing = false;
  await attachIdle(obj, obj.userData.path, dir, { allowSouthFallback: false });
  if (!sceneLoading) schedulePersistScene();
  statusEl.textContent = "Dans kapalı";
  return true;
}

async function resolveWalkSlug(path) {
  const listed = await listAnimSlugs(path);
  const hit =
    listed.find((a) => /^walk$/i.test(a)) ||
    listed.find((a) => /walk/i.test(a) && !/idle/i.test(a));
  if (hit) return hit;
  try {
    const meta = await fetch(assetUrl(`${path}/meta.json`)).then((r) => r.json());
    const anims = meta.animations || [];
    return (
      anims.find((a) => /^walk$/i.test(a)) ||
      anims.find((a) => /walk/i.test(a) && !/idle/i.test(a)) ||
      null
    );
  } catch {
    return null;
  }
}

/** Character walk loop (same pipeline as idle/dance). */
async function attachWalk(obj, path, dir, { allowSouthFallback = true } = {}) {
  const token = nextCharacterAnimToken(obj);
  const slug =
    obj.userData.walkSlug || (await resolveWalkSlug(path)) || "walk";
  if (!isCharacterAnimToken(obj, token)) return false;
  obj.userData.walkSlug = slug;
  let frames = await loadAnimFrames(path, slug, dir);
  if (!frames.length && allowSouthFallback && dir !== "south") {
    frames = await loadAnimFrames(path, slug, "south");
  }
  if (!frames.length) {
    frames = await loadAnimFrames(path, slug, "unknown");
  }
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!frames.length) return false;
  obj.userData.dancing = false;
  obj.userData.animName = "walk";
  obj.userData.anim = {
    frames,
    frame: 0,
    accum: 0,
    fps: isRedLightScene() ? 3.25 : 13,
    dir,
  };
  setMap(obj, frames[0]);
  return true;
}

async function resolveRunSlug(path) {
  const listed = await listAnimSlugs(path);
  const hit =
    listed.find((a) => /^run$/i.test(a)) ||
    listed.find((a) => /run/i.test(a) && !/idle/i.test(a));
  if (hit) return hit;
  try {
    const meta = await fetch(assetUrl(`${path}/meta.json`)).then((r) => r.json());
    const anims = meta.animations || [];
    return (
      anims.find((a) => /^run$/i.test(a)) ||
      anims.find((a) => /run/i.test(a)) ||
      null
    );
  } catch {
    return null;
  }
}

/** Character run loop — used when casting into truth-dare circle. */
async function attachRun(obj, path, dir, { allowSouthFallback = true } = {}) {
  // red_light: only used for cast entrance (scriptActorTo run:true)
  const token = nextCharacterAnimToken(obj);
  const slug = (await resolveRunSlug(path)) || "run";
  if (!isCharacterAnimToken(obj, token)) return false;
  let frames = await loadAnimFrames(path, slug, dir);
  if (!frames.length && allowSouthFallback && dir !== "south") {
    frames = await loadAnimFrames(path, slug, "south");
  }
  if (!frames.length) {
    frames = await loadAnimFrames(path, slug, "unknown");
  }
  if (!isCharacterAnimToken(obj, token)) return false;
  // Fallback to walk if this character has no run clip
  if (!frames.length) {
    return attachWalk(obj, path, dir, { allowSouthFallback });
  }
  obj.userData.dancing = false;
  obj.userData.animName = "run";
  obj.userData.anim = {
    frames,
    frame: 0,
    accum: 0,
    fps: 12,
    dir,
  };
  setMap(obj, frames[0]);
  return true;
}

async function resolveJumpSlug(path) {
  const listed = await listAnimSlugs(path);
  const hit =
    listed.find((a) => /^jump$/i.test(a)) ||
    listed.find((a) => /jump|two-footed-jump/i.test(a));
  if (hit) return hit;
  try {
    const meta = await fetch(assetUrl(`${path}/meta.json`)).then((r) => r.json());
    const anims = meta.animations || [];
    return (
      anims.find((a) => /^jump$/i.test(a)) ||
      anims.find((a) => /jump/i.test(a)) ||
      null
    );
  } catch {
    return null;
  }
}

/** One-shot jump for cast (other players) — same idea as Main startJump. */
async function attachJump(obj, path, dir, { allowSouthFallback = true } = {}) {
  if (isRedLightScene()) return false;
  if (!obj?.userData || obj.userData.kind !== "character") return false;
  if (obj.userData.driving || obj.userData.busy === "jump") return false;
  const token = nextCharacterAnimToken(obj);
  const slug = (await resolveJumpSlug(path)) || "jump";
  if (!isCharacterAnimToken(obj, token)) return false;
  let frames = await loadAnimFrames(path, slug, dir);
  if (!frames.length && allowSouthFallback && dir !== "south") {
    frames = await loadAnimFrames(path, slug, "south");
  }
  if (!frames.length) {
    frames = await loadAnimFrames(path, slug, "unknown");
  }
  if (!isCharacterAnimToken(obj, token)) return false;
  if (!frames.length) return false;
  clearNpcScriptMoves(obj);
  obj.userData.dancing = false;
  obj.userData.sitting = false;
  obj.userData.busy = "jump";
  obj.userData.ollieU = 0;
  obj.userData.animName = "jump";
  obj.userData.anim = {
    frames,
    frame: 0,
    accum: 0,
    fps: 14,
    dir,
    once: true,
  };
  setMap(obj, frames[0]);
  return true;
}

function finishNpcJump(obj) {
  if (!obj?.userData) return;
  obj.userData.busy = null;
  obj.userData.ollieU = 0;
  obj.position.y = 0;
  const dir = obj.userData.dir || "south";
  if (obj.userData.skating) {
    // stay on board — back to idle-ish walk frames if any; else idle
    attachIdle(obj, obj.userData.path, dir, { allowSouthFallback: true }).catch(
      () => {},
    );
    syncSkateboardUnderRider(obj);
  } else {
    attachIdle(obj, obj.userData.path, dir, { allowSouthFallback: true }).catch(
      () => {},
    );
  }
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
    disposePetColRing();
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
  const x = player.mesh.position.x + behind[0] * COMPANION_OFFSET;
  const z = player.mesh.position.z + behind[1] * COMPANION_OFFSET;
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
  syncPetColRing();
  statusEl.textContent = "Pet yanında";
}

function tickCompanions(dt) {
  // Only P-key companion follows — catalog animals stay where placed
  if (!companion || !player?.mesh) return;
  if (!pickables.includes(companion)) {
    companion = null;
    return;
  }
  // Hide with player while driving — don't keep walking beside the car
  if (occupiedVehicle) {
    companion.visible = false;
    if (petColRing) petColRing.visible = false;
    return;
  }
  if (!companion.visible) companion.visible = true;
  // Editor drag wins — don't yank the pet back while placing it
  if (dragging === companion) {
    syncPetColRing();
    return;
  }
  const follow = player.mesh;
  const px = follow.position.x;
  const pz = follow.position.z;
  const face = player.facing || "south";
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
  const tx = px + behind[0] * COMPANION_OFFSET;
  const tz = pz + behind[1] * COMPANION_OFFSET;
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
  const clamped = projectIntoWalkZone(
    companion.position.x,
    companion.position.z,
    PET_COL_RADIUS,
  );
  companion.position.x = clamped.x;
  companion.position.z = clamped.z;
  syncDepth(companion);
  syncPetColRing();
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
  const d = obj.userData;
  // Lock character/pet display size (Main uses fixed baseScale) so anim
  // frame swaps never resize the sprite.
  const lockSize =
    d.kind === "character" || d.companion || isAnimalPath(d.path || "");
  if (lockSize) {
    if (!d.baseW || !d.baseH) {
      d.baseW = tex.image.width;
      d.baseH = tex.image.height;
    }
    d.w = d.baseW;
    d.h = d.baseH;
  } else {
    d.w = tex.image.width;
    d.h = tex.image.height;
  }
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

async function setDirection(obj, dir, { recordUndo = true } = {}) {
  const d = obj.userData;
  if (!d.dirs?.includes(dir) && !d.rotTextures?.[dir]) return;
  const prevDir = d.dir;
  if (prevDir === dir) return;
  if (recordUndo && obj.userData?.editable) {
    pushUndo({
      undo() {
        setDirection(obj, prevDir, { recordUndo: false });
      },
    });
  }
  d.dir = dir;
  // Characters / pets: reload facing clip (keep dance if toggled on).
  if ((d.idleSlug || d.anim || d.kind === "character") && !d.vehicle && !d.ball) {
    if (d.kind === "character" && d.dancing) {
      const danced = await attachDance(obj, d.path, dir, { allowSouthFallback: false });
      if (danced) {
        schedulePersistScene();
        refreshInspector();
        return;
      }
      d.dancing = false;
    }
    const ok = await attachIdle(obj, d.path, dir, { allowSouthFallback: false });
    if (ok) {
      schedulePersistScene();
      refreshInspector();
      return;
    }
  }
  if (d.rotTextures?.[dir]) {
    d.anim = null; // stop south idle from overwriting the facing sprite
    setMap(obj, d.rotTextures[dir]);
    schedulePersistScene();
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

async function spawnItem(item, x, z, opts = {}) {
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
  const scale = opts.scale != null ? Number(opts.scale) : defaultScale(item);
  const w = tex.image.width;
  const h = tex.image.height;
  const tileable = isRoadTileItem(item);
  const baseTile = item.tileSize || w || 64;
  const tileSize = baseTile * scale;
  // exactPos / free drop: no grid snap (Shift+ok extend uses exactPos)
  const dir =
    (opts.dir && dirs.includes(opts.dir) && opts.dir) ||
    (dirs.includes("south") ? "south" : dirs[0] || "south");
  const userData = {
    kind: item.kind,
    catalogId: item.id,
    catalogKey: `${item.id}:${item.path}`,
    label: item.label,
    path: item.path,
      w,
      h,
      scale,
    dir,
    dirs,
    rotTextures,
    fallbackSouth: true,
    editable: opts.editable !== false,
    solid: isSolidItem(item),
    ball: isBallPath(item.path),
    vehicle: isVehiclePath(item.path),
    skateboard: isSkateboardPath(item.path),
    vaultable: isVaultablePath(item.path),
    tileable,
    baseTile,
    tileSize,
    traffic: !!opts.traffic,
  };
  if (opts.traffic) {
    userData.editable = false;
    userData.solid = true;
  }
  if (hasEditableCollision(item.path)) {
    userData.col = defaultColData();
    userData.solid = false;
  }
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
      side: THREE.DoubleSide, // reliable pick/drag under ortho camera
    });
    obj = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    obj.rotation.x = -Math.PI / 2;
    obj.position.set(x, 0.08, z);
    obj.scale.set(w * scale, h * scale, 1);
    userData.layer = "ground";
    userData.tileable = true;
  } else {
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
  });
    if (/\/buildings\//i.test(item.path || "")) patchBuildingSeeThrough(mat);
    obj = new THREE.Sprite(mat);
    obj.center.set(0.5, 0);
    obj.scale.set(w * scale, h * scale, 1);
    obj.position.set(x, 0, z);
    userData.layer = "sprite";
  }

  obj.userData = userData;
  if (item.kind === "character") {
    // Keep intended gather/home — not mid-entrance garage coords
    obj.userData.spawnX = x;
    obj.userData.spawnZ = z;
    // User-placed cast travels across scenes (not JSON props / traffic / loading)
    if (
      !sceneLoading &&
      !opts.traffic &&
      opts.editable !== false &&
      opts.partyMember !== false
    ) {
      obj.userData.partyMember = true;
    }
  }

  // Street cast: appear at post office first (never flash at click / screen center)
  const streetEntrance =
    isStreetLikeScene() &&
    item.kind === "character" &&
    !sceneLoading &&
    !opts.traffic &&
    opts.playEntrance !== false &&
    !!findScenePostOffice();
  if (streetEntrance) {
    const exit = postOfficeGarageExit(findScenePostOffice());
    obj.position.set(exit.x, 0, exit.z);
  }

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

  // Street: walk from garage → scene JSON player spot (not live Main)
  if (streetEntrance) {
    const home = streetGatherTarget;
    const ang = Math.random() * Math.PI * 2;
    const rad = 18 + Math.random() * 16;
    const slot = {
      x: home.x + Math.cos(ang) * rad,
      z: home.z + Math.sin(ang) * rad,
    };
    beginPostOfficeEntrance(obj, slot, { stagger: 0.15 });
    statusEl.textContent = "Postane garajından ortaya geliyor…";
  }

  // Red light: reject 11th+ character before select/undo
  if (
    isRedLightScene() &&
    item.kind === "character" &&
    !sceneLoading &&
    !opts.traffic &&
    opts.redLightLineup !== false &&
    countRedLightCast() > RED_LIGHT_CAST_MAX
  ) {
    detachPlacedObject(obj);
    disposePlacedObject(obj);
    statusEl.textContent = `Max ${RED_LIGHT_CAST_MAX} karakter`;
    return null;
  }

  if (opts.select !== false) selectObject(obj);
  if (opts.recordUndo !== false && !opts.traffic) pushSpawnUndo(obj);

  // Red light: re-line cast at south edge facing north
  if (
    isRedLightScene() &&
    item.kind === "character" &&
    !sceneLoading &&
    !opts.traffic &&
    opts.redLightLineup !== false
  ) {
    await setRedLightCastCount(countRedLightCast());
  } else if (!sceneLoading && !opts.traffic && opts.editable !== false) {
    schedulePersistScene();
  }
  if (
    obj?.userData?.partyMember &&
    partySnapshotEnabled &&
    !sceneLoading &&
    !opts.traffic
  ) {
    snapshotPartyFromWorld();
  }
  return obj;
}

function roundSceneNum(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(Number(n) * p) / p;
}

/** Snapshot night_club walkable polygon. */
function serializeCol(obj) {
  if (!hasEditableCollision(obj?.userData?.path)) return null;
  const col = ensureColData(obj);
  return {
    enabled: !!col.enabled,
    pts: (col.pts || []).map((p) => ({
      fx: roundSceneNum(p.fx, 4),
      fz: roundSceneNum(p.fz, 4),
    })),
  };
}

function applySerializedCol(obj, colData) {
  if (!obj || !colData || !hasEditableCollision(obj.userData?.path)) return;
  const pts = Array.isArray(colData.pts)
    ? colData.pts
        .filter((p) => p && Number.isFinite(Number(p.fx)) && Number.isFinite(Number(p.fz)))
        .map((p) => ({ fx: Number(p.fx), fz: Number(p.fz) }))
    : [];
  obj.userData.col = {
    enabled: !!colData.enabled,
    pts: pts.length >= 3 ? pts : defaultColData().pts.map((p) => ({ ...p })),
  };
  syncColSolid(obj);
}

function serializeWalkZone() {
  if (!isWalkZoneScene()) return undefined;
  const z = ensureStreetWalkZone();
  return {
    enabled: !!z.enabled,
    pts: z.pts.map(([x, zz]) => [roundSceneNum(x), roundSceneNum(zz)]),
  };
}

function applyWalkZone(data) {
  if (!data || typeof data !== "object") {
    sceneWalkZone = { enabled: false, pts: defaultStreetWalkPts() };
    return;
  }
  const pts = Array.isArray(data.pts)
    ? data.pts
        .map((p) => {
          if (Array.isArray(p) && p.length >= 2) return [Number(p[0]), Number(p[1])];
          if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z))) {
            return [Number(p.x), Number(p.z)];
          }
          return null;
        })
        .filter(Boolean)
    : [];
  sceneWalkZone = {
    enabled: !!data.enabled,
    pts: pts.length >= 3 ? pts : defaultStreetWalkPts(),
  };
}

function serializeScene() {
  const objects = [];
  for (const obj of pickables) {
  const d = obj.userData;
    // Party cast is stored separately and travels between scenes
    if (!d?.editable || d.companion || d.crowdExtra || d.partyMember || d.tennisCast)
      continue;
    const entry = {
      kind: d.kind || "object",
      id: d.catalogId || null,
      path: d.path,
      // Prefer home/spawn so mid-entrance garage coords aren't saved
      x: roundSceneNum(
        d.spawnX != null ? d.spawnX : obj.position.x,
      ),
      z: roundSceneNum(
        d.spawnZ != null ? d.spawnZ : obj.position.z,
      ),
      scale: roundSceneNum(d.scale ?? 1),
      dir: d.dir || "south",
    };
    if (d.dancing) entry.dancing = true;
    // Always embed night_club_inside walkable collision polygon
    const col = serializeCol(obj);
    if (col) entry.col = col;
    objects.push(entry);
  }
  const out = {
    version: 1,
    revision: sceneRevision || 0,
    sceneId: activeSceneId || undefined,
    label:
      sceneCatalog.find((s) => s.id === activeSceneId)?.label || undefined,
    viewport: viewportMode,
    bg: bgMode,
    player: player?.mesh
      ? {
          x: roundSceneNum(player.mesh.position.x),
          z: roundSceneNum(player.mesh.position.z),
          facing: player.facing || "south",
        }
      : { x: 0, z: 200, facing: "south" },
    objects,
  };
  const wz = serializeWalkZone();
  if (wz) out.walkZone = wz;
  // Street traffic lane Z — sarı east (sol→sağ) / mavi west (sağ→sol)
  if (isStreetLikeScene()) {
    out.trafficLanes = {
      east: roundSceneNum(getTrafficLaneZ("east")),
      west: roundSceneNum(getTrafficLaneZ("west")),
    };
  }
  return out;
}

function applyTrafficLanesFromScene(data) {
  const lanes = data?.trafficLanes;
  if (!lanes || typeof lanes !== "object") return false;
  let applied = false;
  if (Number.isFinite(Number(lanes.east))) {
    trafficLanes.east = Number(lanes.east);
    applied = true;
  }
  if (Number.isFinite(Number(lanes.west))) {
    trafficLanes.west = Number(lanes.west);
    applied = true;
  }
  if (applied) {
    try {
      localStorage.setItem(
        TRAFFIC_LANE_KEY,
        JSON.stringify({
          east: getTrafficLaneZ("east"),
          west: getTrafficLaneZ("west"),
        }),
      );
    } catch {
      /* */
    }
  }
  return applied;
}

function persistScene() {
  try {
    localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify(serializeScene()));
  } catch (err) {
    console.warn("persistScene", err);
  }
}

function schedulePersistScene() {
  if (sceneLoading) return;
  clearTimeout(scenePersistTimer);
  scenePersistTimer = setTimeout(() => persistScene(), 400);
}

function findCatalogItem(entry) {
  if (!entry) return null;
  const path = entry.path;
  if (entry.id && path) {
    const byKey = catalogItemById.get(`${entry.id}:${path}`);
    if (byKey) return byKey;
  }
  if (path) {
    for (const it of catalogItemById.values()) {
      if (it.path === path) return it;
    }
  }
  return null;
}

function clearEditableSceneObjects() {
  selectObject(null);
  // Clear pets too so scene swaps don't leave the previous dog behind
  const doomed = pickables.filter((o) => o.userData?.editable);
  for (const obj of doomed) {
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  companion = null;
  disposePetColRing();
  undoStack.length = 0;
}

function listPartyCharacters() {
  return pickables.filter((o) => {
    if (o.userData?.kind !== "character") return false;
    if (o.userData?.companion) return false;
    // Street cast, crowd (10/20/50), tennis NPCs — all travel between scenes
    return !!(
      o.userData?.partyMember ||
      o.userData?.tennisCast ||
      o.userData?.crowdExtra
    );
  });
}

function snapshotPartyFromWorld() {
  const list = [];
  for (const o of listPartyCharacters()) {
    const d = o.userData || {};
    list.push({
      path: d.path,
      id: d.catalogId || null,
      scale: d.scale ?? 1,
      dir: d.dir || "south",
    });
  }
  persistentParty = list;
}

async function restorePartyIntoScene() {
  if (!persistentParty.length) return 0;
  const home = streetGatherTarget || player?.mesh?.position || { x: 0, z: 200 };
  const club = isNightClubScene();
  const street = isStreetLikeScene();
  const clubSlots = club ? nightClubCrowdSlots(persistentParty.length) : [];
  const gate = club ? nightClubEntranceGate() : null;
  const post = street ? findScenePostOffice() : null;
  const garage = post ? postOfficeGarageExit(post) : null;
  const dirs = ["south", "south-east", "south-west", "east", "west"];
  let placed = 0;
  for (let i = 0; i < persistentParty.length; i++) {
    const entry = persistentParty[i];
    const item = findCatalogItem(entry);
    if (!item) continue;
    const dir = club ? dirs[i % dirs.length] : entry.dir || "south";
    const slot = clubSlots[i] || null;
    const ang = (i / Math.max(persistentParty.length, 1)) * Math.PI * 2;
    const rad = 22 + (i % 3) * 10;
    const gather = {
      x: home.x + Math.cos(ang) * rad,
      z: home.z + Math.sin(ang) * rad,
    };
    let spawnX;
    let spawnZ;
    if (club && gate) {
      // Queue at sol-alt entrance, then run onto floor
      const lane = i % 8;
      const wave = Math.floor(i / 8);
      spawnX = gate.x + 6 + lane * 12 + wave * 3 + (Math.random() - 0.5) * 4;
      spawnZ = gate.z - 4 - (Math.random() - 0.5) * 5;
    } else if (street && garage) {
      // Start at post office — startStreetPostOfficeEntrances walks them in
      const lane = i % 8;
      const wave = Math.floor(i / 8);
      spawnX = garage.x + (lane - 3.5) * 10;
      spawnZ = garage.z + wave * 8;
    } else if (slot) {
      spawnX = slot.x;
      spawnZ = slot.z;
    } else {
      spawnX = gather.x;
      spawnZ = gather.z;
    }
    try {
      const obj = await spawnItem(item, gather.x, gather.z, {
        dir,
        scale: entry.scale != null ? Number(entry.scale) : undefined,
        exactPos: true,
        recordUndo: false,
        select: false,
        playEntrance: false,
        partyMember: false,
      });
      // Override spawnItem position — gather is home; visual start is gate/garage
      obj.position.set(spawnX, 0, spawnZ);
      obj.userData.spawnX = gather.x;
      obj.userData.spawnZ = gather.z;
      obj.userData.partyMember = true;
      obj.userData.crowdExtra = true;
      obj.userData.editable = true;
      syncDepth(obj);
      if (club && slot) {
        obj.userData.formationMove = true;
        scriptActorTo(obj, slot.x, slot.z, {
          run: true,
          faceDir: dir,
          idleOnArrive: false,
          wait: i * 0.14,
          onDone: () => {
            attachDance(obj, obj.userData.path, dir, {
              allowSouthFallback: true,
            })
              .then((ok) => {
                if (ok) return;
                return attachIdle(obj, obj.userData.path, dir, {
                  allowSouthFallback: true,
                });
              })
              .catch(() => {});
          },
        });
      }
      placed += 1;
    } catch (err) {
      console.warn("party restore", err);
    }
  }
  return placed;
}

/** NPC traffic on street road — car_2→car_5→pickup, L↔R off-screen. */
const TRAFFIC_PATHS = [
  "assets/vehicles/car_2/168x168/day",
  "assets/vehicles/car_3/168x168/day",
  "assets/vehicles/car_4/168x168/day",
  "assets/vehicles/car_5/168x168/day",
  "assets/vehicles/pickup/168x168/day",
];
const TRAFFIC_SPAWN_X = 420;
const TRAFFIC_DESPAWN_X = 450;
const TRAFFIC_SPEED = 175;
const TRAFFIC_LANE_KEY = "skate_life_traffic_lanes_v1";
let trafficEnabled = false;
let trafficQueueIdx = 0;
let trafficSpawnTimer = 0;
let trafficSpawning = false;
/** east = sol→sağ, west = sağ→sol — ayrı Z çizgileri */
/** @type {{ east: number | null, west: number | null }} */
let trafficLanes = { east: null, west: null };
/** @type {THREE.Group | null} */
let trafficLaneGizmo = null;
/** @type {"east" | "west" | null} */
let trafficLaneDragDir = null;

function findStreetRoad() {
  return (
    pickables.find((o) => /\/props\/road\//i.test(o.userData?.path || "")) || null
  );
}

function defaultTrafficLanes() {
  const road = findStreetRoad();
  const base = road ? road.position.z : 568;
  return { east: base - 22, west: base + 22 };
}

function loadTrafficLaneZ() {
  try {
    const raw = localStorage.getItem(TRAFFIC_LANE_KEY);
    if (!raw) {
      // migrate old single-lane key if present
      const old = localStorage.getItem("skate_life_traffic_lane_z");
      if (old != null && Number.isFinite(Number(old))) {
        const z = Number(old);
        trafficLanes = { east: z - 18, west: z + 18 };
      }
      return;
    }
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (Number.isFinite(Number(data.east))) trafficLanes.east = Number(data.east);
      if (Number.isFinite(Number(data.west))) trafficLanes.west = Number(data.west);
    }
  } catch {
    /* */
  }
}

function saveTrafficLaneZ() {
  try {
    localStorage.setItem(
      TRAFFIC_LANE_KEY,
      JSON.stringify({
        east: getTrafficLaneZ("east"),
        west: getTrafficLaneZ("west"),
      }),
    );
  } catch {
    /* */
  }
}

function getTrafficLaneZ(dir) {
  const d = dir === "west" ? "west" : "east";
  const v = trafficLanes[d];
  if (v != null && Number.isFinite(v)) return v;
  const defs = defaultTrafficLanes();
  return defs[d];
}

function disposeTrafficLaneGizmo() {
  if (!trafficLaneGizmo) return;
  trafficLaneGizmo.traverse((n) => {
    n.geometry?.dispose?.();
    if (n.material) {
      if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
      else n.material.dispose?.();
    }
  });
  trafficLaneGizmo.parent?.remove(trafficLaneGizmo);
  trafficLaneGizmo = null;
}

function addTrafficLaneVisual(g, dir, z, color, handleColor) {
  const matLine = new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const pts = [
    new THREE.Vector3(-TRAFFIC_SPAWN_X, 6, z),
    new THREE.Vector3(TRAFFIC_SPAWN_X, 6, z),
  ];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    matLine,
  );
  line.frustumCulled = false;
  line.renderOrder = 100001;
  g.add(line);

  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(TRAFFIC_SPAWN_X * 2, 2, 24),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.2,
      depthTest: false,
      depthWrite: false,
    }),
  );
  strip.position.set(0, 3, z);
  strip.userData.trafficLaneHit = true;
  strip.userData.trafficLaneDir = dir;
  strip.frustumCulled = false;
  strip.renderOrder = 100000;
  g.add(strip);

  for (const x of [-TRAFFIC_SPAWN_X, 0, TRAFFIC_SPAWN_X]) {
    const handle = new THREE.Mesh(
      new THREE.SphereGeometry(15, 14, 14),
      new THREE.MeshBasicMaterial({
        color: handleColor,
        depthTest: false,
        depthWrite: false,
      }),
    );
    handle.position.set(x, 10, z);
    handle.userData.trafficLaneHit = true;
    handle.userData.trafficLaneDir = dir;
    handle.frustumCulled = false;
    handle.renderOrder = 100002;
    g.add(handle);
  }
}

function updateTrafficLaneGizmo() {
  // Lane guides hidden while positions are good — Z still from trafficLanes / localStorage
  disposeTrafficLaneGizmo();
}

function setTrafficLaneZ(dir, z) {
  const d = dir === "west" ? "west" : "east";
  trafficLanes[d] = z;
  for (const obj of pickables) {
    if (!obj.userData?.traffic) continue;
    if (obj.userData.trafficDir !== d) continue;
    obj.position.z = z;
    syncDepth(obj);
  }
  updateTrafficLaneGizmo();
  saveTrafficLaneZ();
  if (!sceneLoading) schedulePersistScene();
}

function clearTraffic() {
  const doomed = pickables.filter((o) => o.userData?.traffic);
  for (const obj of doomed) {
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  trafficSpawning = false;
  trafficSpawnTimer = 0.6;
  trafficLaneDragDir = null;
}

function syncTrafficForScene() {
  if (isStreetLikeScene()) {
    trafficEnabled = true;
    trafficSpawnTimer = 0.4;
    const defs = defaultTrafficLanes();
    if (trafficLanes.east == null) trafficLanes.east = defs.east;
    if (trafficLanes.west == null) trafficLanes.west = defs.west;
    disposeTrafficLaneGizmo();
  } else {
    trafficEnabled = false;
    clearTraffic();
    disposeTrafficLaneGizmo();
  }
}

async function spawnNextTrafficCar() {
  const path = TRAFFIC_PATHS[trafficQueueIdx % TRAFFIC_PATHS.length];
  trafficQueueIdx += 1;
  const item = findCatalogItem({ path });
  if (!item) {
    console.warn("traffic: katalogda yok", path);
    return;
  }
  const goEast = Math.random() < 0.5;
  const dir = goEast ? "east" : "west";
  const laneZ = getTrafficLaneZ(dir);
  const x0 = goEast ? -TRAFFIC_SPAWN_X : TRAFFIC_SPAWN_X;
  const vx = goEast ? TRAFFIC_SPEED : -TRAFFIC_SPEED;
  const obj = await spawnItem(item, x0, laneZ, {
    dir,
    scale: 1,
    exactPos: true,
    recordUndo: false,
    select: false,
    editable: false,
    traffic: true,
  });
  if (!obj) return;
  obj.userData.traffic = true;
  obj.userData.trafficDir = dir;
  obj.userData.trafficVx = vx;
  obj.userData.editable = false;
  syncDepth(obj);
}

function tickTraffic(dt) {
  if (!trafficEnabled) return;

  for (const obj of [...pickables]) {
    if (!obj.userData?.traffic) continue;
    const vx = obj.userData.trafficVx || 0;
    obj.position.x += vx * dt;
    syncDepth(obj);
    if (obj.position.x > TRAFFIC_DESPAWN_X || obj.position.x < -TRAFFIC_DESPAWN_X) {
      detachPlacedObject(obj);
      disposePlacedObject(obj);
    }
  }

  if (trafficSpawning) return;
  if (pickables.some((o) => o.userData?.traffic)) return;
  trafficSpawnTimer -= dt;
  if (trafficSpawnTimer > 0) return;
  trafficSpawning = true;
  spawnNextTrafficCar()
    .catch((err) => console.warn("traffic spawn", err))
    .finally(() => {
      trafficSpawning = false;
      trafficSpawnTimer = 1.4 + Math.random() * 2.2;
    });
}

/** postoffice_day — stand just outside the garage / front facade. */
function findScenePostOffice() {
  return pickables.find((o) => /\/postoffice\//i.test(o.userData?.path || ""));
}

function postOfficeGarageExit(post) {
  const w = (post.userData?.w || 256) * (post.userData?.scale || 1);
  const dir = post.userData?.dir || "west";
  const face = FACE_VEC[dir] || FACE_VEC.west;
  // Past collision AABB (scale 1.85 buildings need more than w*0.4)
  const box = footprintOf(post);
  const edge =
    box.kind === "aabb"
      ? Math.abs(face[0]) * box.hw + Math.abs(face[1]) * box.hd
      : w * 0.35;
  const dist = Math.max(160, edge + NPC_WALK_RADIUS + 48, w * 0.55);
  return {
    x: post.position.x + face[0] * dist,
    z: post.position.z + face[1] * dist,
    facing: dir,
  };
}

/** Send Main/NPC out of post office garage toward gather (orta) — walk anim for NPCs. */
function beginPostOfficeEntrance(obj, dest, { stagger = 0, isPlayer = false } = {}) {
  const post = findScenePostOffice();
  if (!post || !obj) return false;
  const exit = postOfficeGarageExit(post);
  const jx = stagger ? (Math.random() - 0.5) * 28 : 0;
  const jz = stagger ? (Math.random() - 0.5) * 28 : 0;
  const tx = Number(dest?.x);
  const tz = Number(dest?.z);
  const destX = Number.isFinite(tx) ? tx : streetGatherTarget.x;
  const destZ = Number.isFinite(tz) ? tz : streetGatherTarget.z;
  // Nudge out of garage / solids before walking (was freezing on first blocked step)
  const preferDx = destX - (exit.x + jx);
  const preferDz = destZ - (exit.z + jz);
  const faceFallback = FACE_VEC[exit.facing] || FACE_VEC.west;
  const clear = findClearSpawn(
    exit.x + jx,
    exit.z + jz,
    preferDx || faceFallback[0],
    preferDz || faceFallback[1],
    isPlayer ? player?.radius || 22 : NPC_WALK_RADIUS,
  );
  const sx = clear.x;
  const sz = clear.z;
  const dx = destX - sx;
  const dz = destZ - sz;
  const dist = Math.hypot(dx, dz);
  const walkDir = dirFromVector(dx, dz) || exit.facing || "west";

  if (isPlayer) {
    if (occupiedVehicle) exitVehicle();
    if (player?.skating && occupiedSkateboard) exitSkateboard();
    player.stopActions?.();
    player.mesh.position.set(sx, 0, sz);
    player.mesh.visible = true;
    player.facing = walkDir;
    player.syncRing?.(sx, sz);
    if (player.syncDepth) player.syncDepth(player.mesh);
    if (dist > 16) player.startScriptMove(dx, dz, dist);
    return true;
  }

  // Reveal only at garage — never mid-plaza from a previous spawn slot
  obj.position.set(sx, 0, sz);
  obj.visible = true;
  obj.userData.dir = walkDir;
  applyFacing(obj, walkDir);
  syncDepth(obj);
  clearNpcScriptMoves(obj);
  if (dist > 16) {
    // Walk clip (not idle) while moving — like Main
    attachWalk(obj, obj.userData.path, walkDir, { allowSouthFallback: true }).catch(
      () => {},
    );
    enqueueNpcWalk(obj, dx, dz, dist, 110, stagger, {
      onDone: () => {
        stopCharacterGait(obj);
        attachIdle(obj, obj.userData.path, obj.userData.dir || walkDir, {
          allowSouthFallback: true,
        }).catch(() => {});
      },
    });
  } else {
    attachIdle(obj, obj.userData.path, walkDir, { allowSouthFallback: true }).catch(
      () => {},
    );
  }
  return true;
}

/** Street play: Main + cast exit garage → JSON player home (fixed gather). */
function startStreetPostOfficeEntrances(gather) {
  const post = findScenePostOffice();
  if (!post) return false;
  // Only refresh gather when scene load passes JSON player; never from live Main
  if (gather && Number.isFinite(gather.x) && Number.isFinite(gather.z)) {
    streetGatherTarget = { x: gather.x, z: gather.z };
  }
  const dest = { x: streetGatherTarget.x, z: streetGatherTarget.z };
  clearNpcScriptMoves();
  let n = 0;
  if (player?.mesh) {
    if (beginPostOfficeEntrance(player.mesh, dest, { isPlayer: true })) n += 1;
  }
  const chars = pickables.filter(
    (o) => o.userData?.kind === "character" && o.userData?.editable !== false,
  );
  chars.forEach((obj, i) => {
    // Fan gather spots so the cast doesn't land on one pixel
    const ang = (i / Math.max(chars.length, 1)) * Math.PI * 2;
    const rad = 22 + (i % 3) * 10;
    const slot = {
      x: dest.x + Math.cos(ang) * rad,
      z: dest.z + Math.sin(ang) * rad,
    };
    if (beginPostOfficeEntrance(obj, slot, { stagger: 0.25 + i * 0.45 })) n += 1;
  });
  if (n > 0) statusEl.textContent = "Postane garajından ortaya geliyor…";
  return n > 0;
}

async function loadScene(data, { persist = true, carryParty = true } = {}) {
  if (!data || Number(data.version) !== 1) {
    throw new Error("Geçersiz sahne JSON (version: 1 bekleniyor)");
  }
  sceneLoading = true;
  statusEl.textContent = "Sahne yükleniyor…";
  try {
    // Full reload wipes live actors — drop truth-dare session state
    truthDareActive = false;
    truthDareSnapshot = new Map();
    try {
      clearTruthDareFormationLocks();
    } catch {
      /* helpers may not be ready on first boot */
    }
    // Remember cast before wipe — they travel to the next scene
    if (carryParty && partySnapshotEnabled) snapshotPartyFromWorld();
    clearTraffic();
    clearTennisCast();
    clearCrowdExtras();
    if (data.revision != null) sceneRevision = Number(data.revision) || 0;
    if (data.sceneId) activeSceneId = String(data.sceneId);
    else activeSceneId = null;
    highlightSceneSlot(activeSceneId);
    if (data.bg === "black" || data.bg === "grass") applyBackgroundMode(data.bg);
    if (data.viewport === "9x16" || data.viewport === "fill") {
      applyViewportMode(data.viewport);
    }
    clearEditableSceneObjects();
    applyWalkZone(isWalkZoneScene() ? data.walkZone : null);
    syncStreetWalkUi();
    if (player?.mesh && data.player) {
      player.mesh.position.x = Number(data.player.x) || 0;
      player.mesh.position.z = Number(data.player.z) || 200;
      if (data.player.facing) player.facing = data.player.facing;
      player.syncRing?.();
      if (player.syncDepth) player.syncDepth(player.mesh);
      if (viewportMode !== "9x16") syncCameraRig(player.mesh.position);
      else syncCameraRig(MAP_VIEW);
    }
    const entries = Array.isArray(data.objects) ? data.objects : [];
    let placed = 0;
    let missing = 0;
    for (const entry of entries) {
      // Party cast is restored separately — skip character entries baked into JSON
      if (entry?.partyMember) continue;
      const item = findCatalogItem(entry);
      if (!item) {
        missing += 1;
        console.warn("sahne: katalogda yok", entry.path);
        continue;
      }
      const obj = await spawnItem(item, Number(entry.x) || 0, Number(entry.z) || 0, {
        scale: entry.scale != null ? Number(entry.scale) : undefined,
        dir: entry.dir,
        exactPos: true,
        recordUndo: false,
        select: false,
        playEntrance: false,
      });
      if (entry.sceneOverlay) obj.userData.sceneOverlay = entry.sceneOverlay;
      if (entry.col) applySerializedCol(obj, entry.col);
      if (entry.dancing && obj.userData.kind === "character") {
        await setCharacterDancing(obj, true);
      }
      placed += 1;
    }
    selectObject(null);
    // Scene JSON trafficLanes wins over stale localStorage defaults
    applyTrafficLanesFromScene(data);
    let partyN = 0;
    if (carryParty) partyN = await restorePartyIntoScene();
    if (persist) persistScene();
    syncTrafficForScene();
    // Street: Main + cast → JSON player home; later spawns use same fixed point
    if (isStreetLikeScene()) {
      const dest = data.player
        ? {
            x: Number(data.player.x) || -0.33,
            z: Number(data.player.z) || 188.96,
          }
        : { x: -0.33, z: 188.96 };
      streetGatherTarget = { x: dest.x, z: dest.z };
      if (!startStreetPostOfficeEntrances(dest)) {
        statusEl.textContent =
          missing > 0
            ? `Sahne: ${placed} obje (${missing} eksik asset)`
            : `Sahne yüklendi · ${placed} obje`;
      }
    } else {
      statusEl.textContent =
        missing > 0
          ? `Sahne: ${placed} obje (${missing} eksik asset)`
          : `Sahne yüklendi · ${placed} obje`;
    }
    if (partyN > 0) {
      statusEl.textContent = `${statusEl.textContent || "Hazır"} · parti ${partyN}`;
    }
    if (isRedLightScene()) {
      redLightCastCount = Math.min(
        RED_LIGHT_CAST_MAX,
        Math.max(0, countRedLightCast()),
      );
      syncRedLightCastUi();
      stopRedLightGame({ clearDq: true });
      showRedLightPlayPrompt();
      const ready = countRedLightCast();
      statusEl.textContent =
        ready > 0
          ? `Red light · ${ready} kişi hazır · /play ile başla (max ${RED_LIGHT_CAST_MAX})`
          : `Red light · /play ile başla (Main)`;
    } else {
      stopRedLightGame({ clearDq: true });
    }
    if (isTennisScene()) {
      syncTennisLiveSimUi();
      ensureTennisFootballBall().catch(() => {});
    }
  } finally {
    sceneLoading = false;
    partySnapshotEnabled = true;
  }
}

async function copySceneJson() {
  const json = JSON.stringify(serializeScene(), null, 2);
  persistScene();
  try {
    await navigator.clipboard.writeText(json);
    statusEl.textContent = "Sahne JSON panoya kopyalandı";
  } catch {
    if (sceneJsonEl && sceneModal) {
      sceneJsonEl.value = json;
      sceneModal.classList.remove("hidden");
      sceneJsonEl.focus();
      sceneJsonEl.select();
      statusEl.textContent = "Panoya yazılamadı — JSON kutudan kopyala";
      return;
    }
    statusEl.textContent = "JSON kopyalanamadı";
  }
}

function openSceneLoadModal() {
  if (!sceneModal || !sceneJsonEl) return;
  sceneJsonEl.value = "";
  sceneModal.classList.remove("hidden");
  sceneJsonEl.focus();
}

function closeSceneModal() {
  sceneModal?.classList.add("hidden");
}

async function applySceneFromModal() {
  const raw = sceneJsonEl?.value?.trim();
  if (!raw) {
    statusEl.textContent = "JSON boş";
    return;
  }
  try {
    const data = JSON.parse(raw);
    closeSceneModal();
    await loadScene(data);
  } catch (err) {
    console.warn(err);
    statusEl.textContent = "JSON okunamadı: " + (err.message || err);
  }
}

async function clearSavedScene() {
  if (!confirm("Yerleştirilmiş objeler silinsin mi? (localStorage da temizlenir)")) return;
  sceneLoading = true;
  try {
    clearTraffic();
    trafficEnabled = false;
    disposeTrafficLaneGizmo();
    activeSceneId = null;
    highlightSceneSlot(null);
    applyWalkZone(null);
    syncStreetWalkUi();
    clearEditableSceneObjects();
    try {
      localStorage.removeItem(SCENE_STORAGE_KEY);
    } catch {
      /* */
    }
    statusEl.textContent = "Sahne temizlendi";
  } finally {
    sceneLoading = false;
  }
}

sceneCopyBtn?.addEventListener("click", () => {
  copySceneJson();
});
sceneLoadBtn?.addEventListener("click", () => openSceneLoadModal());
sceneClearBtn?.addEventListener("click", () => {
  clearSavedScene();
});

truthDareCrowdEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-crowd]");
  if (!btn || btn.classList.contains("hidden")) return;
  const n = Number(btn.getAttribute("data-crowd"));
  if (!TRUTH_DARE_CROWD_COUNTS.includes(n)) return;
  if (!isCrowdScene()) return;
  setTruthDareCrowdCount(n).catch((err) => {
    console.warn(err);
    statusEl.textContent = err.message || String(err);
  });
});
redLightCastEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-rlcast]");
  if (!btn) return;
  const n = Number(btn.getAttribute("data-rlcast"));
  if (!Number.isFinite(n) || n < 1 || n > RED_LIGHT_CAST_MAX) return;
  if (!isRedLightScene()) return;
  setRedLightCastCount(n).catch((err) => {
    console.warn(err);
    statusEl.textContent = err.message || String(err);
  });
});
sceneModalCancel?.addEventListener("click", () => closeSceneModal());
sceneModalApply?.addEventListener("click", () => {
  applySceneFromModal();
});
sceneModal?.addEventListener("click", (e) => {
  if (e.target === sceneModal) closeSceneModal();
});
window.addEventListener("beforeunload", () => {
  if (!sceneLoading) persistScene();
});

function highlightSceneSlot(sceneId) {
  sceneSlotsEl?.querySelectorAll(".scene-slot").forEach((slot) => {
    const on = slot.getAttribute("data-scene") === sceneId;
    slot.classList.toggle("active", on);
    slot.querySelectorAll("button[data-scene]").forEach((btn) => {
      btn.classList.toggle("active", on);
    });
  });
}

async function fetchSceneCatalog() {
  try {
    const res = await fetch(new URL("./scenes/index.json", import.meta.url).href, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.scenes) ? data.scenes : [];
  } catch {
    return [];
  }
}

function renderSceneSlots() {
  if (!sceneSlotsEl) return;
  sceneSlotsEl.innerHTML = "";
  if (!sceneCatalog.length) {
    sceneSlotsEl.classList.add("hidden");
    return;
  }
  sceneSlotsEl.classList.remove("hidden");
  for (const s of sceneCatalog) {
    const slot = document.createElement("div");
    slot.className = "scene-slot";
    slot.dataset.scene = s.id;
    if (s.id === activeSceneId) slot.classList.add("active");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = s.label || s.id;
    btn.dataset.scene = s.id;
    btn.title = `${s.label || s.id} — sahneyi yükle`;
    if (s.id === activeSceneId) btn.classList.add("active");
    btn.addEventListener("click", () => {
      loadNamedScene(s.id).catch((err) => {
        console.warn(err);
        statusEl.textContent = err.message || String(err);
      });
    });

    slot.appendChild(btn);
    sceneSlotsEl.appendChild(slot);
  }
}

async function fetchSceneFile(file) {
  const res = await fetch(new URL(`./scenes/${file}`, import.meta.url).href, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Sahne bulunamadı: ${file}`);
  const data = await res.json();
  if (!data || Number(data.version) !== 1) {
    throw new Error(`Geçersiz sahne dosyası: ${file}`);
  }
  return data;
}

/**
 * Overlay scenes (e.g. dogrulukmu_cesaretmi) reuse street.json and only
 * append their extra objects — no separate full street copy.
 */
async function resolveSceneData(sceneId, overlay) {
  const baseId = overlay?.base || null;
  if (!baseId) return overlay;
  const baseMeta = sceneCatalog.find((s) => s.id === baseId);
  const baseFile = baseMeta?.file || `${baseId}.json`;
  const base = await fetchSceneFile(baseFile);
  const extra = Array.isArray(overlay.objects) ? overlay.objects : [];
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(overlay).filter(
        ([k]) => k !== "objects" && k !== "base" && overlay[k] != null,
      ),
    ),
    base: baseId,
    objects: [
      ...(base.objects || []),
      ...extra.map((o) => ({ ...o, sceneOverlay: sceneId })),
    ],
    walkZone: overlay.walkZone || base.walkZone,
    player: overlay.player || base.player,
  };
}

function clearSceneOverlayObjects(overlayId) {
  const doomed = pickables.filter((o) => o.userData?.sceneOverlay === overlayId);
  for (const obj of doomed) {
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  return doomed.length;
}

function truthDareActorPool() {
  const pool = [];
  if (player?.mesh) pool.push(player.mesh);
  for (const o of pickables) {
    if (o.userData?.kind !== "character") continue;
    if (o.userData?.editable === false) continue;
    if (o.userData?.companion) continue;
    if (o === player?.mesh) continue;
    pool.push(o);
  }
  return pool;
}

function syncTruthDareCrowdUi() {
  const panel = truthDareCrowdEl;
  if (!panel) return;
  // Street: pick count → doğrulukmu. Night club: pack the floor.
  const show = isCrowdScene();
  const club = isNightClubScene();
  panel.classList.toggle("hidden", !show);
  panel.title = club
    ? "Night club dans alanına boy/girl kalabalık"
    : "Street’te sayı seç → doğrulukmu_cesaretmi’ye geç";
  panel.querySelectorAll("button[data-crowd]").forEach((btn) => {
    const n = Number(btn.getAttribute("data-crowd"));
    btn.classList.remove("hidden");
    btn.classList.toggle("active", show && n === truthDareCrowdCount);
  });
  syncRedLightCastUi();
}

function syncRedLightCastUi() {
  const panel = redLightCastEl;
  if (!panel) return;
  const show = isRedLightScene();
  panel.classList.toggle("hidden", !show);
  panel.querySelectorAll("button[data-rlcast]").forEach((btn) => {
    const n = Number(btn.getAttribute("data-rlcast"));
    btn.classList.toggle("active", show && n === redLightCastCount);
  });
  syncTennisLiveSimUi();
}

function formatTennisLiveStats() {
  const { a, b } = tennisLive;
  return `A ${a.likes}·${a.gifts} (${a.power}) · B ${b.likes}·${b.gifts} (${b.power})`;
}

function syncTennisLiveSimUi() {
  const panel = tennisLiveSimEl;
  if (!panel) return;
  const show = isTennisScene();
  panel.classList.toggle("hidden", !show);
  panel.querySelectorAll("button[data-tncast]").forEach((btn) => {
    const n = Number(btn.getAttribute("data-tncast"));
    btn.classList.toggle("active", show && n === tennisCastCount);
  });
  if (tennisLiveStatsEl) tennisLiveStatsEl.textContent = formatTennisLiveStats();
}

function resetTennisLiveSim() {
  tennisLive.a = { likes: 0, gifts: 0, power: 0 };
  tennisLive.b = { likes: 0, gifts: 0, power: 0 };
}

function simulateTennisLive(kind) {
  if (!isTennisScene()) {
    statusEl.textContent = "Like/hediye sim — tennis sahnesinde dene";
    return;
  }
  if (kind === "reset") {
    resetTennisLiveSim();
    syncTennisLiveSimUi();
    statusEl.textContent = "Tenis live sim sıfırlandı";
    return;
  }
  const team = kind.endsWith("-a") ? "a" : kind.endsWith("-b") ? "b" : null;
  if (!team) return;
  const side = tennisLive[team];
  const label = team === "a" ? "A" : "B";
  if (kind.startsWith("like-")) {
    side.likes += 1;
    side.power += TENNIS_LIKE_POWER;
    statusEl.textContent = `Like → Takım ${label} · güç ${side.power}`;
  } else if (kind.startsWith("gift-")) {
    side.gifts += 1;
    side.power += TENNIS_GIFT_POWER;
    statusEl.textContent = `Hediye → Takım ${label} · güç ${side.power} (+${TENNIS_GIFT_POWER})`;
  }
  syncTennisLiveSimUi();
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Court mid in walk zone — south side = A, north side = B. */
function tennisCastSlots(count) {
  const n = count === 2 ? 2 : 4;
  if (n === 2) {
    return [
      { x: -40, z: 140, dir: "north", team: "a" },
      { x: 40, z: 300, dir: "south", team: "b" },
    ];
  }
  return [
    { x: -90, z: 130, dir: "north", team: "a" },
    { x: 90, z: 130, dir: "north", team: "a" },
    { x: -90, z: 310, dir: "south", team: "b" },
    { x: 90, z: 310, dir: "south", team: "b" },
  ];
}

function clearTennisCast() {
  const doomed = pickables.filter((o) => o.userData?.tennisCast);
  for (const obj of doomed) {
    clearNpcScriptMoves(obj);
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  return doomed.length;
}

function findFootballBallItem() {
  for (const it of catalogItemById.values()) {
    if (/\/balls\/football\//i.test(it.path || "")) return it;
  }
  return null;
}

async function ensureTennisFootballBall() {
  if (!isTennisScene()) return null;
  const existing = pickables.find(
    (o) => o.userData?.tennisBall || /\/balls\/football\//i.test(o.userData?.path || ""),
  );
  if (existing) {
    existing.userData.tennisBall = true;
    return existing;
  }
  const item = findFootballBallItem();
  if (!item) {
    statusEl.textContent = "Futbol topu katalogda yok";
    return null;
  }
  const obj = await spawnItem(item, 0, 220, {
    dir: "south",
    exactPos: true,
    recordUndo: false,
    select: false,
    playEntrance: false,
  });
  if (obj) {
    obj.userData.tennisBall = true;
    obj.userData.editable = true;
  }
  return obj;
}

async function setTennisCastCount(count) {
  const n = count === 2 || count === 4 ? count : 0;
  if (!isTennisScene()) return;
  statusEl.textContent = n ? `${n} oyuncu hazırlanıyor…` : "Tenis cast temizleniyor…";
  clearNpcScriptMoves();
  if (player?.scriptMove) player.scriptMove = null;
  // Drop street party + old tennis NPCs so total = Main + (n-1)
  for (const obj of [...listPartyCharacters()]) {
    clearNpcScriptMoves(obj);
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  clearTennisCast();
  tennisCastCount = n;
  syncTennisLiveSimUi();
  await ensureTennisFootballBall();
  if (!n) {
    if (player?.mesh?.userData) {
      player.mesh.userData.tennisTeam = null;
      player.mesh.userData.formationSlot = null;
    }
    statusEl.textContent = "Tenis cast yok · futbol topu hazır";
    return;
  }
  const slots = tennisCastSlots(n);
  // Main counts as 1 — spawn only n-1 NPCs (2 → 1v1, 4 → 2v2)
  const needNpcs = Math.max(0, n - (player?.mesh ? 1 : 0));
  const catalog = shuffleInPlace([...crowdCharacterCatalog()]);
  if (needNpcs > 0 && !catalog.length) {
    statusEl.textContent = "Random cast için boy/girl yok";
    tennisCastCount = 0;
    syncTennisLiveSimUi();
    return;
  }

  // Slot 0 = Main (takım A); remaining slots = NPCs
  if (player?.mesh && slots[0]) {
    const slot = slots[0];
    player.mesh.position.set(slot.x, 0, slot.z);
    player.facing = slot.dir || "north";
    player.mesh.userData.tennisTeam = slot.team;
    player.mesh.userData.formationSlot = { x: slot.x, z: slot.z };
    player.mesh.userData.formationMove = false;
    player.syncRing?.(slot.x, slot.z);
    if (player.syncDepth) player.syncDepth(player.mesh);
  }

  let placed = player?.mesh ? 1 : 0;
  for (let i = 0; i < needNpcs; i++) {
    const item = catalog[i % catalog.length];
    const slot = slots[i + (player?.mesh ? 1 : 0)];
    if (!slot) break;
    try {
      const obj = await spawnItem(item, slot.x, slot.z, {
        dir: slot.dir,
        exactPos: true,
        recordUndo: false,
        select: false,
        playEntrance: false,
        editable: false,
        partyMember: false,
      });
      obj.userData.tennisCast = true;
      obj.userData.partyMember = true;
      obj.userData.tennisTeam = slot.team;
      obj.userData.editable = false;
      obj.userData.formationSlot = { x: slot.x, z: slot.z };
      obj.userData.formationMove = false;
      placed += 1;
    } catch (err) {
      console.warn("tennis cast spawn", err);
    }
  }
  if (partySnapshotEnabled) snapshotPartyFromWorld();
  statusEl.textContent =
    n === 2
      ? `1v1 · Main + ${placed - (player?.mesh ? 1 : 0)} · futbol topu (geçici)`
      : `2v2 · Main + ${placed - (player?.mesh ? 1 : 0)} · A/B · futbol topu (geçici)`;
  syncTennisLiveSimUi();
}

tennisLiveSimEl?.addEventListener("click", (e) => {
  const castBtn = e.target?.closest?.("button[data-tncast]");
  if (castBtn) {
    const n = Number(castBtn.getAttribute("data-tncast"));
    setTennisCastCount(n).catch((err) => {
      console.warn(err);
      statusEl.textContent = err.message || String(err);
    });
    return;
  }
  const btn = e.target?.closest?.("button[data-tnsim]");
  if (!btn) return;
  simulateTennisLive(btn.getAttribute("data-tnsim") || "");
});

/** All red-light cast candidates (includes benched/hidden). Excludes Main. */
function listRedLightNpcPool() {
  return pickables.filter((o) => {
    if (o.userData?.kind !== "character") return false;
    if (o === player?.mesh || o.userData?.companion) return false;
    return !!(
      o.userData?.partyMember ||
      o.userData?.tennisCast ||
      o.userData?.crowdExtra ||
      o.userData?.editable !== false
    );
  });
}

/** Active lineup NPCs only (not benched/hidden). */
function listRedLightNpcs() {
  return listRedLightNpcPool().filter(
    (o) => !o.userData?.redLightBench && o.visible !== false,
  );
}

function countRedLightCast() {
  const npcs = listRedLightNpcPool().length;
  return (player?.mesh ? 1 : 0) + npcs;
}

function clearRedLightBenchHide() {
  for (const o of listRedLightNpcPool()) {
    o.visible = true;
    if (o.userData) o.userData.redLightBench = false;
  }
}

/**
 * /play: Main + random up to 9 NPCs line up; everyone else stays in party but hidden.
 */
async function startRedLightPlay() {
  if (!isRedLightScene()) return;
  clearRedLightBenchHide();
  const pool = listRedLightNpcPool();
  const needNpcs = Math.max(0, RED_LIGHT_CAST_MAX - (player?.mesh ? 1 : 0));
  const shuffled = shuffleInPlace([...pool]);
  const selected = shuffled.slice(0, Math.min(needNpcs, shuffled.length));
  const selectedSet = new Set(selected);
  let hidden = 0;
  for (const o of pool) {
    if (selectedSet.has(o)) {
      o.visible = true;
      o.userData.redLightBench = false;
      continue;
    }
    clearNpcScriptMoves(o);
    o.visible = false;
    o.userData.redLightBench = true;
    hidden += 1;
  }
  const n = (player?.mesh ? 1 : 0) + selected.length;
  statusEl.textContent =
    hidden > 0
      ? `Red light — ${n} random oyuncu · ${hidden} gizlendi`
      : `Red light — ${n} oyuncu…`;
  await setRedLightCastCount(n, { spawnMissing: false, hideExtras: false });
}

/**
 * Start line at visual ALT of walk zone.
 * X span matches ÜST edge width (narrower end) so walking north (−Z)
 * doesn't hit the slanted side walls of the trapezoid.
 */
function redLightLineupSlots(count) {
  const n = Math.max(1, Math.min(RED_LIGHT_CAST_MAX, Number(count) || 1));
  if (!streetWalkActive()) {
    const gap = 44;
    const slots = [];
    for (let i = 0; i < n; i++) {
      slots.push({
        x: (i - (n - 1) / 2) * gap,
        z: 320,
        dir: "north",
      });
    }
    return slots;
  }
  const pts = ensureStreetWalkZone().pts;
  if (!pts?.length) return [];

  let ustI = 0;
  let altI = 0;
  let ustMid = Infinity;
  let altMid = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const midZ = (a[1] + b[1]) / 2;
    if (midZ < ustMid) {
      ustMid = midZ;
      ustI = i;
    }
    if (midZ > altMid) {
      altMid = midZ;
      altI = i;
    }
  }
  const ustA = pts[ustI];
  const ustB = pts[(ustI + 1) % pts.length];
  const altA = pts[altI];
  const altB = pts[(altI + 1) % pts.length];

  // Same horizontal width as ÜST collision corners
  let xL = Math.min(ustA[0], ustB[0]);
  let xR = Math.max(ustA[0], ustB[0]);
  // Tiny pad = feet radius so sides don't graze while walking up
  const sidePad = Math.max(18, (NPC_WALK_RADIUS || 22) * 0.85);
  xL += sidePad;
  xR -= sidePad;
  if (xR - xL < 40) {
    const mid = (Math.min(ustA[0], ustB[0]) + Math.max(ustA[0], ustB[0])) / 2;
    xL = mid - 20;
    xR = mid + 20;
  }

  const inset = 14;
  const zLine = (altA[1] + altB[1]) / 2 - inset;

  const slots = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    slots.push({
      x: xL + t * (xR - xL),
      z: zLine,
      dir: "north",
    });
  }
  return slots;
}

/** Sağ-üst (screen top-right): max X among low-Z corners of walk zone. */
function redLightEntranceGate() {
  if (!streetWalkActive()) return { x: 160, z: -260 };
  const pts = ensureStreetWalkZone().pts;
  if (!pts?.length) return { x: 160, z: -260 };
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [, z] of pts) {
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const zBand = minZ + (maxZ - minZ) * 0.35; // üst half
  let best = null;
  let bestX = -Infinity;
  for (const [x, z] of pts) {
    if (z > zBand) continue;
    if (x > bestX) {
      bestX = x;
      best = { x, z };
    }
  }
  if (!best) {
    // fallback: max X + min Z corner score
    best = pts.reduce(
      (a, p) => (p[0] - p[1] > a[0] - a[1] ? p : a),
      pts[0],
    );
    best = { x: best[0], z: best[1] };
  }
  // Slightly inside poly so containment doesn't block the first step
  return { x: best.x - 28, z: best.z + 28 };
}

/** Past the entrance (sağ-üst) — DQ exits the match here. */
function redLightExitGate() {
  const gate = redLightEntranceGate();
  return { x: gate.x + 64, z: gate.z - 64 };
}

/**
 * Set cast size 1–10: enter from sağ-üst, run to ALT lineup facing north.
 * hideExtras: surplus NPCs are hidden (kept in party), not deleted.
 * spawnMissing: fill shortfall with random catalog NPCs (cast buttons).
 */
async function setRedLightCastCount(
  count,
  { hideExtras = true, spawnMissing = true } = {},
) {
  if (!isRedLightScene()) return;
  const n = Math.max(1, Math.min(RED_LIGHT_CAST_MAX, Number(count) || 1));
  statusEl.textContent = `${n} oyuncu giriyor…`;
  const slots = redLightLineupSlots(n);
  if (!slots.length) {
    statusEl.textContent = "Walk zone yok — oyuncu dizilemedi";
    return;
  }
  const gate = redLightEntranceGate();

  // Stop any mid-run formation / clear pins so they can walk after
  redLightGame.entranceGen += 1;
  const entranceGen = redLightGame.entranceGen;
  clearNpcScriptMoves();
  if (player?.scriptMove) player.scriptMove = null;
  clearRedLightEntranceFlags();
  clearRedLightDqFlags();
  if (player?.mesh?.userData) {
    player.mesh.userData.formationSlot = null;
    player.mesh.userData.formationMove = false;
    player.mesh.visible = true;
  }

  const needNpcs = n - (player?.mesh ? 1 : 0);
  const pool = listRedLightNpcPool();

  if (hideExtras) {
    // Random who plays; rest stay in party but hidden
    for (const o of pool) {
      o.visible = true;
      if (o.userData) o.userData.redLightBench = false;
    }
    const shuffled = shuffleInPlace([...pool]);
    const keep = shuffled.slice(0, Math.min(needNpcs, shuffled.length));
    const keepSet = new Set(keep);
    for (const o of shuffled) {
      if (keepSet.has(o)) continue;
      clearNpcScriptMoves(o);
      o.visible = false;
      o.userData.redLightBench = true;
    }
  }

  for (const o of listRedLightNpcs()) {
    if (o.userData) {
      o.userData.formationSlot = null;
      o.userData.formationMove = false;
    }
  }

  // Arm immediately so "Yerlerinize" shows while NPCs spawn (first Ctrl+R cast)
  redLightGame.entranceExpect = n;
  redLightGame.entranceArrived = 0;
  armRedLightGameAfterEntrance();

  const npcs = listRedLightNpcs();

  // Spawn missing NPCs at the gate (cast size buttons) — not on /play
  if (spawnMissing) {
    const catalog = crowdCharacterCatalog();
    if (!catalog.length && needNpcs > npcs.length) {
      statusEl.textContent = "Katalogda boy/girl karakter yok";
    }
    while (npcs.length < needNpcs && catalog.length) {
      if (entranceGen !== redLightGame.entranceGen) return;
      const item = catalog[npcs.length % catalog.length];
      const i = npcs.length;
      const sx = gate.x - (i % 5) * 14;
      const sz = gate.z + Math.floor(i / 5) * 12;
      try {
        const obj = await spawnItem(item, sx, sz, {
          dir: "south",
          exactPos: true,
          recordUndo: false,
          select: false,
          playEntrance: false,
          redLightLineup: false,
        });
        if (obj) {
          obj.userData.partyMember = true;
          obj.userData.redLightBench = false;
          npcs.push(obj);
        }
      } catch (err) {
        console.warn("red light cast spawn", err);
        break;
      }
    }
  }
  if (entranceGen !== redLightGame.entranceGen) return;

  // Line up order: Main in the middle of the row when possible
  const actors = [];
  if (player?.mesh) actors.push({ obj: player.mesh, isPlayer: true });
  for (const obj of listRedLightNpcs()) {
    actors.push({ obj, isPlayer: false });
  }
  if (actors.length > 1 && actors[0].isPlayer) {
    const mid = Math.floor(actors.length / 2);
    const main = actors.shift();
    actors.splice(mid, 0, main);
  }

  const goCount = Math.min(actors.length, slots.length);
  redLightGame.entranceExpect = goCount;
  redLightGame.entranceArrived = 0;

  // Place everyone at gate + set lanes BEFORE scripts (avoids false "on line")
  for (let i = 0; i < goCount; i++) {
    const { obj, isPlayer } = actors[i];
    const slot = slots[i];
    const lane = i % 5;
    const wave = Math.floor(i / 5);
    const sx = gate.x - lane * 14 - wave * 4;
    const sz = gate.z + wave * 12 + (Math.random() - 0.5) * 4;
    obj.userData.redLightLaneX = slot.x;
    obj.userData.redLightLaneZ = slot.z;
    obj.visible = true;
    if (isPlayer) {
      player.mesh.position.set(sx, 0, sz);
      player.mesh.userData.spawnX = slot.x;
      player.mesh.userData.spawnZ = slot.z;
      player.facing = "south";
      player.syncRing?.(sx, sz);
      if (player.syncDepth) player.syncDepth(player.mesh);
    } else {
      obj.position.set(sx, 0, sz);
      obj.userData.dir = "south";
      obj.userData.spawnX = slot.x;
      obj.userData.spawnZ = slot.z;
      applyFacing(obj, "south");
      syncDepth(obj);
    }
  }

  // Refresh Yerlerinize after spawn (dog definitely in scene by now)
  showRedLightLineupPrompt();

  for (let i = 0; i < goCount; i++) {
    const { obj } = actors[i];
    const slot = slots[i];
    scriptActorTo(obj, slot.x, slot.z, {
      run: true,
      faceDir: slot.dir || "north",
      idleOnArrive: true,
      wait: i * 0.12,
      moveGen: entranceGen,
      onDone: () => noteRedLightEntranceArrive(entranceGen),
    });
  }

  redLightCastCount = goCount;
  syncRedLightCastUi();
  persistScene();
  statusEl.textContent = `${goCount} oyuncu — yerlerinize!`;
}

function findRedLightCounterDog() {
  return (
    pickables.find(
      (o) =>
        /dog_3/i.test(o.userData?.path || "") ||
        /dog_3/i.test(String(o.userData?.id || "")),
    ) || null
  );
}

function listRedLightPlayers() {
  const out = [];
  if (player?.mesh) out.push(player.mesh);
  for (const o of listRedLightNpcs()) out.push(o);
  return out;
}

function isRedLightDq(obj) {
  return !!obj?.userData?.redLightDq;
}

function clearRedLightDqFlags() {
  for (const o of listRedLightPlayers()) {
    if (!o?.userData) continue;
    o.userData.redLightDq = false;
    o.userData.redLightEliminating = false;
    o.userData.redLightFinished = false;
    o.userData.redLightFinishing = false;
    if (o.userData.formationSlot && isRedLightScene()) {
      o.userData.formationSlot = null;
    }
  }
  if (player?.mesh) {
    player.mesh.visible = true;
    player.mesh.userData.redLightDq = false;
    player.mesh.userData.redLightEliminating = false;
    player.mesh.userData.redLightFinished = false;
    player.mesh.userData.redLightFinishing = false;
  }
}

function isRedLightFinished(obj) {
  return !!obj?.userData?.redLightFinished;
}

function isRedLightFinishing(obj) {
  return !!obj?.userData?.redLightFinishing;
}

function listRedLightAlive() {
  return listRedLightPlayers().filter(
    (o) => !isRedLightDq(o) && !o.userData?.redLightEliminating,
  );
}

function stopRedLightGame({ clearDq = true } = {}) {
  redLightGame.active = false;
  redLightGame.pendingStart = false;
  redLightGame.phase = "idle";
  redLightGame.countNum = RED_LIGHT_COUNT_MIN;
  redLightGame.phaseT = 0;
  redLightGame.settleAcc = 0;
  redLightGame.pendingSince = 0;
  redLightGame.entranceExpect = 0;
  redLightGame.entranceArrived = 0;
  if (redLightGame.dogKey) {
    const entry = worldLabelMap.get(redLightGame.dogKey);
    if (entry) {
      entry.bubbleEl.classList.add("hidden");
      entry.bubbleEl.textContent = "";
      entry.hideAt = 0;
    }
  }
  redLightGame.dogKey = null;
  if (clearDq) clearRedLightDqFlags();
}

function clearRedLightEntranceFlags() {
  for (const o of listRedLightPlayers()) {
    if (!o?.userData) continue;
    o.userData.formationMove = false;
  }
  if (player?.scriptMove && !player.scriptMove._rlElim) {
    player.scriptMove = null;
  }
}

function redLightCastStillEntering() {
  const cast = new Set(listRedLightPlayers());
  if (player?.scriptMove && !player.scriptMove._rlElim) return true;
  for (const sm of npcScriptMoves) {
    if (sm?.obj && cast.has(sm.obj)) return true;
  }
  // formationMove without a live script = stale flag (was blocking countdown)
  for (const o of cast) {
    if (!o.userData?.formationMove) continue;
    const live =
      o === player?.mesh
        ? !!player?.scriptMove
        : npcScriptMoves.some((sm) => sm.obj === o);
    if (live) return true;
    o.userData.formationMove = false;
  }
  return false;
}

/** How many cast members are close enough to their alt lane. */
function redLightCastNearLaneCount() {
  const actors = listRedLightPlayers().filter((o) => !isRedLightDq(o));
  let ok = 0;
  for (const o of actors) {
    const tx = o.userData?.redLightLaneX ?? o.userData?.spawnX;
    const tz = o.userData?.redLightLaneZ ?? o.userData?.spawnZ;
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) continue;
    if (Math.hypot(o.position.x - tx, o.position.z - tz) <= 72) ok += 1;
  }
  return { ok, total: actors.length };
}

function redLightCastReadyOnLine() {
  const { ok, total } = redLightCastNearLaneCount();
  const need = Math.max(1, redLightGame.entranceExpect || total);
  return total >= need && ok >= need;
}

/** Snap one cast member onto their alt lane and stop any entrance run. */
function settleRedLightActorOnLane(o) {
  if (!o?.userData) return;
  const tx = o.userData.redLightLaneX;
  const tz = o.userData.redLightLaneZ;
  if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
  const isPlayer = o === player?.mesh;
  clearNpcScriptMoves(o);
  if (isPlayer) {
    player.scriptMove = null;
    player.keys?.clear();
    player.mesh.position.set(tx, 0, tz);
    player.syncRing?.(tx, tz);
    if (player.syncDepth) player.syncDepth(player.mesh);
    player.facing = "north";
    player.anim = "idle";
    player.applyFrame?.();
  } else {
    o.position.set(tx, 0, tz);
    o.userData.dir = "north";
    applyFacing(o, "north");
    syncDepth(o);
    attachIdle(o, o.userData.path, "north", { allowSouthFallback: true }).catch(
      () => {},
    );
  }
  o.userData.formationMove = false;
  o.userData.formationSlot = { x: tx, z: tz };
}

/** Keep cast on lineup slots while waiting for countdown (soft-sep won't shove them). */
function pinRedLightCastToLanes() {
  for (const o of listRedLightPlayers()) {
    if (!o?.userData) continue;
    if (o.userData.redLightDq || o.userData.redLightEliminating) continue;
    const tx = o.userData.redLightLaneX;
    const tz = o.userData.redLightLaneZ;
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) continue;
    const dist = Math.hypot(o.position.x - tx, o.position.z - tz);
    // Arrived: stop running south past the slot — settle & idle facing north
    if (dist <= 72) {
      const stillRunning =
        !!o.userData.formationMove ||
        (o === player?.mesh && !!player?.scriptMove) ||
        npcScriptMoves.some((sm) => sm.obj === o);
      if (stillRunning || dist > 10) settleRedLightActorOnLane(o);
      else {
        o.userData.formationMove = false;
        o.userData.formationSlot = { x: tx, z: tz };
      }
    }
  }
}

function noteRedLightEntranceArrive(gen) {
  if (gen != null && gen !== redLightGame.entranceGen) return;
  if (!redLightGame.pendingStart) return;
  redLightGame.entranceArrived += 1;
  if (
    redLightGame.entranceExpect > 0 &&
    redLightGame.entranceArrived >= redLightGame.entranceExpect
  ) {
    flushRedLightEntranceAndStart();
  }
}

function flushRedLightEntranceAndStart() {
  if (!redLightGame.pendingStart || redLightGame.active) return;
  // Invalidate delayed entrance setTimeouts / finishFace (same gen was restarting runs)
  redLightGame.entranceGen += 1;
  clearNpcScriptMoves();
  if (player?.scriptMove) player.scriptMove = null;
  for (const o of listRedLightPlayers()) {
    settleRedLightActorOnLane(o);
  }
  redLightGame.entranceArrived = Math.max(
    redLightGame.entranceArrived,
    redLightGame.entranceExpect,
  );
  startRedLightGame();
}

function showRedLightLineupPrompt() {
  faceRedLightDog("south").catch(() => {});
  redLightDogBubble("Yerlerinize", 20000);
}

/** Until /play — dog shows the command so players know what to type. */
function showRedLightPlayPrompt() {
  if (!isRedLightScene()) return;
  if (redLightGame.active || redLightGame.pendingStart) return;
  clearRedLightBenchHide();
  faceRedLightDog("south").catch(() => {});
  redLightDogBubble("/play", 60000);
}

function armRedLightGameAfterEntrance() {
  if (!isRedLightScene()) return;
  // Don't wipe entranceExpect / arrived — caller sets those before arming
  redLightGame.active = false;
  redLightGame.phase = "idle";
  redLightGame.pendingStart = true;
  redLightGame.pendingSince = performance.now() / 1000;
  redLightGame.minStartAt =
    redLightGame.pendingSince + RED_LIGHT_MIN_LINEUP_SEC;
  redLightGame.settleAcc = 0;
  showRedLightLineupPrompt();
  statusEl.textContent = "Red light — yerlerinize!";
}

function startRedLightGame() {
  if (!isRedLightScene()) return;
  if (redLightGame.active) return;
  const dog = findRedLightCounterDog();
  if (!dog) {
    // Don't kill pendingStart — dog may still be loading; tick will retry
    statusEl.textContent = "Red light — sayan köpek bekleniyor…";
    showRedLightLineupPrompt();
    return;
  }
  // Drop stale entrance flags / lineup pins so countdown play can move
  redLightGame.entranceGen += 1; // cancel any late entrance callbacks
  clearRedLightEntranceFlags();
  clearNpcScriptMoves();
  if (player?.scriptMove) player.scriptMove = null;
  clearRedLightDqFlags();
  // Snap to lanes, face north, then free pins so they can walk on green light
  for (const o of listRedLightPlayers()) {
    settleRedLightActorOnLane(o);
    if (o.userData) o.userData.formationSlot = null;
  }
  redLightGame.active = true;
  redLightGame.pendingStart = false;
  redLightGame.settleAcc = 0;
  redLightGame.entranceExpect = 0;
  redLightGame.entranceArrived = 0;
  redLightGame.cornerI = 0;
  redLightGame.dogKey = labelKeyFor(dog);
  // Turn away + start countdown immediately (don't await anim load — that blocked 1st cast)
  faceRedLightDog("north").catch(() => {});
  beginRedLightCountPhase();
  statusEl.textContent = "Red light — köpek sayıyor (yeşil ışık)";
}

/** Force dog_3 facing — clear anim so tickAnims won't overwrite the sprite. */
async function faceRedLightDog(dir) {
  const dog = findRedLightCounterDog();
  if (!dog?.userData) return false;
  dog.userData.anim = null;
  dog.userData.animName = null;
  dog.userData.dir = dir;

  if (!dog.userData.rotTextures?.[dir]) {
    const dirs = dog.userData.dirs?.length ? dog.userData.dirs : DIRS;
    try {
      const map = await loadRotationTextures(dog.userData.path, dirs);
      dog.userData.rotTextures = {
        ...(dog.userData.rotTextures || {}),
        ...map,
      };
      const keys = Object.keys(dog.userData.rotTextures);
      if (keys.length) dog.userData.dirs = keys;
    } catch {
      /* */
    }
  }

  const tex = dog.userData.rotTextures?.[dir];
  if (tex) {
    setMap(dog, tex);
  } else {
    try {
      await setDirection(dog, dir, { recordUndo: false });
    } catch {
      /* */
    }
  }

  // Don't await idle — first-load attachIdle was delaying/blocking countdown
  attachIdle(dog, dog.userData.path, dir, { allowSouthFallback: true }).catch(
    () => {},
  );
  return true;
}

function beginRedLightCountPhase() {
  faceRedLightDog("north").catch(() => {});
  redLightGame.phase = "counting";
  // Random 2–5 so players can't memorize the turn timing
  redLightGame.countNum = randomRedLightCount();
  redLightGame.phaseT = 0;
  redLightDogBubble(
    String(redLightGame.countNum),
    RED_LIGHT_COUNT_BEAT * 1000 + 200,
  );
}

function beginRedLightWatchPhase() {
  faceRedLightDog("south").catch(() => {});
  redLightGame.phase = "watching";
  redLightGame.phaseT = 0;
  redLightDogBubble("!", RED_LIGHT_WATCH_SEC * 1000);
  statusEl.textContent = "Red light — köpek baktı! (3 sn)";
  catchRedLightMovers();
}

function redLightDogBubble(text, holdMs = 1200) {
  const dog = findRedLightCounterDog();
  if (!dog) return;
  const key = labelKeyFor(dog);
  if (!key) return;
  redLightGame.dogKey = key;
  const entry = ensureWorldLabel(key, " ", dog.userData?.path);
  entry.root.classList.add("rl-dog-label");
  entry.nameEl.textContent = "";
  entry.nameEl.classList.add("hidden");
  entry.obj = dog;
  entry.bubbleEl.classList.add("rl-countdown");
  entry.bubbleEl.textContent = String(text);
  entry.bubbleEl.classList.remove("hidden");
  entry.hideAt = performance.now() + holdMs;
  entry.root.classList.remove("hidden");
}

/** ALT edge corners of walkZone — DQ holding spots. */
function redLightDqCorner() {
  if (!streetWalkActive()) {
    const side = redLightGame.cornerI % 2 === 0 ? -1 : 1;
    redLightGame.cornerI += 1;
    return { x: side * 200, z: 360 };
  }
  const pts = ensureStreetWalkZone().pts;
  let altI = 0;
  let altMid = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const midZ = (a[1] + b[1]) / 2;
    if (midZ > altMid) {
      altMid = midZ;
      altI = i;
    }
  }
  const a = pts[altI];
  const b = pts[(altI + 1) % pts.length];
  const inset = 22;
  const ends = [
    {
      x: a[0] + (b[0] - a[0]) * 0.06,
      z: a[1] + (b[1] - a[1]) * 0.06 - inset,
    },
    {
      x: a[0] + (b[0] - a[0]) * 0.94,
      z: a[1] + (b[1] - a[1]) * 0.94 - inset,
    },
  ];
  const c = ends[redLightGame.cornerI % 2];
  redLightGame.cornerI += 1;
  return c;
}

function isRedLightActorMoving(obj) {
  if (
    !obj ||
    isRedLightDq(obj) ||
    isRedLightFinished(obj) ||
    isRedLightFinishing(obj)
  ) {
    return false;
  }
  // DQ run-out / entrance lineup don't count as "caught walking"
  if (obj.userData?.redLightEliminating) return false;
  if (obj.userData?.formationMove && !redLightGame.active) return false;
  if (player?.mesh && obj === player.mesh) {
    if (player.scriptMove && !player.scriptMove._rlElim) return true;
    if (player.keys?.size) {
      const { dx, dz } = player.inputVector?.() || { dx: 0, dz: 0 };
      if (dx || dz) return true;
    }
    if (Math.hypot(player.vx || 0, player.vz || 0) > RED_LIGHT_MOVE_EPS) return true;
    return false;
  }
  if (obj.userData?.formationMove) return true;
  for (const sm of npcScriptMoves) {
    if (sm.obj !== obj) continue;
    if ((sm.wait || 0) > 0) continue;
    if (sm.left > 1) return true;
  }
  if (Math.hypot(obj.userData?._moveDx || 0, obj.userData?._moveDz || 0) > RED_LIGHT_MOVE_EPS) {
    return true;
  }
  return false;
}

function catchRedLightMovers() {
  if (!redLightGame.active || redLightGame.phase !== "watching") return;
  for (const obj of listRedLightPlayers()) {
    if (
      isRedLightDq(obj) ||
      isRedLightFinished(obj) ||
      isRedLightFinishing(obj)
    ) {
      continue;
    }
    if (isRedLightActorMoving(obj)) disqualifyRedLightActor(obj);
  }
}

function exitRedLightActorFromMatch(obj) {
  const isPlayer = !!(player?.mesh && obj === player.mesh);
  const key = labelKeyFor(obj);
  if (key) removeWorldLabel(key);
  if (isPlayer) {
    player.keys?.clear();
    player.scriptMove = null;
    player.stopActions?.();
    if (player.mesh) {
      player.mesh.visible = false;
      player.mesh.userData.redLightEliminating = false;
      player.mesh.userData.redLightDq = true;
      player.mesh.userData.formationSlot = null;
    }
  } else {
    clearNpcScriptMoves(obj);
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  checkRedLightGameOver();
}

function disqualifyRedLightActor(obj) {
  if (
    !obj?.userData ||
    obj.userData.redLightDq ||
    obj.userData.redLightFinished ||
    obj.userData.redLightFinishing
  ) {
    return;
  }
  obj.userData.redLightDq = true;
  obj.userData.redLightEliminating = true;
  obj.userData.formationSlot = null;

  const isPlayer = !!(player?.mesh && obj === player.mesh);
  if (isPlayer) {
    player.keys?.clear();
    player.scriptMove = null;
    player.stopActions?.();
  } else {
    clearNpcScriptMoves(obj);
  }

  const exit = redLightExitGate();
  const faceDir =
    dirFromVector(exit.x - obj.position.x, exit.z - obj.position.z) ||
    "north-east";
  const name = isPlayer
    ? PLAYER_CHAT_NAME
    : shortCharacterName(obj.userData?.label, obj.userData?.path);
  statusEl.textContent = `${name} diskalifiye — girişten çıkıyor`;
  speakAs(obj, "Yakalandın", { danger: true, holdMs: 3500 });

  scriptActorTo(obj, exit.x, exit.z, {
    run: true,
    faceDir,
    idleOnArrive: false,
    snap: true,
    onDone: () => exitRedLightActorFromMatch(obj),
  });
  if (isPlayer && player.scriptMove) player.scriptMove._rlElim = true;
}

/** Üst (north / low-Z) walkZone edge — finish line. */
function redLightFinishEdge() {
  if (!streetWalkActive()) {
    return { z: -280, x0: -160, x1: 160 };
  }
  const pts = ensureStreetWalkZone().pts;
  let ustI = 0;
  let ustMid = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const midZ = (a[1] + b[1]) / 2;
    if (midZ < ustMid) {
      ustMid = midZ;
      ustI = i;
    }
  }
  const a = pts[ustI];
  const b = pts[(ustI + 1) % pts.length];
  return {
    z: (a[1] + b[1]) / 2,
    x0: Math.min(a[0], b[0]),
    x1: Math.max(a[0], b[0]),
    ax: a[0],
    az: a[1],
    bx: b[0],
    bz: b[1],
  };
}

function redLightTouchesFinish(obj) {
  if (!obj) return false;
  // Feet = same point walkZone containment uses (mesh sits south of feet)
  const x = obj.position.x;
  const z = obj.position.z + FEET_NUDGE_Z;
  const r =
    obj === player?.mesh ? player?.radius || 22 : NPC_WALK_RADIUS || 18;

  if (!streetWalkActive()) {
    return z <= -250;
  }
  const pts = ensureStreetWalkZone().pts;
  if (!pts?.length) return false;
  const edge = redLightFinishEdge();
  // Northern band only (don't trigger on alt / side walls)
  const band = Math.max(56, r * 2.8);
  if (z > edge.z + band) return false;
  if (x < edge.x0 - 28 || x > edge.x1 + 28) return false;
  // Pressed against walkZone rim (containment stops at ~r*0.35)
  const d = distToPolyEdge(x, z, pts);
  return d <= r * 0.55 + 12;
}

function faceRedLightActorSouth(obj, { settle = true } = {}) {
  const isPlayer = !!(player?.mesh && obj === player.mesh);
  if (isPlayer) {
    player.facing = "south";
    player.keys?.clear();
    if (settle) {
      player.scriptMove = null;
      player.anim = "idle";
      player.applyFrame?.();
    } else if (player.facing !== "south") {
      player.applyFrame?.();
    }
  } else {
    if (settle) clearNpcScriptMoves(obj);
    if (obj.userData.dir !== "south") {
      obj.userData.dir = "south";
      applyFacing(obj, "south");
      if (settle) {
        attachIdle(obj, obj.userData.path, "south", {
          allowSouthFallback: true,
        }).catch(() => {});
      }
    }
  }
}

/** Hold pose on üst edge, same X as alt lineup lane. */
function redLightFinishHoldPos(obj) {
  const laneX = Number.isFinite(obj.userData?.redLightLaneX)
    ? obj.userData.redLightLaneX
    : Number.isFinite(obj.userData?.spawnX)
      ? obj.userData.spawnX
      : obj.position.x;
  const r =
    obj === player?.mesh ? player?.radius || 22 : NPC_WALK_RADIUS || 18;
  const edge = redLightFinishEdge();
  // Slightly inside üst edge so lateral run along the line isn't jammed
  const feetZ = edge.z + Math.max(20, r * 1.05);
  const clamped = projectIntoWalkZone(laneX, feetZ, r);
  return { x: clamped.x, z: clamped.z - FEET_NUDGE_Z };
}

/** Lane hold done — face south + pin (Vardın already shown on first touch). */
function settleRedLightFinished(obj, hold) {
  if (!obj?.userData || obj.userData.redLightDq) return;
  const isPlayer = !!(player?.mesh && obj === player.mesh);
  const pos = hold || redLightFinishHoldPos(obj);

  obj.userData.redLightFinishing = false;
  obj.userData.redLightFinished = true;
  obj.userData.formationMove = false;

  if (isPlayer) {
    player.keys?.clear();
    player.scriptMove = null;
    player.mesh.position.set(pos.x, 0, pos.z);
    player.syncRing?.(pos.x, pos.z);
    if (player.syncDepth) player.syncDepth(player.mesh);
  } else {
    clearNpcScriptMoves(obj);
    obj.position.set(pos.x, 0, pos.z);
    syncDepth(obj);
  }

  faceRedLightActorSouth(obj, { settle: true });
  if (!isPlayer) {
    obj.userData.dir = "south";
    applyFacing(obj, "south");
    attachIdle(obj, obj.userData.path, "south", {
      allowSouthFallback: true,
    }).catch(() => {});
  }

  obj.userData.formationSlot = { x: pos.x, z: pos.z };

  const name = isPlayer
    ? PLAYER_CHAT_NAME
    : shortCharacterName(obj.userData?.label, obj.userData?.path);
  const alive = listRedLightAlive();
  const done = alive.filter((o) => isRedLightFinished(o)).length;
  statusEl.textContent = `${name} üstte — ${done}/${alive.length} (aşağı bakıyor, kilitli)`;
  checkRedLightGameOver();
}

/** Reached üst collision — Vardın immediately, then run to lane X. */
function markRedLightFinished(obj) {
  if (
    !obj?.userData ||
    obj.userData.redLightFinished ||
    obj.userData.redLightFinishing ||
    obj.userData.redLightDq
  ) {
    return;
  }
  const isPlayer = !!(player?.mesh && obj === player.mesh);
  const hold = redLightFinishHoldPos(obj);
  const dist = Math.hypot(obj.position.x - hold.x, obj.position.z - hold.z);

  // Count as arrived + bubble the moment they touch üst collision
  obj.userData.redLightFinished = true;
  speakAs(obj, "Vardın", { success: true, holdMs: 4000 });

  const name = isPlayer
    ? PLAYER_CHAT_NAME
    : shortCharacterName(obj.userData?.label, obj.userData?.path);
  const alive = listRedLightAlive();
  const done = alive.filter((o) => isRedLightFinished(o)).length;
  statusEl.textContent = `${name} üstte — ${done}/${alive.length}`;

  // Already on lane — settle in place
  if (dist <= 16) {
    settleRedLightFinished(obj, hold);
    return;
  }

  obj.userData.redLightFinishing = true;
  obj.userData.formationSlot = null;

  if (isPlayer) {
    player.keys?.clear();
    player.scriptMove = null;
    player.stopActions?.();
  } else {
    clearNpcScriptMoves(obj);
  }

  scriptActorTo(obj, hold.x, hold.z, {
    run: true,
    faceDir: "south",
    idleOnArrive: true,
    onDone: () => settleRedLightFinished(obj, hold),
  });
  if (isPlayer && player.scriptMove) player.scriptMove._rlFinish = true;
  checkRedLightGameOver();
}

function checkRedLightWinners() {
  if (!redLightGame.active) return;

  for (const obj of listRedLightAlive()) {
    if (isRedLightFinished(obj) || isRedLightFinishing(obj)) continue;
    if (redLightTouchesFinish(obj)) markRedLightFinished(obj);
  }

  const alive = listRedLightAlive();
  if (!alive.length) return;

  if (alive.every((o) => isRedLightFinished(o))) {
    statusEl.textContent = "Tüm oyuncular üst collision'a değdi — kazandınız!";
    endRedLightGame({ won: true });
  }
}

function checkRedLightGameOver() {
  if (!redLightGame.active) return;
  const alive = listRedLightAlive();
  if (!alive.length) {
    statusEl.textContent = "Herkes diskalifiye — oyun bitti";
    endRedLightGame({ won: false });
    return;
  }
  if (alive.every((o) => isRedLightFinished(o))) {
    statusEl.textContent = "Tüm oyuncular üst collision'a değdi — kazandınız!";
    endRedLightGame({ won: true });
  }
}

function endRedLightGame({ won = false } = {}) {
  faceRedLightDog("south").catch(() => {});
  stopRedLightGame({ clearDq: true });
  redLightDogBubble(won ? "✓" : "OK", 1600);
  // After brief result, /play returns via tick / next prompt
  setTimeout(() => {
    if (isRedLightScene() && !redLightGame.active && !redLightGame.pendingStart) {
      showRedLightPlayPrompt();
    }
  }, 1700);
}

function tickRedLightGame(dt) {
  if (!isRedLightScene()) {
    if (redLightGame.active || redLightGame.pendingStart) stopRedLightGame();
    return;
  }

  if (redLightGame.pendingStart) {
    pinRedLightCastToLanes();
    // Keep "Yerlerinize" visible while they line up
    const dog = findRedLightCounterDog();
    if (dog) {
      const key = labelKeyFor(dog);
      const entry = key ? worldLabelMap.get(key) : null;
      if (!entry || entry.bubbleEl.classList.contains("hidden")) {
        showRedLightLineupPrompt();
      } else {
        entry.hideAt = performance.now() + 5000;
        entry.bubbleEl.textContent = "Yerlerinize";
        entry.bubbleEl.classList.add("rl-countdown");
        entry.bubbleEl.classList.remove("hidden");
      }
    }
    const now = performance.now() / 1000;
    const waited =
      redLightGame.pendingSince > 0 ? now - redLightGame.pendingSince : 0;
    const canStart = now >= (redLightGame.minStartAt || 0);
    const onLine = redLightCastReadyOnLine();
    if (canStart && onLine) redLightGame.settleAcc += dt;
    else if (!onLine) redLightGame.settleAcc = 0;

    // Min lineup time so Yerlerinize is visible; then start when on line / timeout
    if (
      canStart &&
      (redLightGame.settleAcc >= RED_LIGHT_SETTLE_HOLD ||
        waited >= RED_LIGHT_FORCE_START)
    ) {
      flushRedLightEntranceAndStart();
    }
    return;
  }

  if (!redLightGame.active) {
    // Idle on scene — keep /play on the dog until someone starts
    const dog = findRedLightCounterDog();
    if (dog) {
      const key = labelKeyFor(dog);
      const entry = key ? worldLabelMap.get(key) : null;
      if (
        !entry ||
        entry.bubbleEl.classList.contains("hidden") ||
        entry.bubbleEl.textContent !== "/play"
      ) {
        showRedLightPlayPrompt();
      } else {
        entry.hideAt = performance.now() + 60000;
        entry.bubbleEl.textContent = "/play";
        entry.bubbleEl.classList.add("rl-countdown");
        entry.bubbleEl.classList.remove("hidden");
      }
    }
    return;
  }

  checkRedLightWinners();
  if (!redLightGame.active) return;

  if (redLightGame.phase === "counting") {
    redLightGame.phaseT += dt;
    if (redLightGame.phaseT >= RED_LIGHT_COUNT_BEAT) {
      redLightGame.phaseT = 0;
      redLightGame.countNum -= 1;
      if (redLightGame.countNum >= 1) {
        redLightDogBubble(
          String(redLightGame.countNum),
          RED_LIGHT_COUNT_BEAT * 1000 + 200,
        );
      } else {
        beginRedLightWatchPhase();
      }
    }
    return;
  }

  if (redLightGame.phase === "watching") {
    catchRedLightMovers();
    redLightGame.phaseT += dt;
    if (redLightGame.phaseT >= RED_LIGHT_WATCH_SEC) {
      if (!redLightGame.active) return;
      beginRedLightCountPhase();
      statusEl.textContent = "Red light — köpek sayıyor (yeşil ışık)";
    }
  }
}

function nightClubRoomObj() {
  return pickables.find((o) =>
    /night_club_inside/i.test(o.userData?.path || ""),
  );
}

/** World-space walk poly for night_club_inside (null if missing). */
function nightClubWalkPts() {
  const room = nightClubRoomObj();
  if (!room) return null;
  const box = colFootprint(room);
  return box?.pts?.length >= 3 ? box.pts : null;
}

/**
 * Pack crowd inside night club walk poly:
 * — few → tight center band
 * — more → expand evenly toward both alt + üst (and sides)
 * — at 50 → fill full depth, centered (no empty strip at alt)
 */
function nightClubCrowdSlots(count) {
  const n = Math.max(0, Math.min(50, Number(count) || 0));
  const pts = nightClubWalkPts();
  if (!pts || n <= 0) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const width = maxX - minX;
  const sidePad = Math.max(48, width * 0.22);
  const edgePad = 4;
  const gapX = 34;
  const gapZ = 22;

  const ustZAtX = (x) => {
    for (let z = minZ; z <= maxZ; z += 1) {
      if (pointInPoly(x, z, pts)) return z;
    }
    return null;
  };
  const altZAtX = (x) => {
    for (let z = maxZ; z >= minZ; z -= 1) {
      if (pointInPoly(x, z, pts)) return z;
    }
    return null;
  };

  const allColumns = [];
  for (let x = minX + sidePad; x <= maxX - sidePad; x += gapX) {
    const ustZ = ustZAtX(x);
    const altZ = altZAtX(x);
    if (ustZ == null || altZ == null) continue;
    if (altZ - ustZ < gapZ * 2) continue;
    allColumns.push({ x, ustZ, altZ });
  }
  if (!allColumns.length) return [];

  const t = Math.min(1, n / 50);
  const maxCols = allColumns.length;
  const useCols = Math.max(
    1,
    Math.min(maxCols, Math.ceil(2 + t * (maxCols - 2))),
  );
  const midCol = (maxCols - 1) / 2;
  const columns = allColumns
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => Math.abs(a.i - midCol) - Math.abs(b.i - midCol))
    .slice(0, useCols)
    .sort((a, b) => a.x - b.x);

  // Full floor depth: reach true alt + üst edges (not the shy min-alt)
  const bandAlt = Math.max(...columns.map((c) => c.altZ)) - edgePad;
  const bandUst = Math.min(...columns.map((c) => c.ustZ)) + edgePad;
  const fullSpan = Math.max(gapZ, bandAlt - bandUst);
  const geoMid = (bandAlt + bandUst) / 2;
  // Home sits lower (toward alt) so small crowds aren't too yüksek
  const homeMid = geoMid + (bandAlt - geoMid) * 0.45;
  const usedSpan = fullSpan * t;
  // Expand more toward alt than üst (≈70/30), then clamp to floor
  let zHi = homeMid + usedSpan * 0.7;
  let zLo = homeMid - usedSpan * 0.3;
  if (zHi > bandAlt) {
    zLo -= zHi - bandAlt;
    zHi = bandAlt;
  }
  if (zLo < bandUst) {
    zHi += bandUst - zLo;
    zLo = bandUst;
  }
  zHi = Math.min(bandAlt, zHi);
  zLo = Math.max(bandUst, zLo);
  const span = Math.max(0, zHi - zLo);
  const cols = columns.length;
  const needRows = Math.max(1, Math.ceil(n / Math.max(1, cols)));
  const rowsBySpan = Math.max(1, Math.round(span / gapZ) + 1);
  const rows = Math.max(needRows, rowsBySpan);
  const zStep = rows <= 1 ? 0 : span / (rows - 1);
  const ringMid = (zHi + zLo) / 2;

  const slots = [];
  const tryPlace = (x, z) => {
    if (slots.length >= n) return;
    if (z < zLo - 1 || z > zHi + 1) return;
    if (!pointInPoly(x, z, pts)) return;
    if (slots.some((s) => Math.hypot(s.x - x, s.z - z) < 14)) return;
    slots.push({ x, z });
  };

  for (let row = 0; row < rows && slots.length < n; row++) {
    const xOff = (row % 2) * (gapX * 0.4);
    const z = zHi - row * zStep;
    const order = columns
      .map((c, i) => ({ c, i }))
      .sort(
        (a, b) =>
          Math.abs(a.i - (cols - 1) / 2) - Math.abs(b.i - (cols - 1) / 2),
      );
    for (const { c: col } of order) {
      tryPlace(col.x + xOff, z);
    }
  }

  // Top up: prefer alt side first, then üst
  for (let ring = 0; slots.length < n && ring < rows + 4; ring++) {
    for (const sign of [1, -1]) {
      const z = ringMid + sign * ring * (gapZ * 0.5);
      const xOff = (ring % 2) * (gapX * 0.4);
      for (const col of columns) {
        tryPlace(col.x + xOff, z);
      }
    }
  }
  return slots.slice(0, n);
}

/**
 * Sol-alt giriş: collision içinde, bbox sol-alt köşesine (minX, maxZ)
 * en yakın nokta — biraz içeride kalsın.
 */
function nightClubEntranceGate() {
  const pts = nightClubWalkPts();
  if (!pts?.length) return { x: -160, z: 250 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const cornerX = minX;
  const cornerZ = maxZ;
  let best = null;
  let bestD = Infinity;
  // Dense scan near sol-alt; prefer points deep in the corner
  for (let x = minX; x <= minX + 120; x += 3) {
    for (let z = maxZ; z >= maxZ - 100; z -= 3) {
      if (!pointInPoly(x, z, pts)) continue;
      // Must stay clearly inside (not on the wire)
      if (distToPolyEdge(x, z, pts) < 6) continue;
      const d = Math.hypot(x - cornerX, z - cornerZ);
      if (d < bestD) {
        bestD = d;
        best = { x, z };
      }
    }
  }
  if (best) return best;
  // Last resort: any in-poly near corner
  for (let x = minX; x <= minX + 140; x += 4) {
    for (let z = maxZ; z >= maxZ - 120; z -= 4) {
      if (!pointInPoly(x, z, pts)) continue;
      return { x, z };
    }
  }
  return { x: (minX + maxX) / 2, z: maxZ - 20 };
}

/** Boy/girl stand catalog entries for crowd spawn (skip sit-only). */
function crowdCharacterCatalog() {
  const byFolder = new Map();
  for (const it of catalogItemById.values()) {
    if (it.kind !== "character") continue;
    const p = it.path || "";
    if (!/\/characters\/(boy_|girl_)/i.test(p)) continue;
    if (!/\/states\//i.test(p)) continue;
    if (/sit/i.test(p) && !/stand/i.test(p)) continue;
    if (!/stand/i.test(p)) continue;
    const folder = (p.match(/\/characters\/([^/]+)/i) || [])[1];
    if (!folder) continue;
    if (!byFolder.has(folder)) byFolder.set(folder, it);
  }
  return [...byFolder.values()];
}

function clearCrowdExtras() {
  const doomed = pickables.filter((o) => o.userData?.crowdExtra);
  for (const obj of doomed) {
    clearNpcScriptMoves(obj);
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  return doomed.length;
}

async function spawnCrowdExtras(count) {
  const catalog = crowdCharacterCatalog();
  if (!catalog.length) {
    statusEl.textContent = "Kalabalık için boy/girl karakter yok";
    return 0;
  }
  const club = isNightClubScene();
  const n = Math.max(0, Math.min(50, Number(count) || 0));
  const dirs = ["south", "south-east", "south-west", "east", "west"];
  let placed = 0;

  if (club) {
    const slots = nightClubCrowdSlots(n);
    if (!slots.length) {
      statusEl.textContent = "Night club walk zone yok — kalabalık eklenemedi";
      return 0;
    }
    const gate = nightClubEntranceGate();
    for (let i = 0; i < slots.length; i++) {
      const item = catalog[i % catalog.length];
      const slot = slots[i];
      const dir = dirs[i % dirs.length];
      // Queue along alt edge (sağa), not upward — avoid stacking into the floor
      const lane = i % 8;
      const wave = Math.floor(i / 8);
      const sx = gate.x + 6 + lane * 12 + wave * 3 + (Math.random() - 0.5) * 4;
      const sz = gate.z - 4 - (Math.random() - 0.5) * 5;
      try {
        const obj = await spawnItem(item, sx, sz, {
          dir,
          exactPos: true,
          recordUndo: false,
          select: false,
          playEntrance: false,
        });
        obj.userData.crowdExtra = true;
        obj.userData.partyMember = true; // travels with street → night club / other scenes
        obj.userData.formationMove = true; // before first frame soft-sep / blockers
        // Enter from sol alt, run to floor slot, then dance
        scriptActorTo(obj, slot.x, slot.z, {
          run: true,
          faceDir: dir,
          idleOnArrive: false,
          wait: i * 0.14,
          onDone: () => {
            attachDance(obj, obj.userData.path, dir, {
              allowSouthFallback: true,
            })
              .then((ok) => {
                if (ok) return;
                return attachIdle(obj, obj.userData.path, dir, {
                  allowSouthFallback: true,
                });
              })
              .catch(() => {});
          },
        });
        placed += 1;
      } catch (err) {
        console.warn("crowd spawn", err);
      }
    }
    return placed;
  }

  const home = streetGatherTarget || { x: 0, z: 180 };
  const cols = 10;
  const gapX = 42;
  const gapZ = 46;
  const post = findScenePostOffice();
  const garage = post ? postOfficeGarageExit(post) : null;
  for (let i = 0; i < n; i++) {
    const item = catalog[i % catalog.length];
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Final gather slot (where they walk to)
    const x = home.x + (col - (cols - 1) / 2) * gapX + (row % 2) * 12;
    const z = home.z - 40 - row * gapZ;
    const dir = dirs[i % dirs.length];
    // Spawn AT garage so idle-load never flashes them across the plaza
    const lane = i % 8;
    const wave = Math.floor(i / 8);
    const sx = garage ? garage.x + (lane - 3.5) * 10 : x;
    const sz = garage ? garage.z + wave * 8 : z;
    try {
      const obj = await spawnItem(item, sx, sz, {
        dir,
        exactPos: true,
        recordUndo: false,
        select: false,
        playEntrance: false,
      });
      obj.userData.crowdExtra = true;
      obj.userData.partyMember = true;
      obj.userData.spawnX = x;
      obj.userData.spawnZ = z;
      if (garage) {
        // Hide during idle decode — beginPostOfficeEntrance reveals at garage
        obj.visible = false;
        obj.position.set(sx, 0, sz);
        syncDepth(obj);
        beginPostOfficeEntrance(obj, { x, z }, { stagger: 0.12 + i * 0.1 });
      }
      placed += 1;
    } catch (err) {
      console.warn("crowd spawn", err);
    }
  }
  if (post && placed > 0) {
    statusEl.textContent = `Kalabalık: ${placed} · postane garajından…`;
  }
  return placed;
}

async function setTruthDareCrowdCount(count) {
  const n = Number(count) || 0;
  if (!TRUTH_DARE_CROWD_COUNTS.includes(n)) return;
  if (!isCrowdScene()) return;
  statusEl.textContent = `${n} karakter hazırlanıyor…`;
  // Stop current formation mid-run
  clearNpcScriptMoves();
  if (player?.scriptMove) player.scriptMove = null;
  clearTruthDareFormationLocks();
  truthDareActive = false;
  truthDareSnapshot = new Map();
  // Replace whole traveling cast with this crowd size
  for (const obj of [...listPartyCharacters()]) {
    clearNpcScriptMoves(obj);
    detachPlacedObject(obj);
    disposePlacedObject(obj);
  }
  clearCrowdExtras();
  const placed = await spawnCrowdExtras(n);
  truthDareCrowdCount = n;
  if (partySnapshotEnabled) snapshotPartyFromWorld();
  syncTruthDareCrowdUi();
  if (activeSceneId === "dogrulukmu_cesaretmi") {
    await startTruthDareFormation();
    statusEl.textContent = `Kalabalık: ${placed} karakter · dizilim`;
  } else if (isNightClubScene()) {
    statusEl.textContent = `Kalabalık: ${placed} · night club`;
  } else {
    statusEl.textContent = `Kalabalık: ${placed} — sahneler arası geliyor`;
  }
  persistScene();
}

/** v1: random 4 — swap later for fair pick. */
function pickTruthDareFour(pool) {
  const list = pool.slice();
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list.slice(0, Math.min(4, list.length));
}

function truthDareBenchObjects() {
  const overlay = pickables.filter(
    (o) =>
      o.userData?.sceneOverlay === "dogrulukmu_cesaretmi" &&
      /outdoorPark\/bench|outdoorpark\/bench/i.test(o.userData?.path || ""),
  );
  if (overlay.length >= 2) {
    return overlay.sort((a, b) => a.position.x - b.position.x);
  }
  // Fallback: any two center benches near the truth-dare spots
  return pickables
    .filter((o) => /outdoorPark\/bench|outdoorpark\/bench/i.test(o.userData?.path || ""))
    .filter((o) => Math.abs(o.position.z + 104) < 40)
    .sort((a, b) => a.position.x - b.position.x)
    .slice(0, 2);
}

function truthDareSeatSlots(benches) {
  const seats = [];
  // Side-by-side on each bench, slightly in front of the sprite feet
  const seatOff = 18;
  const sitInFront = 6;
  for (const b of benches.slice(0, 2)) {
    const dir = b.userData?.dir || "south";
    const face = FACE_VEC[dir] || FACE_VEC.south;
    // Perpendicular along bench (east-west if facing south)
    const sx = -face[1];
    const sz = face[0];
    seats.push({
      x: b.position.x + sx * seatOff,
      z: b.position.z + sz * seatOff + face[1] * sitInFront,
      dir,
      sit: true,
    });
    seats.push({
      x: b.position.x - sx * seatOff,
      z: b.position.z - sz * seatOff + face[1] * sitInFront,
      dir,
      sit: true,
    });
  }
  return seats;
}

/** Rows of 10 under/in front of the banks — front row first, then back rows. */
function truthDareRowSlots(cx, cz, count) {
  if (count <= 0) return [];
  const slots = [];
  const rowCount = Math.ceil(count / TRUTH_DARE_ROW_SIZE);
  for (let row = 0; row < rowCount; row++) {
    const start = row * TRUTH_DARE_ROW_SIZE;
    const n = Math.min(TRUTH_DARE_ROW_SIZE, count - start);
    const rowZ = cz + TRUTH_DARE_FRONT_Z + row * TRUTH_DARE_ROW_GAP_Z;
    const width = (n - 1) * TRUTH_DARE_COL_GAP_X;
    const x0 = cx - width / 2;
    for (let i = 0; i < n; i++) {
      slots.push({
        x: x0 + i * TRUTH_DARE_COL_GAP_X,
        z: rowZ,
        dir: "north",
        sit: false,
        run: true,
      });
    }
  }
  return slots;
}

function snapshotTruthDareActors(actors) {
  truthDareSnapshot = new Map();
  for (const obj of actors) {
    const isPlayer = !!(player?.mesh && obj === player.mesh);
    truthDareSnapshot.set(obj, {
      x: obj.position.x,
      z: obj.position.z,
      dir: isPlayer ? player.facing || "south" : obj.userData?.dir || "south",
      sitting: isPlayer
        ? !!player.sitting
        : !!(
            obj.userData?.sitting || /\/states\/sit/i.test(obj.userData?.path || "")
          ),
      isPlayer,
    });
  }
}

function scriptActorTo(
  obj,
  tx,
  tz,
  {
    run = false,
    onDone = null,
    faceDir = null,
    snap = true,
    idleOnArrive = true,
    wait = 0,
    moveGen = null,
  } = {},
) {
  const isPlayer = !!(player?.mesh && obj === player.mesh);
  const dx = tx - obj.position.x;
  const dz = tz - obj.position.z;
  const dist = Math.hypot(dx, dz);
  const walkDir = dirFromVector(dx, dz) || faceDir || "south";
  const gen = moveGen;

  obj.userData.formationMove = true;
  obj.userData.formationSlot = null;

  const snapToTarget = () => {
    if (!snap) return;
    if (isPlayer) {
      player.mesh.position.set(tx, 0, tz);
      player.syncRing?.(tx, tz);
      if (player.syncDepth) player.syncDepth(player.mesh);
    } else {
      obj.position.set(tx, 0, tz);
      syncDepth(obj);
    }
  };

  const finishFace = () => {
    if (gen != null && gen !== redLightGame.entranceGen) return;
    snapToTarget();
    obj.userData.formationMove = false;
    // Kill late attachRun/Walk so arrival idle/sit isn't overwritten (stuck run)
    if (!isPlayer) stopCharacterGait(obj);
    // Truth-dare seats pin; red_light: pin on lineup while countdown pending
    if (
      isRedLightScene() &&
      redLightGame.pendingStart &&
      !obj.userData?.redLightDq
    ) {
      obj.userData.formationSlot = { x: tx, z: tz };
    } else if (
      isRedLightScene() &&
      !obj.userData?.redLightDq &&
      !obj.userData?.redLightFinished &&
      !obj.userData?.redLightFinishing
    ) {
      obj.userData.formationSlot = null;
    } else {
      obj.userData.formationSlot = { x: tx, z: tz };
    }
    if (faceDir) {
      if (isPlayer) {
        player.facing = faceDir;
        player.applyFrame?.();
      } else {
        obj.userData.dir = faceDir;
        applyFacing(obj, faceDir);
      }
    }
    if (!isPlayer && idleOnArrive) {
      attachIdle(obj, obj.userData.path, faceDir || walkDir, {
        allowSouthFallback: true,
      }).catch(() => {});
    }
    onDone?.();
  };

  if (dist <= 12) {
    finishFace();
    return;
  }

  const rl = isRedLightScene();
  // red_light: run only on cast entrance (full); walk at quarter speed
  const wantRun = !!run;
  const moveSpd = wantRun
    ? TRUTH_DARE_RUN_SPEED
    : TRUTH_DARE_WALK_SPEED * (rl ? 0.25 : 1);

  if (isPlayer) {
    if (occupiedVehicle) exitVehicle();
    if (player.skating && occupiedSkateboard) exitSkateboard();
    player.stopActions?.();
    const startMain = () => {
      if (gen != null && gen !== redLightGame.entranceGen) return;
      player.startScriptMove(dx, dz, dist, moveSpd, {
        anim: wantRun ? "run" : "walk",
        forceRun: wantRun && rl,
        onDone: finishFace,
      });
    };
    if (wait > 0) setTimeout(startMain, wait * 1000);
    else startMain();
    return;
  }

  if (obj.userData?.driving) exitVehicle(obj);
  if (obj.userData?.skating) exitSkateboard(obj);

  clearNpcScriptMoves(obj);
  obj.userData.dir = walkDir;
  applyFacing(obj, walkDir);
  const gaitAttach = wantRun
    ? attachRun(obj, obj.userData.path, walkDir, { allowSouthFallback: true })
    : attachWalk(obj, obj.userData.path, walkDir, { allowSouthFallback: true });
  gaitAttach.catch(() => {});
  enqueueNpcWalk(obj, dx, dz, dist, moveSpd, wait, {
    gait: wantRun ? "run" : "walk",
    onDone: finishFace,
  });
}

async function seatActorAfterArrive(obj, slot) {
  const isPlayer = !!(player?.mesh && obj === player.mesh);
  if (obj.userData) {
    obj.userData.formationMove = false;
    obj.userData.formationSlot = { x: slot.x, z: slot.z };
  }
  if (isPlayer) {
    player.facing = slot.dir || "south";
    player.mesh.position.set(slot.x, 0, slot.z);
    player.syncRing?.(slot.x, slot.z);
    player.startSit?.();
    return;
  }
  obj.position.set(slot.x, 0, slot.z);
  obj.userData.dir = slot.dir || "south";
  applyFacing(obj, obj.userData.dir);
  syncDepth(obj);
  await setCharacterSitPose(obj, true);
}

async function startTruthDareFormation() {
  const pool = truthDareActorPool();
  if (!pool.length) {
    statusEl.textContent = "doğrulukmu_cesaretmi — oyuncu yok";
    return false;
  }
  const benches = truthDareBenchObjects();
  if (benches.length < 2) {
    statusEl.textContent = "doğrulukmu_cesaretmi — 2 bank gerekli";
    return false;
  }

  // End any prior round without restoring (fresh start)
  truthDareActive = false;
  truthDareSnapshot = new Map();
  snapshotTruthDareActors(pool);

  const four = pickTruthDareFour(pool);
  const seatedSet = new Set(four);
  const rest = pool.filter((o) => !seatedSet.has(o));
  const seats = truthDareSeatSlots(benches);
  const cx = (benches[0].position.x + benches[1].position.x) / 2;
  const cz = (benches[0].position.z + benches[1].position.z) / 2;
  const rows = truthDareRowSlots(cx, cz, rest.length);

  if (pool.length < 4) {
    statusEl.textContent = `doğrulukmu — ${pool.length} oyuncu (4 ideal), diziliyor…`;
  } else {
    statusEl.textContent =
      "doğrulukmu_cesaretmi — 4 oturur, diğerleri bank altında 8’er sıra";
  }

  truthDareActive = true;

  four.forEach((obj, i) => {
    const slot = seats[i];
    if (!slot) return;
    // Run to the bank, then sit (no idle flash before sit pose)
    scriptActorTo(obj, slot.x, slot.z, {
      run: true,
      faceDir: slot.dir,
      snap: true,
      idleOnArrive: false,
      wait: i * 0.12,
      onDone: () => {
        seatActorAfterArrive(obj, slot).catch((err) => {
          console.warn("truth-dare sit", err);
        });
      },
    });
  });

  rest.forEach((obj, i) => {
    const slot = rows[i];
    if (!slot) return;
    scriptActorTo(obj, slot.x, slot.z, {
      run: true,
      faceDir: slot.dir,
      onDone: () => {
        const isPlayer = !!(player?.mesh && obj === player.mesh);
        if (isPlayer) {
          player.facing = slot.dir;
          player.applyFrame?.();
        } else {
          attachIdle(obj, obj.userData.path, slot.dir, {
            allowSouthFallback: true,
          }).catch(() => {});
        }
      },
    });
  });

  return true;
}

function clearTruthDareFormationLocks() {
  const actors = truthDareActorPool();
  for (const o of actors) {
    if (!o?.userData) continue;
    o.userData.formationMove = false;
    o.userData.formationSlot = null;
  }
}

async function endTruthDareFormation() {
  if (!truthDareActive && truthDareSnapshot.size === 0) return;
  const entries = [...truthDareSnapshot.entries()];
  truthDareActive = false;
  clearTruthDareFormationLocks();

  for (const [obj, snap] of entries) {
    if (!obj?.parent && !(player?.mesh && obj === player.mesh)) continue;
    const isPlayer = !!(player?.mesh && obj === player.mesh);

    // Stand first if sitting
    if (isPlayer) {
      if (player.sitting) player.stopActions?.();
    } else if (
      obj.userData?.sitting ||
      /\/states\/sit/i.test(obj.userData?.path || "")
    ) {
      await setCharacterSitPose(obj, false);
    }

    scriptActorTo(obj, snap.x, snap.z, {
      run: true,
      faceDir: snap.dir,
      onDone: () => {
        // Home again — release formation pin
        if (obj.userData) {
          obj.userData.formationMove = false;
          obj.userData.formationSlot = null;
        }
        if (isPlayer) {
          player.facing = snap.dir || "south";
          if (snap.sitting) player.startSit?.();
          else player.applyFrame?.();
        } else {
          obj.userData.dir = snap.dir || "south";
          applyFacing(obj, obj.userData.dir);
          if (snap.sitting) {
            setCharacterSitPose(obj, true).catch(() => {});
          } else {
            attachIdle(obj, obj.userData.path, obj.userData.dir, {
              allowSouthFallback: true,
            }).catch(() => {});
          }
        }
      },
    });
  }

  truthDareSnapshot = new Map();
  statusEl.textContent = "doğrulukmu bitti — eski konumlara dönülüyor";
}

/** Street ↔ dogrulukmu: only add/remove banks — keep Main, cast, balls in place. */
async function softSwitchStreetVariant(sceneId) {
  const meta = sceneCatalog.find((s) => s.id === sceneId);

  if (sceneId === "street" && (truthDareActive || truthDareSnapshot.size)) {
    await endTruthDareFormation();
  }

  clearSceneOverlayObjects("dogrulukmu_cesaretmi");

  if (sceneId === "dogrulukmu_cesaretmi") {
    const file = meta?.file || `${sceneId}.json`;
    const raw = await fetchSceneFile(file);
    const extras = Array.isArray(raw.objects) ? raw.objects : [];
    for (const entry of extras) {
      const item = findCatalogItem(entry);
      if (!item) {
        console.warn("overlay: katalogda yok", entry.path);
        continue;
      }
      const obj = await spawnItem(item, Number(entry.x) || 0, Number(entry.z) || 0, {
        scale: entry.scale != null ? Number(entry.scale) : undefined,
        dir: entry.dir,
        exactPos: true,
        recordUndo: false,
        select: false,
        playEntrance: false,
      });
      obj.userData.sceneOverlay = "dogrulukmu_cesaretmi";
    }
    activeSceneId = sceneId;
    sceneRevision = Math.max((sceneRevision || 0) + 1, Number(meta?.revision) || 0);
    highlightSceneSlot(sceneId);
    syncStreetWalkUi();
    syncTrafficForScene();
    syncTruthDareCrowdUi();
    await startTruthDareFormation();
    persistScene();
    return;
  }

  activeSceneId = sceneId;
  sceneRevision = Math.max((sceneRevision || 0) + 1, Number(meta?.revision) || 0);
  highlightSceneSlot(sceneId);
  syncStreetWalkUi();
  syncTrafficForScene();
  syncTruthDareCrowdUi();
  persistScene();
  statusEl.textContent = "street — overlay kalktı (konumlar geri)";
}

async function loadNamedScene(sceneId) {
  const meta = sceneCatalog.find((s) => s.id === sceneId);
  // Same street world: don't rebuild / re-run garage intro / reset balls
  if (
    isStreetLikeScene(activeSceneId) &&
    (sceneId === "street" || sceneId === "dogrulukmu_cesaretmi")
  ) {
    if (activeSceneId === sceneId) {
      highlightSceneSlot(sceneId);
      statusEl.textContent = `${meta?.label || sceneId} zaten açık`;
      return;
    }
    statusEl.textContent = `${meta?.label || sceneId}…`;
    await softSwitchStreetVariant(sceneId);
    return;
  }

  const file = meta?.file || `${sceneId}.json`;
  statusEl.textContent = `${meta?.label || sceneId} yükleniyor…`;
  const raw = await fetchSceneFile(file);
  const data = await resolveSceneData(sceneId, raw);
  // Button click always wins over older localStorage revision
  data.sceneId = sceneId;
  data.label = meta?.label || data.label || sceneId;
  data.revision = Math.max(Number(data.revision) || 0, (sceneRevision || 0) + 1);
  activeSceneId = sceneId;
  await loadScene(data, { persist: true });
  highlightSceneSlot(sceneId);
  syncTruthDareCrowdUi();
  if (sceneId === "dogrulukmu_cesaretmi") {
    await startTruthDareFormation();
  }
}

function disposeSelectionOutline() {
  if (!selectionOutline) return;
  selectionOutline.parent?.remove(selectionOutline);
  selectionOutline.traverse((n) => {
    n.geometry?.dispose?.();
    if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
    else n.material?.dispose?.();
  });
  selectionOutline = null;
}

/** Green border around the selected sprite / ground tile (local unit quad). */
function attachSelectionOutline(obj) {
  disposeSelectionOutline();
  if (!obj) return;

  const isGround = obj.userData?.layer === "ground";
  // Sprite center=(0.5,0) → bottom-anchored; ground PlaneGeometry → centered
  const corners = isGround
    ? [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ]
    : [
        [-0.5, 0],
        [0.5, 0],
        [0.5, 1],
        [-0.5, 1],
      ];
  const z = isGround ? 0.02 : 0.01;
  const positions = [];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % 4];
    positions.push(x0, y0, z, x1, y1, z);
  }

  // Corner ticks (~18% of each edge) so the box reads clearly on busy sprites
  const tick = 0.18;
  for (const [x, y] of corners) {
    const sx = x < 0 ? 1 : -1;
    const sy = y < (isGround ? 0 : 0.5) ? 1 : -1;
    positions.push(x, y, z, x + sx * tick, y, z);
    positions.push(x, y, z, x, y + sy * tick, z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: SELECT_OUTLINE_COLOR,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  selectionOutline = new THREE.LineSegments(geo, mat);
  selectionOutline.renderOrder = 100000;
  selectionOutline.frustumCulled = false;
  selectionOutline.userData.skipPick = true;
  obj.add(selectionOutline);
}

function disposeColGizmo() {
  if (!colGizmo) return;
  colGizmo.traverse((n) => {
    n.geometry?.dispose?.();
    if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
    else n.material?.dispose?.();
  });
  colGizmo.parent?.remove(colGizmo);
  colGizmo = null;
}

function buildPolyGizmo(corners, enabled, { street = false } = {}) {
  disposeColGizmo();
  const n = corners.length;
  if (n < 3) return;
  const y = 0.14;
  const opacity = enabled ? 0.95 : 0.45;
  // Street handles bigger so they stay easy to grab in 9:16
  const handleR = street ? 16 : 10;
  const rimInner = street ? 13 : 8;
  const rimOuter = street ? 18 : 11;
  const midR = street ? 12 : 6;
  const hitR = street ? COL_HANDLE_HIT_R * 1.65 : COL_HANDLE_HIT_R;
  const maxPts = street ? STREET_WALK_MAX_PTS : COL_MAX_PTS;

  colGizmo = new THREE.Group();
  colGizmo.userData.skipPick = true;
  colGizmo.userData.colGizmo = true;
  colGizmo.userData.streetWalk = !!street;
  colGizmo.userData.handleHitR = hitR;
  colGizmo.userData.maxPts = maxPts;

  const positions = [];
  for (let i = 0; i < n; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % n];
    positions.push(x0, y, z0, x1, y, z1);
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const line = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({
      color: COL_GIZMO_COLOR,
      depthTest: false,
      transparent: true,
      opacity,
    }),
  );
  line.renderOrder = 100001;
  line.frustumCulled = false;
  line.userData.skipPick = true;
  colGizmo.add(line);

  const handleMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    transparent: true,
    opacity: enabled ? 1 : 0.55,
  });
  const handleGeo = new THREE.CircleGeometry(handleR, 20);
  for (let i = 0; i < n; i++) {
    const [cx, cz] = corners[i];
    const handle = new THREE.Mesh(handleGeo, handleMat.clone());
    handle.rotation.x = -Math.PI / 2;
    handle.position.set(cx, y + 0.02, cz);
    handle.renderOrder = 100002;
    handle.frustumCulled = false;
    handle.userData.skipPick = true;
    handle.userData.colCorner = i;
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(rimInner, rimOuter, 20),
      new THREE.MeshBasicMaterial({
        color: COL_GIZMO_COLOR,
        depthTest: false,
        transparent: true,
        opacity: enabled ? 1 : 0.5,
      }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(cx, y + 0.03, cz);
    rim.renderOrder = 100003;
    rim.frustumCulled = false;
    rim.userData.skipPick = true;
    rim.userData.colCorner = i;
    colGizmo.add(handle, rim);
  }

  // Edge midpoints — click/drag to insert a new vertex (street: brighter + larger)
  if (n < maxPts) {
    const midMat = new THREE.MeshBasicMaterial({
      color: street ? 0xffe08a : COL_GIZMO_COLOR,
      depthTest: false,
      transparent: true,
      opacity: enabled ? (street ? 1 : 0.85) : 0.4,
    });
    const midGeo = new THREE.CircleGeometry(midR, 16);
    for (let i = 0; i < n; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % n];
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      const mid = new THREE.Mesh(midGeo, midMat.clone());
      mid.rotation.x = -Math.PI / 2;
      mid.position.set(mx, y + 0.025, mz);
      mid.renderOrder = 100004;
      mid.frustumCulled = false;
      mid.userData.skipPick = true;
      mid.userData.colEdge = i;
      colGizmo.add(mid);
      if (street) {
        const midRim = new THREE.Mesh(
          new THREE.RingGeometry(midR + 1, midR + 4, 16),
          new THREE.MeshBasicMaterial({
            color: 0xffc857,
            depthTest: false,
            transparent: true,
            opacity: enabled ? 0.95 : 0.35,
          }),
        );
        midRim.rotation.x = -Math.PI / 2;
        midRim.position.set(mx, y + 0.03, mz);
        midRim.renderOrder = 100005;
        midRim.frustumCulled = false;
        midRim.userData.skipPick = true;
        midRim.userData.colEdge = i;
        colGizmo.add(midRim);
      }
    }
  }

  scene.add(colGizmo);
}

/** Night club room used for walk-col gizmo / edits. */
function nightClubColTarget() {
  if (selected && hasEditableCollision(selected.userData?.path)) return selected;
  return nightClubRoomObj();
}

/** Outline + vertex handles for night_club object col. */
function updateColGizmo(obj) {
  if (!obj || !hasEditableCollision(obj.userData?.path)) {
    if (isWalkZoneScene()) updateStreetWalkGizmo();
    else if (isNightClubScene()) updateNightClubColGizmo();
    else disposeColGizmo();
    return;
  }
  if (isNightClubScene() && !nightClubColVisible) {
    disposeColGizmo();
    return;
  }
  const col = ensureColData(obj);
  buildPolyGizmo(getColWorldPts(obj), !!col.enabled, { street: false });
  if (colGizmo) {
    colGizmo.userData.nightClub = true;
    colGizmo.userData.nightClubObj = obj;
  }
}

/** Show/hide night club walk poly (does not toggle col.enabled). */
function updateNightClubColGizmo() {
  if (!isNightClubScene() || !nightClubColVisible) {
    if (colGizmo?.userData?.nightClub) disposeColGizmo();
    return;
  }
  const room = nightClubColTarget();
  if (!room) {
    if (colGizmo?.userData?.nightClub) disposeColGizmo();
    return;
  }
  const col = ensureColData(room);
  buildPolyGizmo(getColWorldPts(room), !!col.enabled, { street: false });
  if (colGizmo) {
    colGizmo.userData.nightClub = true;
    colGizmo.userData.nightClubObj = room;
  }
}

function syncNightClubColUi() {
  const panel = document.getElementById("night-club-col");
  if (panel) panel.classList.toggle("hidden", !isNightClubScene());
  panel?.querySelectorAll("button[data-nccol]").forEach((btn) => {
    const show = btn.getAttribute("data-nccol") === "show";
    btn.classList.toggle("active", isNightClubScene() && show === nightClubColVisible);
  });
  if (isNightClubScene()) updateNightClubColGizmo();
  else if (colGizmo?.userData?.nightClub) disposeColGizmo();
}

function updateStreetWalkGizmo() {
  if (!isWalkZoneScene()) {
    if (colGizmo?.userData?.streetWalk) disposeColGizmo();
    return;
  }
  // Prefer night_club-style object gizmo if that object is selected
  if (selected && hasEditableCollision(selected.userData?.path)) return;
  const z = ensureStreetWalkZone();
  // Gizmo only while editing — collision stays on via walkZone.enabled
  if (!streetWalkEditOpen) {
    if (colGizmo?.userData?.streetWalk) disposeColGizmo();
    return;
  }
  buildPolyGizmo(
    z.pts.map(([x, zz]) => [x, zz]),
    true,
    { street: true },
  );
}

function syncStreetWalkUi() {
  const panel = document.getElementById("street-walk");
  if (panel) panel.classList.toggle("hidden", !isWalkZoneScene());
  const on = document.getElementById("street-walk-on");
  if (on) on.checked = !!streetWalkEditOpen;
  if (isWalkZoneScene()) updateStreetWalkGizmo();
  else if (colGizmo?.userData?.streetWalk) disposeColGizmo();
  syncTruthDareCrowdUi();
  syncRedLightCastUi();
  syncNightClubColUi();
}

function polyHandleHitR() {
  return colGizmo?.userData?.handleHitR || COL_HANDLE_HIT_R;
}

function hitPolyCorner(wx, wz, pts) {
  let best = -1;
  let bestD = polyHandleHitR();
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(wx - pts[i][0], wz - pts[i][1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function hitPolyEdgeMid(wx, wz, pts) {
  const maxPts = colGizmo?.userData?.maxPts || COL_MAX_PTS;
  if (pts.length >= maxPts) return -1;
  let best = -1;
  let bestD = polyHandleHitR() * 0.9;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    const mx = (ax + bx) * 0.5;
    const mz = (az + bz) * 0.5;
    const d = Math.hypot(wx - mx, wz - mz);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Hit any point along an edge (not only the midpoint) — returns
 * { edge, x, z } so street edges are easy to split on the right/long sides.
 */
function hitPolyEdgeAnywhere(wx, wz, pts) {
  const maxPts = colGizmo?.userData?.maxPts || COL_MAX_PTS;
  if (pts.length >= maxPts) return null;
  const maxD = polyHandleHitR() * 1.15;
  let best = null;
  let bestD = maxD;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    const abx = bx - ax;
    const abz = bz - az;
    const ab2 = abx * abx + abz * abz || 1e-12;
    let t = ((wx - ax) * abx + (wz - az) * abz) / ab2;
    t = Math.max(0.08, Math.min(0.92, t)); // keep away from corners
    const qx = ax + abx * t;
    const qz = az + abz * t;
    const d = Math.hypot(wx - qx, wz - qz);
    if (d < bestD) {
      bestD = d;
      best = { edge: i, x: qx, z: qz };
    }
  }
  return best;
}

function hitColCorner(wx, wz, obj) {
  if (!obj || !hasEditableCollision(obj.userData?.path)) return -1;
  return hitPolyCorner(wx, wz, getColWorldPts(obj));
}

/** Edge index whose midpoint is near (wx,wz), or -1. */
function hitColEdgeMid(wx, wz, obj) {
  if (!obj || !hasEditableCollision(obj.userData?.path)) return -1;
  return hitPolyEdgeMid(wx, wz, getColWorldPts(obj));
}

function selectObject(obj) {
  selected = obj;
  colCornerDrag = null;
  attachSelectionOutline(obj);
  if (!obj) {
    inspector.classList.add("hidden");
    if (isWalkZoneScene()) updateStreetWalkGizmo();
    else if (isNightClubScene()) updateNightClubColGizmo();
    else disposeColGizmo();
    return;
  }
  inspector.classList.remove("hidden");
  refreshInspector();
}

function pushUndo(entry) {
  undoStack.push(entry);
  while (undoStack.length > UNDO_MAX) {
    const old = undoStack.shift();
    try {
      old.discard?.();
    } catch {
      /* */
    }
  }
}

function disposePlacedObject(obj) {
  if (!obj) return;
  obj.material?.map?.dispose?.();
  obj.material?.dispose?.();
  obj.geometry?.dispose?.();
}

function detachPlacedObject(obj) {
  if (!obj) return;
  const wasParty = !!(obj.userData?.partyMember || obj.userData?.tennisCast);
  if (selected === obj) selectObject(null);
  if (companion === obj) {
    companion = null;
    disposePetColRing();
  }
  scene.remove(obj);
  const i = pickables.indexOf(obj);
  if (i >= 0) pickables.splice(i, 1);
  if (wasParty && partySnapshotEnabled && !sceneLoading) {
    snapshotPartyFromWorld();
  }
}

function attachPlacedObject(obj) {
  if (!obj) return;
  if (!obj.parent) scene.add(obj);
  if (!pickables.includes(obj)) pickables.push(obj);
  syncDepth(obj);
}

function undoLast() {
  const entry = undoStack.pop();
  if (!entry) {
    statusEl.textContent = "Geri alınacak bir şey yok";
    return;
  }
  try {
    entry.undo();
    statusEl.textContent = "Geri alındı";
  } catch (err) {
    console.warn("undo", err);
    statusEl.textContent = "Geri alma başarısız";
  }
}

function pushSpawnUndo(obj) {
  if (!obj) return;
  pushUndo({
    undo() {
      detachPlacedObject(obj);
      disposePlacedObject(obj);
    },
  });
}

function pushMoveUndo(obj, fromX, fromZ, toX, toZ) {
  if (!obj) return;
  if (fromX === toX && fromZ === toZ) return;
  pushUndo({
    undo() {
      obj.position.x = fromX;
      obj.position.z = fromZ;
      syncDepth(obj);
      if (selected === obj) refreshInspector();
      else selectObject(obj);
      schedulePersistScene();
    },
  });
  schedulePersistScene();
}

function pushDeleteUndo(obj) {
  if (!obj) return;
  pushUndo({
    undo() {
      attachPlacedObject(obj);
      selectObject(obj);
      schedulePersistScene();
    },
    discard() {
      disposePlacedObject(obj);
    },
  });
  schedulePersistScene();
}

function refreshInspector() {
  if (!selected) return;
  const d = selected.userData;
  inspLabel.textContent = d.label || d.id || "item";
  inspX.value = Math.round(selected.position.x);
  inspZ.value = Math.round(selected.position.z);
  inspScale.value = d.scale;
  inspScaleVal.textContent = Number(d.scale).toFixed(2);

  const colEditable = hasEditableCollision(d.path);
  if (inspCol) inspCol.classList.toggle("hidden", !colEditable);
  if (colEditable) {
    const col = ensureColData(selected);
    if (inspColOn) inspColOn.checked = !!col.enabled;
    updateColGizmo(selected);
  } else if (isWalkZoneScene()) {
    updateStreetWalkGizmo();
  } else if (isNightClubScene()) {
    updateNightClubColGizmo();
  } else {
    disposeColGizmo();
  }

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

  if (inspDance) {
    const isChar = d.kind === "character";
    inspDance.classList.toggle("hidden", !isChar);
    if (isChar) {
      inspDance.classList.toggle("active", !!d.dancing);
      inspDance.textContent = d.dancing ? "Dans: Açık" : "Dans: Kapalı";
      inspDance.disabled = true;
      inspDance.title = "Dance kontrol ediliyor…";
      const sel = selected;
      ensureDanceAvailable(sel).then((ok) => {
        if (selected !== sel) return;
        inspDance.disabled = !ok;
        inspDance.title = ok
          ? "Dans animasyonunu aç / kapat"
          : "Bu karakterde dance animasyonu yok";
        if (!ok) {
          inspDance.classList.remove("active");
          inspDance.textContent = "Dans: Yok";
        }
      });
    }
  }
}

inspDance?.addEventListener("click", async () => {
  if (!selected || selected.userData?.kind !== "character") return;
  if (inspDance.disabled) return;
  const next = !selected.userData.dancing;
  inspDance.disabled = true;
  await setCharacterDancing(selected, next);
  refreshInspector();
});

inspX.addEventListener("change", () => {
  if (!selected) return;
  if (isTruthDarePositionLocked(selected)) {
    inspX.value = Math.round(selected.position.x);
    statusEl.textContent = "doğrulukmu — yerinde · konum kilitli";
    return;
  }
  const fromX = selected.position.x;
  const toX = Number(inspX.value) || 0;
  selected.position.x = toX;
  if (selected.userData?.kind === "character") {
    selected.userData.spawnX = toX;
    clearNpcScriptMoves(selected);
  }
  syncDepth(selected);
  if (hasEditableCollision(selected.userData?.path)) updateColGizmo(selected);
  pushMoveUndo(selected, fromX, selected.position.z, toX, selected.position.z);
});
inspZ.addEventListener("change", () => {
  if (!selected) return;
  if (isTruthDarePositionLocked(selected)) {
    inspZ.value = Math.round(selected.position.z);
    statusEl.textContent = "doğrulukmu — yerinde · konum kilitli";
    return;
  }
  const fromZ = selected.position.z;
  const toZ = Number(inspZ.value) || 0;
  selected.position.z = toZ;
  if (selected.userData?.kind === "character") {
    selected.userData.spawnZ = toZ;
    clearNpcScriptMoves(selected);
  }
  syncDepth(selected);
  if (hasEditableCollision(selected.userData?.path)) updateColGizmo(selected);
  pushMoveUndo(selected, selected.position.x, fromZ, selected.position.x, toZ);
});
// pushMoveUndo already schedules persist
let scaleBefore = null;
inspScale.addEventListener("pointerdown", () => {
  if (!selected) return;
  scaleBefore = selected.userData.scale;
});
inspScale.addEventListener("input", () => {
  if (!selected) return;
  selected.userData.scale = Number(inspScale.value);
  inspScaleVal.textContent = selected.userData.scale.toFixed(2);
  if (selected.userData.tileable) {
    const base = selected.userData.baseTile || selected.userData.w || 64;
    selected.userData.tileSize = base * selected.userData.scale;
  }
  applyScale(selected);
  if (hasEditableCollision(selected.userData?.path)) updateColGizmo(selected);
});
inspScale.addEventListener("change", () => {
  if (!selected || scaleBefore == null) return;
  const obj = selected;
  const from = scaleBefore;
  const to = obj.userData.scale;
  scaleBefore = null;
  if (from === to) return;
  pushUndo({
    undo() {
      obj.userData.scale = from;
      if (obj.userData.tileable) {
        const base = obj.userData.baseTile || obj.userData.w || 64;
        obj.userData.tileSize = base * from;
      }
      applyScale(obj);
      if (selected === obj) refreshInspector();
      else selectObject(obj);
      schedulePersistScene();
    },
  });
  schedulePersistScene();
});

function applyColInspector() {
  if (!selected || !hasEditableCollision(selected.userData?.path)) return;
  const col = ensureColData(selected);
  col.enabled = !!inspColOn?.checked;
  syncColSolid(selected);
  updateColGizmo(selected);
  schedulePersistScene();
  statusEl.textContent = col.enabled
    ? "İç alan açık — köşe sürükle · kenar ortası ekler · Alt+tık siler"
    : "İç alan kapalı";
}

inspColOn?.addEventListener("change", applyColInspector);
inspColReset?.addEventListener("click", () => {
  if (!selected || !hasEditableCollision(selected.userData?.path)) return;
  resetColPts(selected);
  updateColGizmo(selected);
  schedulePersistScene();
  statusEl.textContent = "Collision karesi sıfırlandı";
});

document.getElementById("night-club-col")?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button[data-nccol]");
  if (!btn || !isNightClubScene()) return;
  nightClubColVisible = btn.getAttribute("data-nccol") === "show";
  syncNightClubColUi();
  statusEl.textContent = nightClubColVisible
    ? "Club col görünür — köşe sürükle · collision aynı"
    : "Club col gizli — collision çalışmaya devam eder";
});

document.getElementById("street-walk-on")?.addEventListener("change", (e) => {
  if (!isWalkZoneScene()) return;
  streetWalkEditOpen = !!e.target.checked;
  const zone = ensureStreetWalkZone();
  // Editing does not toggle collision — keep walkZone.enabled as saved
  if (!zone.enabled && zone.pts.length >= 3) zone.enabled = true;
  if (streetWalkEditOpen && streetWalkHandlesOffscreen()) {
    // Don't destroy saved shape — only nudge if somehow empty
    if (zone.pts.length < 3) zone.pts = streetWalkPtsFromView(0.14);
  }
  updateStreetWalkGizmo();
  statusEl.textContent = streetWalkEditOpen
    ? "Alan düzenleme açık — köşe/sarı nokta sürükle · top+karakter collision aktif"
    : "Alan gizlendi — collision çalışmaya devam eder";
});

document.getElementById("street-walk-fit")?.addEventListener("click", () => {
  if (!isWalkZoneScene()) return;
  streetWalkEditOpen = true;
  const on = document.getElementById("street-walk-on");
  if (on) on.checked = true;
  ensureStreetWalkZone().enabled = true;
  fitStreetWalkToView();
});

document.getElementById("street-walk-reset")?.addEventListener("click", () => {
  if (!isWalkZoneScene()) return;
  streetWalkEditOpen = true;
  const on = document.getElementById("street-walk-on");
  if (on) on.checked = true;
  ensureStreetWalkZone().enabled = true;
  fitStreetWalkToView();
  statusEl.textContent = "Street alan görünüme sıfırlandı";
});

/** Shift+arrows: append a same-scale road tile on that edge of the selection. */
async function extendSelectedRoad(dx, dz) {
  const src = selected;
  if (!isTileableObj(src) || !src.userData.editable) return false;
  const d = src.userData;
  const stepX = (d.w || 64) * (d.scale || 1);
  const stepZ = (d.h || 64) * (d.scale || 1);
  const x = src.position.x + dx * stepX;
  const z = src.position.z + dz * stepZ;
  const item =
    catalogItemById.get(d.catalogKey) ||
    catalogItemById.get(`${d.catalogId}:${d.path}`) ||
    [...catalogItemById.values()].find((it) => it.path === d.path);
  if (!item) {
    statusEl.textContent = "Yol kataloğu bulunamadı";
    return false;
  }
  statusEl.textContent = "Yol ekleniyor…";
  try {
    await spawnItem(item, x, z, { scale: d.scale, dir: d.dir, exactPos: true });
    statusEl.textContent = "Yol eklendi";
  } catch (err) {
    console.warn(err);
    statusEl.textContent = "Yol eklenemedi";
    return false;
  }
  return true;
}
inspDelete.addEventListener("click", () => {
  if (!selected || !selected.userData.editable) return;
  if (selected === occupiedVehicle) return;
  const obj = selected;
  detachPlacedObject(obj);
  pushDeleteUndo(obj);
  statusEl.textContent = "Silindi (Ctrl+Z geri alır)";
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
  if (occupiedVehicle) return;
  // If a palette ghost is active but user grabbed a placed object, move that — don't spawn
  setPointerFromEvent(event);

  // Traffic lane lines (street) — yellow east / cyan west
  if (trafficEnabled && trafficLaneGizmo) {
  raycaster.setFromCamera(pointer, camera);
    raycaster.camera = camera;
    const laneHits = raycaster.intersectObject(trafficLaneGizmo, true);
    const hit = laneHits.find((h) => h.object?.userData?.trafficLaneHit);
    if (hit) {
      if (placing) endPaletteDrag();
      trafficLaneDragDir =
        hit.object.userData.trafficLaneDir === "west" ? "west" : "east";
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      statusEl.textContent =
        trafficLaneDragDir === "east"
          ? "Sol→sağ şerit (sarı) — sürükle"
          : "Sağ→sol şerit (mavi) — sürükle";
      return;
    }
  }

  // Collision polygon handles (night_club object OR street walk zone)
  const gp0 = groundHit();
  const nightColObj =
    nightClubColVisible && colGizmo?.userData?.nightClub
      ? colGizmo.userData.nightClubObj || nightClubColTarget()
      : selected && hasEditableCollision(selected.userData?.path)
        ? selected
        : null;
  if (gp0 && nightColObj && hasEditableCollision(nightColObj.userData?.path)) {
    const corner = hitColCorner(gp0.x, gp0.z, nightColObj);
    if (corner >= 0) {
      if (placing) endPaletteDrag();
      if (event.altKey) {
        const from = ensureColData(nightColObj).pts.map((p) => ({ fx: p.fx, fz: p.fz }));
        if (removeColPt(nightColObj, corner)) {
          pushUndo({
            undo() {
              ensureColData(nightColObj).pts = from.map((p) => ({ ...p }));
              updateNightClubColGizmo();
            },
          });
          updateNightClubColGizmo();
          statusEl.textContent = "Köşe silindi (Alt+tık)";
        } else {
          statusEl.textContent = "En az 3 köşe gerekli";
        }
        return;
      }
      const col = ensureColData(nightColObj);
      colCornerDrag = {
        obj: nightColObj,
        index: corner,
        from: col.pts.map((p) => ({ fx: p.fx, fz: p.fz })),
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      statusEl.textContent = `Köşe ${corner + 1} — sürükle · Alt+tık sil`;
      return;
    }
    const edge = hitColEdgeMid(gp0.x, gp0.z, nightColObj);
    if (edge >= 0) {
      if (placing) endPaletteDrag();
      const from = ensureColData(nightColObj).pts.map((p) => ({ fx: p.fx, fz: p.fz }));
      const newIndex = insertColPtOnEdge(nightColObj, edge, gp0.x, gp0.z);
      if (newIndex < 0) {
        statusEl.textContent = `En fazla ${COL_MAX_PTS} köşe`;
        return;
      }
      colCornerDrag = {
        obj: nightColObj,
        index: newIndex,
        from,
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      updateNightClubColGizmo();
      statusEl.textContent = "Kenara nokta eklendi — sürükle";
      return;
    }
  } else if (gp0 && isWalkZoneScene() && colGizmo?.userData?.streetWalk) {
    const zone = ensureStreetWalkZone();
    const corner = hitPolyCorner(gp0.x, gp0.z, zone.pts);
    if (corner >= 0) {
      if (placing) endPaletteDrag();
      if (event.altKey) {
        if (zone.pts.length <= 3) {
          statusEl.textContent = "En az 3 köşe gerekli";
          return;
        }
        const from = zone.pts.map((p) => [...p]);
        zone.pts.splice(corner, 1);
        pushUndo({
          undo() {
            sceneWalkZone.pts = from.map((p) => [...p]);
            updateStreetWalkGizmo();
          },
        });
        updateStreetWalkGizmo();
        schedulePersistScene();
        statusEl.textContent = "Köşe silindi (Alt+tık)";
        return;
      }
      colCornerDrag = {
        street: true,
        index: corner,
        from: zone.pts.map((p) => [...p]),
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      statusEl.textContent = `Street alan köşe ${corner + 1} — sürükle`;
      return;
    }
    // Prefer midpoint dots, else click anywhere on the edge line
    let edge = hitPolyEdgeMid(gp0.x, gp0.z, zone.pts);
    let insertAt = edge >= 0 ? [gp0.x, gp0.z] : null;
    if (edge < 0) {
      const along = hitPolyEdgeAnywhere(gp0.x, gp0.z, zone.pts);
      if (along) {
        edge = along.edge;
        insertAt = [along.x, along.z];
      }
    }
    if (edge >= 0 && insertAt) {
      if (placing) endPaletteDrag();
      if (zone.pts.length >= STREET_WALK_MAX_PTS) {
        statusEl.textContent = `En fazla ${STREET_WALK_MAX_PTS} köşe`;
        return;
      }
      const from = zone.pts.map((p) => [...p]);
      zone.pts.splice(edge + 1, 0, insertAt);
      colCornerDrag = {
        street: true,
        index: edge + 1,
        from,
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      updateStreetWalkGizmo();
      schedulePersistScene();
      statusEl.textContent = "Street alan — kenara nokta eklendi (sarı nokta / kenar çizgisi)";
      return;
    }
  }

  const gpPick = groundHit();
  const nearActor = gpPick ? pickActorNearGround(gpPick.x, gpPick.z) : null;

  raycaster.setFromCamera(pointer, camera);
  raycaster.camera = camera;
  const hits = opaqueHits(raycaster.intersectObjects(pickables, false));
  // Pets/chars/balls near feet beat court/ground under the same click
  const obj = nearActor || hits[0]?.object || null;
  if (!obj) {
    if (placing) return; // keep palette-drag → canvas drop flow
    selectObject(null);
    return;
  }
  if (!obj.userData.editable || obj.userData.occupied) {
    if (placing) return;
    selectObject(null);
    return;
  }
  // Entrance / scripted run — clicking used to cancel the walk and leave them stuck
  const entering =
    !!obj.userData?.formationMove ||
    (obj === player?.mesh && !!player?.scriptMove);
  if (entering) {
    if (placing) endPaletteDrag();
    selectObject(obj);
    statusEl.textContent = "Koşu bitince sürükleyebilirsin";
    return;
  }
  // Truth-dare settled — select ok, drag/move no
  if (isTruthDarePositionLocked(obj)) {
    if (placing) endPaletteDrag();
    selectObject(obj);
    statusEl.textContent = "doğrulukmu — yerinde · sürükleme yok";
    return;
  }
  // Finish / DQ lock — stay put (lane run uses formationMove, blocked above)
  if (
    redLightGame.active &&
    (obj.userData?.redLightFinished ||
      obj.userData?.redLightFinishing ||
      obj.userData?.redLightDq)
  ) {
    if (placing) endPaletteDrag();
    selectObject(obj);
    statusEl.textContent = obj.userData.redLightDq
      ? "Diskalifiye — hareket yok"
      : "Üstte — hareket yok";
    return;
  }
  // Moving an existing piece cancels pending palette place
  if (placing) endPaletteDrag();
  dragging = obj;
  dragFrom = { x: obj.position.x, z: obj.position.z };
  selectObject(obj);
  controls.enabled = false;
  const gp = gpPick || groundHit();
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
  if (trafficLaneDragDir) {
    setPointerFromEvent(event);
    const gp = groundHit();
    if (!gp) return;
    setTrafficLaneZ(trafficLaneDragDir, gp.z);
    const label = trafficLaneDragDir === "east" ? "sol→sağ" : "sağ→sol";
    statusEl.textContent = `${label} şerit Z: ${Math.round(gp.z)}`;
    return;
  }
  if (colCornerDrag) {
    setPointerFromEvent(event);
    const gp = groundHit();
    if (!gp) return;
    if (colCornerDrag.street) {
      const zone = ensureStreetWalkZone();
      zone.pts[colCornerDrag.index] = [gp.x, gp.z];
      updateStreetWalkGizmo();
      return;
    }
    setColWorldPt(colCornerDrag.obj, colCornerDrag.index, gp.x, gp.z);
    if (colGizmo?.userData?.nightClub || isNightClubScene()) {
      updateNightClubColGizmo();
    } else {
      updateColGizmo(colCornerDrag.obj);
    }
    return;
  }
  if (!dragging) return;
  setPointerFromEvent(event);
  const gp = groundHit();
  if (!gp) return;
  // Free placement (like buildings). Hold Shift to snap roads to tile grid.
  let nx = gp.x + dragOffset.x;
  let nz = gp.z + dragOffset.z;
  if (isTileableObj(dragging) && event.shiftKey) {
    const stepX = (dragging.userData.w || 64) * (dragging.userData.scale || 1);
    const stepZ = (dragging.userData.h || 64) * (dragging.userData.scale || 1);
    nx = Math.round(nx / stepX) * stepX;
    nz = Math.round(nz / stepZ) * stepZ;
  }
  dragging.position.x = nx;
  dragging.position.z = nz;
  syncDepth(dragging);
  if (selected === dragging) {
    inspX.value = Math.round(dragging.position.x);
    inspZ.value = Math.round(dragging.position.z);
    if (hasEditableCollision(dragging.userData?.path)) updateColGizmo(dragging);
  }
}

async function onPointerUp(event) {
  if (trafficLaneDragDir) {
    const dir = trafficLaneDragDir;
    trafficLaneDragDir = null;
    saveTrafficLaneZ();
    if (viewportMode !== "9x16") controls.enabled = true;
    const label = dir === "east" ? "sol→sağ" : "sağ→sol";
    statusEl.textContent = `${label} şerit kaydedildi · Z ${Math.round(getTrafficLaneZ(dir))}`;
    try {
      renderer.domElement.releasePointerCapture(event.pointerId);
    } catch {
      /* */
    }
    return;
  }
  if (colCornerDrag) {
    if (colCornerDrag.street) {
      const from = colCornerDrag.from;
      const to = ensureStreetWalkZone().pts.map((p) => [...p]);
      const changed =
        from.length !== to.length ||
        from.some((p, i) => p[0] !== to[i]?.[0] || p[1] !== to[i]?.[1]);
      if (changed) {
        pushUndo({
          undo() {
            sceneWalkZone.pts = from.map((p) => [...p]);
            updateStreetWalkGizmo();
            schedulePersistScene();
          },
        });
        schedulePersistScene();
      }
      colCornerDrag = null;
      if (viewportMode !== "9x16") controls.enabled = true;
      statusEl.textContent = "Street yürüyüş alanı güncellendi";
      try {
        renderer.domElement.releasePointerCapture(event.pointerId);
      } catch {
        /* */
      }
      return;
    }
    const { obj, from } = colCornerDrag;
    const to = ensureColData(obj).pts.map((p) => ({ fx: p.fx, fz: p.fz }));
    const changed =
      from.length !== to.length ||
      from.some((p, i) => p.fx !== to[i]?.fx || p.fz !== to[i]?.fz);
    if (changed) {
      pushUndo({
        undo() {
          ensureColData(obj).pts = from.map((p) => ({ ...p }));
          if (selected === obj) updateColGizmo(obj);
          schedulePersistScene();
        },
      });
      schedulePersistScene();
    }
    colCornerDrag = null;
    if (viewportMode !== "9x16") controls.enabled = true;
    statusEl.textContent = "İç alan güncellendi";
    try {
      renderer.domElement.releasePointerCapture(event.pointerId);
    } catch {
      /* */
    }
    return;
  }
  // Finish move first — never spawn a copy when relocating a placed object
  if (dragging) {
    // Optional snap only if Shift held on release (default: free like buildings)
    if (isTileableObj(dragging) && event.shiftKey) {
      const stepX = (dragging.userData.w || 64) * (dragging.userData.scale || 1);
      const stepZ = (dragging.userData.h || 64) * (dragging.userData.scale || 1);
      dragging.position.x = Math.round(dragging.position.x / stepX) * stepX;
      dragging.position.z = Math.round(dragging.position.z / stepZ) * stepZ;
      syncDepth(dragging);
    }
    // Update character home when relocated by hand (never cancel an active entrance)
    if (dragging.userData?.kind === "character") {
      if (dragging.userData.formationMove) {
        // Resume to saved lineup slot if drag somehow started mid-run
        const tx = dragging.userData.spawnX;
        const tz = dragging.userData.spawnZ;
        if (Number.isFinite(tx) && Number.isFinite(tz)) {
          scriptActorTo(dragging, tx, tz, {
            run: true, // resume cast entrance
            faceDir: "north",
            idleOnArrive: true,
          });
        }
      } else {
        dragging.userData.spawnX = dragging.position.x;
        dragging.userData.spawnZ = dragging.position.z;
        clearNpcScriptMoves(dragging);
      }
    }
    if (selected === dragging) {
      inspX.value = Math.round(dragging.position.x);
      inspZ.value = Math.round(dragging.position.z);
    }
    if (dragFrom) {
      pushMoveUndo(
        dragging,
        dragFrom.x,
        dragFrom.z,
        dragging.position.x,
        dragging.position.z,
      );
    }
    dragFrom = null;
  dragging = null;
  controls.enabled = true;
  try {
    renderer.domElement.releasePointerCapture(event.pointerId);
  } catch {
      /* */
    }
    return;
  }

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
  }
}

renderer.domElement.addEventListener("pointerdown", onPointerDown);
renderer.domElement.addEventListener("pointermove", onPointerMove);
renderer.domElement.addEventListener("pointerup", onPointerUp);
renderer.domElement.addEventListener("pointercancel", onPointerUp);

window.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, textarea")) return;

  // Ctrl/Cmd+Z — undo editor actions (place / move / delete / rotate / scale)
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
    e.preventDefault();
    undoLast();
    return;
  }

  // P: spawn / dismiss companion pet
  if ((e.key === "p" || e.key === "P") && !e.repeat) {
    e.preventDefault();
    spawnCompanion();
    return;
  }

  // Esc: clear selection / cancel palette placement
  if (e.key === "Escape") {
    e.preventDefault();
    if (placing) endPaletteDrag();
    if (dragging) {
      dragging = null;
      dragFrom = null;
    }
    if (selected) selectObject(null);
    return;
  }

  // E: skateboard / vehicle enter-exit (priority over rotate)
  if ((e.key === "e" || e.key === "E") && !e.repeat) {
    if (isTruthDarePositionLocked(player?.mesh)) {
      e.preventDefault();
      statusEl.textContent =
        "doğrulukmu — yerinde kal · yazı /dance /jump /sit /stop";
      return;
    }
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

  // Shift+←/→/↑/↓: extend tileable road/ground from selected edge (keeps Boyut + yön)
  if (e.shiftKey && isTileableObj(selected) && !e.repeat) {
    let dx = 0;
    let dz = 0;
    if (e.key === "ArrowRight") dx = 1;
    else if (e.key === "ArrowLeft") dx = -1;
    else if (e.key === "ArrowUp") dz = -1;
    else if (e.key === "ArrowDown") dz = 1;
    if (dx || dz) {
      e.preventDefault();
      extendSelectedRoad(dx, dz);
      return;
    }
  }

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
    collides: playerCollides,
    findVault: findVaultForPlayer,
    radius: 22,
    walkOnly: () => isRedLightScene(),
    moveScale: () => 1,
    inputLocked: () =>
      !!(
        player?.mesh?.userData?.redLightDq ||
        player?.mesh?.userData?.redLightEliminating ||
        (redLightGame.active &&
          (player?.mesh?.userData?.redLightFinished ||
            player?.mesh?.userData?.redLightFinishing))
      ),
    positionLocked: () => isTruthDarePositionLocked(player?.mesh),
  }).load();
  applyColDebugVisible(colDebugVisible);
  // player not in pickables editor list
  if (viewportMode === "9x16") {
    setCameraFollowEnabled(false);
    syncCameraRig(MAP_VIEW);
  } else {
    controls.target.set(player.mesh.position.x, 0, player.mesh.position.z);
    placeCamera(controls.target);
  }

  loadTrafficLaneZ();
  // Fresh session: no cast from a previous play (hard refresh / reopen)
  persistentParty = [];
  partySnapshotEnabled = false;
  try {
    localStorage.removeItem("skate_life_party_v1");
  } catch {
    /* */
  }

  // Always boot on street — empty cast until user adds characters this session
  try {
    sceneCatalog = await fetchSceneCatalog();
    renderSceneSlots();
    const hasStreet = sceneCatalog.some((s) => s.id === "street");
    if (hasStreet) {
      await loadNamedScene("street");
    } else {
      let localData = null;
      try {
        const raw = localStorage.getItem(SCENE_STORAGE_KEY);
        if (raw) localData = JSON.parse(raw);
      } catch {
        /* */
      }
      if (
        localData?.version === 1 &&
        Array.isArray(localData.objects) &&
        localData.objects.length
      ) {
        await loadScene(localData, { persist: false });
      }
    }
  } catch (err) {
    console.warn("scene restore", err);
  }

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
    let ended = false;
    while (anim.accum >= step) {
      anim.accum -= step;
      if (anim.once) {
        if (anim.frame < anim.frames.length - 1) anim.frame += 1;
        else {
          ended = true;
          break;
        }
      } else {
        anim.frame = (anim.frame + 1) % anim.frames.length;
      }
    }
    if (obj.userData.busy === "jump" && anim.once) {
      const u =
        anim.frames.length > 1 ? anim.frame / (anim.frames.length - 1) : 1;
      obj.userData.ollieU = u;
      const hop = obj.userData.skating ? 26 : 16;
      obj.position.y = Math.sin(Math.PI * u) * hop;
      if (obj.userData.skating) syncSkateboardUnderRider(obj);
    }
    const tex = anim.frames[anim.frame];
    if (obj.material.map !== tex) {
      obj.material.map = tex;
      obj.material.needsUpdate = true;
    }
    if (ended && obj.userData.busy === "jump") finishNpcJump(obj);
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

/** Closest boundary point + outward normal for a polygon. */
function closestPolyEdgeHit(px, pz, pts) {
  let bestD = Infinity;
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    const abx = bx - ax;
    const abz = bz - az;
    const ab2 = abx * abx + abz * abz || 1e-12;
    let t = ((px - ax) * abx + (pz - az) * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + abx * t;
    const qz = az + abz * t;
    const d = Math.hypot(px - qx, pz - qz);
    if (d >= bestD) continue;
    bestD = d;
    let nx = -(bz - az);
    let nz = bx - ax;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    // Ensure outward: a step along normal from edge mid should leave the poly
    const mx = (ax + bx) * 0.5 + nx * 3;
    const mz = (az + bz) * 0.5 + nz * 3;
    if (pointInPoly(mx, mz, pts)) {
      nx = -nx;
      nz = -nz;
    }
    best = { qx, qz, nx, nz, d: bestD };
  }
  return best;
}

/** Keep balls inside walkZone — bounce off the boundary (street + red_light). */
function resolveBallVsWalkZone(ball, phy) {
  if (!streetWalkActive()) return;
  const pts = ensureStreetWalkZone().pts;
  if (!pts?.length) return;
  const r = Math.max(6, phy.r || 10);
  const x = ball.position.x;
  const z = ball.position.z;
  const hit = closestPolyEdgeHit(x, z, pts);
  if (!hit) return;
  const inside = pointInPoly(x, z, pts);
  if (!inside || hit.d < r) {
    const inset = r + 1;
    ball.position.x = hit.qx - hit.nx * inset;
    ball.position.z = hit.qz - hit.nz * inset;
    // Reflect outward velocity component
    const vn = phy.vx * hit.nx + phy.vz * hit.nz;
    if (vn > 0) {
      phy.vx -= (1 + BALL_BOUNCE) * vn * hit.nx;
      phy.vz -= (1 + BALL_BOUNCE) * vn * hit.nz;
    }
  }
}

/** Safety clamp: Main, cast, pets stay inside walk zone if somehow outside. */
function clampActorsIntoWalkZone() {
  if (!streetWalkActive()) return;
  if (
    player?.mesh &&
    player.mesh.visible !== false &&
    !occupiedVehicle &&
    dragging !== player.mesh
  ) {
    const r = player.radius || 22;
    const c = projectIntoWalkZone(player.mesh.position.x, player.mesh.position.z, r);
    if (c.x !== player.mesh.position.x || c.z !== player.mesh.position.z) {
      player.mesh.position.x = c.x;
      player.mesh.position.z = c.z;
      player.syncRing?.(c.x, c.z);
      if (player.syncDepth) player.syncDepth(player.mesh);
    }
  }
  for (const obj of pickables) {
    if (obj === player?.mesh) continue;
    if (obj.visible === false) continue;
    if (dragging === obj) continue; // free editor move
    const isChar = obj.userData?.kind === "character";
    const isPet = !!obj.userData?.companion || isAnimalPath(obj.userData?.path);
    if (!isChar && !isPet) continue;
    if (obj.userData?.formationMove) continue;
    const r = isPet ? PET_COL_RADIUS : NPC_WALK_RADIUS;
    const c = projectIntoWalkZone(obj.position.x, obj.position.z, r);
    if (c.x !== obj.position.x || c.z !== obj.position.z) {
      obj.position.x = c.x;
      obj.position.z = c.z;
      syncDepth(obj);
      if (obj === companion) syncPetColRing();
    }
  }
}

/** Kick balls from Main + cast (other players) — same feet collision. */
function kickBallsFromActors() {
  const actors = [];
  if (player?.mesh && !player.driving && player.mesh.visible !== false) {
    actors.push({
      x: player.mesh.position.x,
      z: player.mesh.position.z + FEET_NUDGE_Z,
      r: player.radius || 22,
      vx: player.vx || 0,
      vz: player.vz || 0,
    });
  }
  for (const obj of pickables) {
    if (obj.userData?.kind !== "character") continue;
    if (obj.visible === false || obj.userData?.driving) continue;
    const dx = obj.userData._moveDx || 0;
    const dz = obj.userData._moveDz || 0;
    // Approximate velocity from last script step (units/frame → /sec ~ *60)
    actors.push({
      x: obj.position.x,
      z: obj.position.z + FEET_NUDGE_Z,
      r: NPC_WALK_RADIUS,
      vx: dx * 60,
      vz: dz * 60,
    });
    obj.userData._moveDx = 0;
    obj.userData._moveDz = 0;
  }
  for (const a of actors) {
    for (const ball of pickables) {
      const phy = ball.userData?.physics;
      if (!ball.userData?.ball || !phy) continue;
      const dx = ball.position.x - a.x;
      const dz = ball.position.z - a.z;
      const dist = Math.hypot(dx, dz) || 0.0001;
      const minDist = a.r + phy.r;
      if (dist >= minDist) continue;
      const push = (minDist - dist) / dist;
      ball.position.x += dx * push;
      ball.position.z += dz * push;
      const nx = dx / dist;
      const nz = dz / dist;
      const move = Math.hypot(a.vx, a.vz);
      const impulse = BALL_KICK * (0.35 + move * 18);
      phy.vx += nx * impulse + a.vx * 28;
      phy.vz += nz * impulse + a.vz * 28;
    }
  }
}

function tickBallPhysics(dt) {
  kickBallsFromActors();
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
    resolveBallVsWalkZone(ball, phy);
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
    showPromptAbove(occupiedVehicle, "in", "/Stop");
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "E veya /stop · İn";
    return;
  }
  if (player.skating && occupiedSkateboard) {
    nearbyVehicle = null;
    nearbySkateboard = null;
    showPromptAbove(occupiedSkateboard, "in", "/Stop");
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "E veya /stop · İn";
    return;
  }
  const p = player.mesh.position;
  nearbySkateboard = nearestSkateboard(p.x, p.z);
  nearbyVehicle = nearestVehicle(p.x, p.z);
  // prefer skateboard if both in range
  if (nearbySkateboard) {
    showPromptAbove(nearbySkateboard, "bin", "/E");
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "E veya /e · Kaykaya bin";
  } else if (nearbyVehicle) {
    showPromptAbove(nearbyVehicle, "bin", "/E");
    if (statusEl && !statusEl.dataset.busy) statusEl.textContent = "E veya /e · Bin";
  } else {
    hidePrompt();
    if (
      statusEl &&
      !statusEl.dataset.busy &&
      (statusEl.textContent.startsWith("E ·") || statusEl.textContent.startsWith("E veya"))
    ) {
      statusEl.textContent = "Hazır";
    }
  }
}

/** Soft circular see-through around the player on building sprites (not the whole building). */
const BUILDING_CUT_RADIUS_PX = 118;
const BUILDING_CUT_OPACITY = 0.1;
const _cutScreen = new THREE.Vector3();

function patchBuildingSeeThrough(mat) {
  if (!mat || mat.userData.seeThroughPatched) return;
  mat.userData.seeThroughPatched = true;
  mat.transparent = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPlayerScreen = { value: new THREE.Vector2(-9999, -9999) };
    shader.uniforms.uCutRadius = { value: BUILDING_CUT_RADIUS_PX };
    shader.uniforms.uCutEnabled = { value: 0 };
    shader.uniforms.uCutOpacity = { value: BUILDING_CUT_OPACITY };
    mat.userData.seeThrough = shader.uniforms;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `uniform vec2 uPlayerScreen;
uniform float uCutRadius;
uniform float uCutEnabled;
uniform float uCutOpacity;
void main() {`,
      )
      .replace(
        "#include <alphatest_fragment>",
        `if (uCutEnabled > 0.5) {
	float cutD = distance(gl_FragCoord.xy, uPlayerScreen);
	float cutM = smoothstep(uCutRadius * 0.42, uCutRadius, cutD);
	diffuseColor.a *= mix(uCutOpacity, 1.0, cutM);
}
#include <alphatest_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => "buildingSeeThrough";
  mat.needsUpdate = true;
}

function isFlatCourtBuilding(path) {
  return /basketballcourt|tenniscourt|footballfield|footballstadium|soccer|playground/i.test(
    path || "",
  );
}

function tickBuildingOcclusion() {
  if (!player?.mesh) return;
  // red_light / football / tennis: actors on top of court — no facade cutout halo
  if (isRedLightScene() || isPlayfieldScene()) {
    for (const obj of pickables) {
      const u = obj.material?.userData?.seeThrough;
      if (u) u.uCutEnabled.value = 0;
    }
    return;
  }
  const focus = occupiedVehicle || player.mesh;
  const px = focus.position.x;
  const pz = focus.position.z;

  // Circle centered near character torso in screen space
  _cutScreen.copy(focus.position);
  const focusH = focus.scale?.y || player.mesh.scale?.y || 96;
  _cutScreen.y += focusH * 0.42;
  _cutScreen.project(camera);
  const bufW = renderer.domElement.width;
  const bufH = renderer.domElement.height;
  const sx = (_cutScreen.x * 0.5 + 0.5) * bufW;
  const sy = (_cutScreen.y * 0.5 + 0.5) * bufH;
  const radius = BUILDING_CUT_RADIUS_PX * renderer.getPixelRatio();

  for (const obj of pickables) {
    const d = obj.userData;
    if (!d || d.layer === "ground") continue;
    if (!/\/buildings\//i.test(d.path || "")) continue;
    // Courts are floor art, not facades — skip see-through hole
    if (isFlatCourtBuilding(d.path)) {
      const uOff = obj.material?.userData?.seeThrough;
      if (uOff) uOff.uCutEnabled.value = 0;
      continue;
    }
    const mat = obj.material;
    if (!mat) continue;
    if (!mat.userData.seeThroughPatched) patchBuildingSeeThrough(mat);
    const u = mat.userData.seeThrough;
    if (!u) continue;

    // Keep material fully opaque; only the circular hole opens when behind the facade
    mat.opacity = 1;

    const w = (d.w || 64) * (d.scale || 1);
    const h = (d.h || 64) * (d.scale || 1);
    const bx = obj.position.x;
    const bz = obj.position.z;
    const behind =
      Math.abs(px - bx) < w * 0.45 && pz < bz - 4 && pz > bz - h * 0.6;

    u.uCutEnabled.value = behind ? 1 : 0;
    u.uPlayerScreen.value.set(sx, sy);
    u.uCutRadius.value = radius;
    u.uCutOpacity.value = BUILDING_CUT_OPACITY;
    mat.alphaTest = behind ? 0.02 : 0.05;
    d._occluding = behind;
  }
}

function tick(now) {
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  tickAnims(dt);
  tickNpcScriptMove(dt);
  tickRedLightGame(dt);
  tickCharacterSeparation(dt);
  tickTraffic(dt);
  // Keep characters / pets / balls above rooms/courts after moves
  for (const obj of pickables) {
    if (isForegroundActor(obj) || isPlayfieldTopLayer(obj)) syncDepth(obj);
  }
  if (player) {
    if (occupiedVehicle) driveVehicle(dt);
    else player.update(dt);
    if (player.skating) syncSkateboardUnderPlayer();
    tickCompanions(dt);
    tickBallPhysics(dt);
    clampActorsIntoWalkZone();
    tickBuildingOcclusion();
    if (!dragging && !placing) {
      if (viewportMode === "9x16") {
        // Keep the map frame fixed — do not center on the character
        syncCameraRig(MAP_VIEW);
      } else {
        const p = occupiedVehicle ? occupiedVehicle.position : player.mesh.position;
      const t = 1 - Math.pow(0.0008, dt);
      controls.target.x += (p.x - controls.target.x) * t;
      controls.target.z += (p.z - controls.target.z) * t;
      camera.position.x = controls.target.x + CAM_OFFSET.x;
      camera.position.y = controls.target.y + CAM_OFFSET.y;
      camera.position.z = controls.target.z + CAM_OFFSET.z;
    }
  }
  }
  if (viewportMode !== "9x16") controls.update();
  updateVehiclePrompt();
  updateStaminaBar();
  syncWorldLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
