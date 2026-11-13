import * as THREE from "three";

const DIRS = [
  "east",
  "north-east",
  "north",
  "north-west",
  "west",
  "south-west",
  "south",
  "south-east",
];

const ANIM_ROOT = "../assets/characters/main/character/96x96";

const SETS = {
  idle: { base: `${ANIM_ROOT}/main/animations/idle`, frames: 4, fps: 3.5, loop: true },
  walk: { base: `${ANIM_ROOT}/main/animations/walk`, frames: 6, fps: 10, loop: true },
  run: { base: `${ANIM_ROOT}/main/animations/run`, frames: 6, fps: 12, loop: true },
  jump: { base: `${ANIM_ROOT}/main/animations/jump`, frames: 9, fps: 14, loop: false },
  vault: { base: `${ANIM_ROOT}/main/animations/vault`, frames: 9, fps: 14, loop: false },
  dance: {
    base: `../assets/characters/main/96x96/states/main/animations/dance`,
    frames: 8,
    fps: 10,
    loop: true,
  },
  skateIdle: {
    // main_skate — rider stands sideways on the board
    base: `../assets/characters/main/96x96/states/main_skate/animations/skate-idle`,
    frames: 5,
    fps: 5,
    loop: true,
  },
  crouchIdle: {
    base: `${ANIM_ROOT}/states/crouch/animations/idle`,
    frames: 5,
    fps: 3.5,
    loop: true,
  },
  crouchWalk: {
    base: `${ANIM_ROOT}/states/crouch/animations/walk`,
    frames: 6,
    fps: 9,
    loop: true,
  },
  sit: {
    base: `${ANIM_ROOT}/states/sit/animations/idle`,
    frames: 5,
    fps: 3.5,
    loop: true,
  },
};

const WALK_SPEED = 110;
const RUN_SPEED = 190;
const CROUCH_SPEED = 55;
const SKATE_SPEED = 200;
const SKATE_BOOST = 280;
/** Foot-run stamina only (not skate / vehicle). */
const STAMINA_MAX = 100;
const STAMINA_DRAIN = 28; // per second while sprinting
const STAMINA_REGEN = 18; // per second when not sprinting
const STAMINA_REGEN_DELAY = 0.35; // sec after sprint before regen

function frameUrl(base, dir, i) {
  return new URL(`${base}/${dir}/frame_${String(i).padStart(3, "0")}.png`, import.meta.url)
    .href;
}

function loadTexture(loader, url) {
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

/** +Z = south (toward camera / screen-bottom with high top-down cam). */
export function dirFromVector(dx, dz) {
  if (dx === 0 && dz === 0) return null;
  const ang = Math.atan2(-dz, dx);
  const oct = Math.round((ang / Math.PI) * 4);
  const idx = ((oct % 8) + 8) % 8;
  return DIRS[idx];
}

/** Compass clockwise — 90° = 2 steps. */
const SKATE_TRAVEL_CW = [
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
];

/**
 * Skate stance: rider faces 90° from travel (board nose).
 * Going east (right) → character south anim.
 * south-east → north-east (other perpendicular; +90 SW art reads wrong).
 */
export function skateRiderFacing(travelDir) {
  if (travelDir === "south-east") return "north-east";
  const i = SKATE_TRAVEL_CW.indexOf(travelDir);
  if (i < 0) return "south";
  return SKATE_TRAVEL_CW[(i + 2) % 8];
}

/** While skating, drop sprite slightly so feet sit on the deck. */
const SKATE_SPRITE_CENTER_Y = 0.04;

/**
 * Sprite is bottom-anchored at mesh xz, but art has pad under the shoes and the
 * iso camera makes the painted feet read north of that anchor. Collision + ring
 * use mesh.z + FEET_NUDGE_Z so the green disk sits under the visible feet.
 */
export const FEET_NUDGE_Z = -28;

/**
 * PixelLab drew dance east/west (and diagonals) smaller in the 96 canvas
 * (~54px tall vs south ~64px). Boost those dirs so visual size matches south.
 */
/** Shared with placed characters so dance facings match Main’s size. */
export const DANCE_DIR_SCALE = {
  south: 1,
  north: 1,
  east: 1.14,
  west: 1.14,
  "south-east": 1.12,
  "south-west": 1.12,
  "north-east": 1.12,
  "north-west": 1.12,
};

export class Player {
  constructor(
    scene,
    { x = 0, z = 200, syncDepth, collides = null, findVault = null, radius = 22 } = {},
  ) {
    this.scene = scene;
    this.syncDepth = syncDepth;
    /** (x, z, r) => true if blocked */
    this.collides = collides;
    /** () => { landX, landZ, ignore } | null — vaultable obstacle ahead */
    this.findVault = findVault;
    this.radius = radius;
    this.keys = new Set();
    this.facing = "south";
    this.anim = "idle";
    this.frame = 0;
    this.accum = 0;
    this.busy = null;
    /** @type {{ fromX:number, fromZ:number, toX:number, toZ:number, ignore: object|null, dur:number, t:number } | null} */
    this.vaultMove = null;
    this.textures = {};
    this.mesh = null;
    this.ring = null;
    /** When false, green collision disk stays hidden (debug toggle). */
    this.colRingEnabled = true;
    this.spawn = { x, z };
    /** world units moved last frame (for ball kicks) */
    this.vx = 0;
    this.vz = 0;
    /** true while controlling a vehicle — character hidden, no walk update */
    this.driving = false;
    /** riding placed skateboard — uses skate-idle 8-dir anims */
    this.skating = false;
    /** 0..1 jump progress (for ollie board tip); 0 when not jumping */
    this.ollieU = 0;
    this.stamina = STAMINA_MAX;
    this.staminaMax = STAMINA_MAX;
    /** true while foot-sprint is actively draining (for UI bar) */
    this.sprinting = false;
    this._staminaRegenWait = 0;
    /** Chat /R3 style move: { dx, dz, left, speed } unit vectors + remaining distance */
    this.scriptMove = null;
    /** Chat /sit — locked sit idle until /stop or move */
    this.sitting = false;
    this._boundKeyDown = (e) => this.onKeyDown(e);
    this._boundKeyUp = (e) => this.onKeyUp(e);
  }

  startSkating() {
    if (!this.mesh) return;
    this.skating = true;
    this.driving = false;
    this.busy = null;
    this.vaultMove = null;
    this.anim = "skateIdle";
    this.frame = 0;
    this.accum = 0;
    this.mesh.center.set(0.5, SKATE_SPRITE_CENTER_Y);
    this.applyFrame();
  }

  stopSkating() {
    this.skating = false;
    this.anim = "idle";
    this.frame = 0;
    this.accum = 0;
    if (this.mesh) this.mesh.center.set(0.5, 0);
    this.applyFrame();
  }

  setVisible(on) {
    if (!this.mesh) return;
    this.mesh.visible = on;
    this.syncColRingVisibility();
  }

  setColRingEnabled(on) {
    this.colRingEnabled = !!on;
    this.syncColRingVisibility();
  }

  syncColRingVisibility() {
    if (!this.ring) return;
    this.ring.visible = !!this.colRingEnabled && !!this.mesh?.visible;
  }

  /** World XZ of the collision feet (under painted shoes). */
  feetXZ(x = this.mesh?.position.x, z = this.mesh?.position.z) {
    return { x: x ?? 0, z: (z ?? 0) + FEET_NUDGE_Z };
  }

  /** Collision disk under visible feet. Pass mesh xz (nudge applied here). */
  syncRing(x = this.mesh?.position.x, z = this.mesh?.position.z) {
    if (!this.ring || x == null || z == null) return;
    const feet = this.feetXZ(x, z);
    this.ring.position.x = feet.x;
    this.ring.position.z = feet.z;
    this.ring.position.y = 0.2;
  }

  tryMove(dx, dz) {
    if (!this.mesh) return;
    if (!dx && !dz) {
      this.vx = 0;
      this.vz = 0;
      return;
    }
    const x0 = this.mesh.position.x;
    const z0 = this.mesh.position.z;
    const nx = x0 + dx;
    const nz = z0 + dz;
    if (!this.collides) {
      this.mesh.position.x = nx;
      this.mesh.position.z = nz;
    } else {
      // Collide at feet; move mesh anchor (axis-separate for wall slide)
      if (dx && !this.collides(nx, z0 + FEET_NUDGE_Z, this.radius)) {
        this.mesh.position.x = nx;
      }
      if (
        dz &&
        !this.collides(this.mesh.position.x, nz + FEET_NUDGE_Z, this.radius)
      ) {
        this.mesh.position.z = nz;
      }
    }
    this.vx = this.mesh.position.x - x0;
    this.vz = this.mesh.position.z - z0;
  }

  async load() {
    const loader = new THREE.TextureLoader();
    const jobs = [];
    for (const [name, cfg] of Object.entries(SETS)) {
      this.textures[name] = {};
      for (const dir of DIRS) {
        this.textures[name][dir] = new Array(cfg.frames);
        for (let i = 0; i < cfg.frames; i++) {
          const url = frameUrl(cfg.base, dir, i);
          jobs.push(
            loadTexture(loader, url).then((tex) => {
              this.textures[name][dir][i] = tex;
            }),
          );
        }
      }
    }
    await Promise.all(jobs);

    const first = this.textures.idle.south[0];
    const w = first.image.width;
    const h = first.image.height;
    const mat = new THREE.SpriteMaterial({
      map: first,
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
    });
    this.mesh = new THREE.Sprite(mat);
    this.mesh.center.set(0.5, 0);
    this.baseScale = w;
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(this.spawn.x, 0, this.spawn.z);
    this.mesh.userData = {
      id: "player",
      label: "player (WASD)",
      layer: "sprite",
      controllable: true,
    };
    this.scene.add(this.mesh);

    // Exact collision footprint at feet (same center + radius as tryMove / playerCollides)
    const r = this.radius;
    this.ring = new THREE.Group();
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(this.spawn.x, 0.2, this.spawn.z + FEET_NUDGE_Z);
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(r, 48),
      new THREE.MeshBasicMaterial({
        color: 0x3ddc6a,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(1, r - 1.5), r + 0.5, 48),
      new THREE.MeshBasicMaterial({
        color: 0x9ef0a8,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    fill.renderOrder = 99990;
    rim.renderOrder = 99991;
    this.ring.add(fill, rim);
    this.ring.userData.skipPick = true;
    this.scene.add(this.ring);
    this.syncColRingVisibility();

    window.addEventListener("keydown", this._boundKeyDown);
    window.addEventListener("keyup", this._boundKeyUp);
    return this;
  }

  dispose() {
    window.removeEventListener("keydown", this._boundKeyDown);
    window.removeEventListener("keyup", this._boundKeyUp);
  }

  onKeyDown(e) {
    const tag = e.target?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      e.target?.isContentEditable
    ) {
      return;
    }
    if (e.repeat) {
      this.keys.add(e.code);
      return;
    }
    this.keys.add(e.code);
    if (this.driving) return;
    if (e.code === "Space") {
      e.preventDefault();
      // skating: jump ollie still ok; vault if near obstacle
      const v = this.findVault?.() || null;
      if (v && !this.skating) this.startVault(v);
      else this.startOneShot("jump");
    } else if ((e.code === "KeyV" || e.code === "KeyF") && !this.skating) {
      e.preventDefault();
      const v = this.findVault?.() || null;
      if (v) this.startVault(v);
      else this.startOneShot("vault");
    } else if (e.code === "KeyH" || e.code === "KeyG") {
      e.preventDefault();
      if (this.skating) return;
      this.toggleDance();
    }
  }

  onKeyUp(e) {
    const tag = e.target?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      e.target?.isContentEditable
    ) {
      return;
    }
    this.keys.delete(e.code);
  }

  startOneShot(name) {
    if (this.busy) return;
    this.sitting = false;
    this.scriptMove = null;
    this.busy = name;
    this.anim = name;
    this.frame = 0;
    this.accum = 0;
    this.vaultMove = null;
    this.applyFrame();
  }

  /** H / G — dance loop; again or WASD to stop. */
  toggleDance() {
    if (!this.mesh || this.driving) return;
    if (this.busy === "dance") {
      this.stopDance();
      return;
    }
    this.startDance();
  }

  startDance() {
    if (!this.mesh || this.driving) return false;
    if (this.busy && this.busy !== "dance") return false;
    this.sitting = false;
    this.scriptMove = null;
    this.keys.clear();
    this.busy = "dance";
    this.anim = "dance";
    this.frame = 0;
    this.accum = 0;
    this.vaultMove = null;
    this.applyFrame();
    return true;
  }

  stopDance() {
    if (this.busy !== "dance") return;
    this.busy = null;
    this.anim = "idle";
    this.frame = 0;
    this.accum = 0;
    this.applyFrame();
  }

  startSit() {
    if (!this.mesh || this.driving || this.skating) return false;
    if (this.busy && this.busy !== "dance") return false;
    this.scriptMove = null;
    this.keys.clear();
    this.busy = null;
    this.sitting = true;
    this.anim = "sit";
    this.frame = 0;
    this.accum = 0;
    this.vaultMove = null;
    this.applyFrame();
    return true;
  }

  startJump() {
    if (!this.mesh || this.driving) return false;
    if (this.busy) return false;
    this.sitting = false;
    this.scriptMove = null;
    this.startOneShot("jump");
    return true;
  }

  /** Absolute-dir scripted walk (chat /R3). dx,dz unit or any vector; distance in world units. */
  startScriptMove(dx, dz, distance, speed = WALK_SPEED) {
    if (!this.mesh || this.driving || !(distance > 0)) return false;
    const len = Math.hypot(dx, dz);
    if (!len) return false;
    this.sitting = false;
    this.scriptMove = {
      dx: dx / len,
      dz: dz / len,
      left: distance,
      speed: speed || WALK_SPEED,
    };
    this.busy = null;
    this.vaultMove = null;
    this.keys.clear();
    const facing = dirFromVector(dx, dz);
    if (facing) this.facing = facing;
    this.anim = "walk";
    this.frame = 0;
    this.accum = 0;
    this.applyFrame();
    return true;
  }

  /** Stop dance / sit / scripted walk / held keys (chat /stop). */
  stopActions() {
    this.scriptMove = null;
    this.sitting = false;
    this.keys.clear();
    this.vaultMove = null;
    if (this.busy === "dance" || this.busy === "jump" || this.busy === "vault") {
      this.busy = null;
    }
    this.sprinting = false;
    if (this.mesh) {
      this.mesh.position.y = 0;
      this.anim = this.skating ? "skateIdle" : "idle";
      this.frame = 0;
      this.accum = 0;
      this.applyFrame();
    }
  }

  /** Vault over an obstacle: play vault anim + slide to far side. */
  startVault({ landX, landZ, ignore = null } = {}) {
    if (this.busy || !this.mesh) return;
    const cfg = SETS.vault;
    this.busy = "vault";
    this.anim = "vault";
    this.frame = 0;
    this.accum = 0;
    this.vaultMove = {
      fromX: this.mesh.position.x,
      fromZ: this.mesh.position.z,
      toX: landX,
      toZ: landZ,
      ignore,
      dur: cfg.frames / cfg.fps,
      t: 0,
    };
    this.applyFrame();
  }

  inputVector() {
    let dx = 0;
    let dz = 0;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) dx += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) dx -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) dz += 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) dz -= 1;
    if (dx !== 0 && dz !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dz *= inv;
    }
    return { dx, dz };
  }

  /** Facing used for sprite: sideways on board while skating. */
  animFacing() {
    if (this.skating && this.anim === "skateIdle") {
      return skateRiderFacing(this.facing);
    }
    return this.facing;
  }

  applyFrame() {
    const face = this.animFacing();
    const dirTex = this.textures[this.anim]?.[face];
    if (!dirTex || !dirTex[this.frame] || !this.mesh) return;
    this.mesh.material.map = dirTex[this.frame];
    this.mesh.material.needsUpdate = true;
    const base = this.baseScale || 96;
    const boost =
      this.anim === "dance" && !this.skating ? DANCE_DIR_SCALE[face] || 1 : 1;
    const s = base * boost;
    this.mesh.scale.set(s, s, 1);
  }

  update(dt) {
    if (!this.mesh) return;
    this.vx = 0;
    this.vz = 0;
    if (this.driving) return;

    // Chat scripted walk (/R3) — overrides WASD until done or /stop
    if (this.scriptMove) {
      const sm = this.scriptMove;
      const step = Math.min(sm.left, sm.speed * dt);
      const x0 = this.mesh.position.x;
      const z0 = this.mesh.position.z;
      this.tryMove(sm.dx * step, sm.dz * step);
      const moved = Math.hypot(this.mesh.position.x - x0, this.mesh.position.z - z0);
      sm.left -= Math.max(moved, step * 0.25);
      this.busy = null;
      this.anim = "walk";
      this.syncRing();
      const cfg = SETS.walk;
      this.accum += dt;
      const frameDur = 1 / cfg.fps;
      while (this.accum >= frameDur) {
        this.accum -= frameDur;
        this.frame = (this.frame + 1) % cfg.frames;
      }
      this.applyFrame();
      if (this.syncDepth) this.syncDepth(this.mesh);
      if (sm.left <= 0.5 || moved < step * 0.05) {
        this.scriptMove = null;
        this.anim = "idle";
        this.frame = 0;
        this.accum = 0;
        this.applyFrame();
      }
      return;
    }

    const crouch =
      this.keys.has("KeyC") || this.keys.has("ControlLeft") || this.keys.has("ControlRight");
    const wantRun = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const { dx, dz } = this.inputVector();
    const moving = dx !== 0 || dz !== 0;

    // stamina: only normal foot run (not skate / vehicle)
    this.sprinting = false;
    let canSprint = false;
    if (!this.skating && !this.driving && !crouch) {
      if (wantRun && moving && this.stamina > 0.5) {
        canSprint = true;
        this.sprinting = true;
        this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
        this._staminaRegenWait = STAMINA_REGEN_DELAY;
        if (this.stamina <= 0.5) {
          this.stamina = 0;
          canSprint = false;
          this.sprinting = false;
        }
      } else {
        this._staminaRegenWait = Math.max(0, this._staminaRegenWait - dt);
        if (this._staminaRegenWait <= 0) {
          this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);
        }
      }
    } else {
      // skating / vehicle: hide drain, keep full for when you hop off
      this.stamina = STAMINA_MAX;
      this._staminaRegenWait = 0;
    }

    if (moving) {
      const facing = dirFromVector(dx, dz);
      if (facing) this.facing = facing;
      // walking cancels dance / sit
      if (this.busy === "dance") {
        this.busy = null;
        this.vaultMove = null;
      }
      if (this.sitting) this.sitting = false;
    }

    if (!this.busy) {
      if (this.skating) this.anim = "skateIdle";
      else if (this.sitting) this.anim = "sit";
      else if (crouch) this.anim = moving ? "crouchWalk" : "crouchIdle";
      else if (moving) this.anim = canSprint ? "run" : "walk";
      else this.anim = "idle";
    }

    let speed = 0;
    if (!this.busy && !this.sitting && moving) {
      if (this.skating) speed = wantRun ? SKATE_BOOST : SKATE_SPEED;
      else if (crouch) speed = CROUCH_SPEED;
      else if (canSprint) speed = RUN_SPEED;
      else speed = WALK_SPEED;
    } else if (this.busy === "jump" || (this.busy === "vault" && !this.vaultMove)) {
      // jump / free vault: keep moving in held WASD dir (like Space)
      speed = moving
        ? (this.skating ? SKATE_SPEED * 0.9 : WALK_SPEED * 0.95)
        : 0;
    }

    // vault over obstacle: lerp to far side
    if (this.busy === "vault" && this.vaultMove) {
      const vm = this.vaultMove;
      vm.t += dt;
      const u = Math.min(1, vm.t / vm.dur);
      const s = u * u * (3 - 2 * u); // smoothstep
      const x0 = this.mesh.position.x;
      const z0 = this.mesh.position.z;
      this.mesh.position.x = vm.fromX + (vm.toX - vm.fromX) * s;
      this.mesh.position.z = vm.fromZ + (vm.toZ - vm.fromZ) * s;
      this.mesh.position.y = Math.sin(Math.PI * u) * 18;
      this.vx = this.mesh.position.x - x0;
      this.vz = this.mesh.position.z - z0;
    } else {
      if (this.busy === "jump" || (this.busy === "vault" && !this.vaultMove)) {
        const jcfg = SETS[this.busy] || SETS.jump;
        const u = Math.min(1, (this.frame + this.accum * jcfg.fps) / jcfg.frames);
        this.ollieU = this.busy === "jump" ? u : 0;
        const hop = this.busy === "jump" ? (this.skating ? 26 : 16) : 14;
        this.mesh.position.y = Math.sin(Math.PI * u) * hop;
      } else {
        this.ollieU = 0;
        if (this.mesh.position.y !== 0) this.mesh.position.y = 0;
      }
      if (speed > 0 && (dx !== 0 || dz !== 0)) {
        this.tryMove(dx * speed * dt, dz * speed * dt);
      }
    }

    this.syncRing();

    const cfg = SETS[this.anim];
    const fps =
      this.skating && this.anim === "skateIdle"
        ? moving
          ? 12
          : 5
        : cfg.fps;
    this.accum += dt;
    const frameDur = 1 / fps;
    while (this.accum >= frameDur) {
      this.accum -= frameDur;
      this.frame += 1;
      if (this.frame >= cfg.frames) {
        if (cfg.loop) this.frame = 0;
        else {
          this.busy = null;
          this.vaultMove = null;
          this.frame = 0;
          this.accum = 0;
          if (this.skating) this.anim = "skateIdle";
          else if (crouch) this.anim = moving ? "crouchWalk" : "crouchIdle";
          else if (moving) this.anim = canSprint ? "run" : "walk";
          else this.anim = "idle";
        }
      }
    }
    this.applyFrame();
    if (this.syncDepth) this.syncDepth(this.mesh);
  }
}
