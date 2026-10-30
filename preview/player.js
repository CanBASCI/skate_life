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

const ANIM_ROOT = "../assets/characters/main/character/92x92";

const SETS = {
  idle: { base: `${ANIM_ROOT}/main/animations/idle`, frames: 4, fps: 3.5, loop: true },
  walk: { base: `${ANIM_ROOT}/main/animations/walk`, frames: 6, fps: 10, loop: true },
  run: { base: `${ANIM_ROOT}/main/animations/run`, frames: 6, fps: 12, loop: true },
  jump: { base: `${ANIM_ROOT}/main/animations/jump`, frames: 9, fps: 14, loop: false },
  vault: { base: `${ANIM_ROOT}/main/animations/vault`, frames: 9, fps: 14, loop: false },
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
};

const WALK_SPEED = 110;
const RUN_SPEED = 190;
const CROUCH_SPEED = 55;

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

export class Player {
  constructor(scene, { x = 0, z = 200, syncDepth } = {}) {
    this.scene = scene;
    this.syncDepth = syncDepth;
    this.keys = new Set();
    this.facing = "south";
    this.anim = "idle";
    this.frame = 0;
    this.accum = 0;
    this.busy = null;
    this.textures = {};
    this.mesh = null;
    this.ring = null;
    this.spawn = { x, z };
    this._boundKeyDown = (e) => this.onKeyDown(e);
    this._boundKeyUp = (e) => this.onKeyUp(e);
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
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(this.spawn.x, 0, this.spawn.z);
    this.mesh.userData = {
      id: "player",
      label: "player (WASD)",
      layer: "sprite",
      controllable: true,
    };
    this.scene.add(this.mesh);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(40, 46, 32),
      new THREE.MeshBasicMaterial({ color: 0xc6e86b, transparent: true, opacity: 0.75 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(this.spawn.x, 0.2, this.spawn.z);
    this.scene.add(this.ring);

    window.addEventListener("keydown", this._boundKeyDown);
    window.addEventListener("keyup", this._boundKeyUp);
    return this;
  }

  dispose() {
    window.removeEventListener("keydown", this._boundKeyDown);
    window.removeEventListener("keyup", this._boundKeyUp);
  }

  onKeyDown(e) {
    if (e.repeat) {
      this.keys.add(e.code);
      return;
    }
    this.keys.add(e.code);
    if (e.code === "Space") {
      e.preventDefault();
      this.startOneShot("jump");
    } else if (e.code === "KeyV" || e.code === "KeyF") {
      this.startOneShot("vault");
    }
  }

  onKeyUp(e) {
    this.keys.delete(e.code);
  }

  startOneShot(name) {
    if (this.busy) return;
    this.busy = name;
    this.anim = name;
    this.frame = 0;
    this.accum = 0;
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

  applyFrame() {
    const dirTex = this.textures[this.anim]?.[this.facing];
    if (!dirTex || !dirTex[this.frame] || !this.mesh) return;
    this.mesh.material.map = dirTex[this.frame];
    this.mesh.material.needsUpdate = true;
  }

  update(dt) {
    if (!this.mesh) return;

    const crouch =
      this.keys.has("KeyC") || this.keys.has("ControlLeft") || this.keys.has("ControlRight");
    const run = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const { dx, dz } = this.inputVector();
    const moving = dx !== 0 || dz !== 0;

    if (moving) {
      const facing = dirFromVector(dx, dz);
      if (facing) this.facing = facing;
    }

    if (!this.busy) {
      if (crouch) this.anim = moving ? "crouchWalk" : "crouchIdle";
      else if (moving) this.anim = run ? "run" : "walk";
      else this.anim = "idle";
    }

    let speed = 0;
    if (!this.busy && moving) {
      if (crouch) speed = CROUCH_SPEED;
      else if (run) speed = RUN_SPEED;
      else speed = WALK_SPEED;
    } else if (this.busy === "jump") {
      speed = moving ? WALK_SPEED * 0.85 : 0;
    } else if (this.busy === "vault") {
      speed = moving ? WALK_SPEED * 1.1 : WALK_SPEED * 0.7;
      if (!moving) {
        const drift = {
          east: [1, 0],
          west: [-1, 0],
          north: [0, -1],
          south: [0, 1],
          "north-east": [Math.SQRT1_2, -Math.SQRT1_2],
          "north-west": [-Math.SQRT1_2, -Math.SQRT1_2],
          "south-east": [Math.SQRT1_2, Math.SQRT1_2],
          "south-west": [-Math.SQRT1_2, Math.SQRT1_2],
        }[this.facing] || [0, 1];
        this.mesh.position.x += drift[0] * speed * dt;
        this.mesh.position.z += drift[1] * speed * dt;
      }
    }

    if (speed > 0 && (dx !== 0 || dz !== 0)) {
      this.mesh.position.x += dx * speed * dt;
      this.mesh.position.z += dz * speed * dt;
    }

    this.ring.position.x = this.mesh.position.x;
    this.ring.position.z = this.mesh.position.z;

    const cfg = SETS[this.anim];
    this.accum += dt;
    const frameDur = 1 / cfg.fps;
    while (this.accum >= frameDur) {
      this.accum -= frameDur;
      this.frame += 1;
      if (this.frame >= cfg.frames) {
        if (cfg.loop) this.frame = 0;
        else {
          this.busy = null;
          this.anim = crouch
            ? moving
              ? "crouchWalk"
              : "crouchIdle"
            : moving
              ? run
                ? "run"
                : "walk"
              : "idle";
          this.frame = 0;
        }
      }
    }
    this.applyFrame();
    if (this.syncDepth) this.syncDepth(this.mesh);
  }
}
