# Characters

## HARD RULE — Main character reference

**Canonical identity reference is the 92×92 high top-down character.**

| Size | Path | character_id | Role |
|------|------|--------------|------|
| **92×92** (game scale + master reference) | `assets/characters/main/character/92x92/` (state **`main`**) | `37ad4d45-4dfd-442e-ace5-f38ec3c83706` | **Active game size.** Walk/idle/run/jump/vault under `main/animations/`. |
| **64×64** (optional smaller variant) | `assets/characters/main/character/64x64/` | `25c95faa-03fb-4cdf-808c-031c97dba441` | Kept on disk; not the current gameplay target |

- **view:** high top-down
- **directions:** 8
- **look:** high-school male student, dark hair tied back (small bun/ponytail), white hoodie, blue jeans, red sneakers
- **separate assets:** character and skateboard stay separate — never store pre-mounted composites

### When adding clothes, bags, accessories, states, or variants

1. Always use the **92×92** character as the identity/style reference.
2. Prefer PixelLab `style_character_id=37ad4d45-4dfd-442e-ace5-f38ec3c83706` (or `create_character_state` from this id) when **size ≥ source content size**.
3. Visual style reference file: `assets/characters/main/character/92x92/south.png`.
4. Keep **high top-down**, **8 directions**, boardless character sprites unless explicitly requested otherwise.
5. Do **not** composite the character onto the skateboard in asset files.

### Downsizing note (92 → 64)

`mode=pro` + `style_character_id` **cannot** target a smaller canvas than the style character (job fails; no charge). For a smaller size:

1. Nearest-neighbor scale `92x92/south.png` → 64×64.
2. `create_character` with `mode=v3`, `view=high top-down`, `size=64`, `reference_image_base64` (or URL) of that 64px south.
3. Then queue `walk` / `breathing-idle` for all 8 directions.

### Layout

```
assets/characters/main/character/
  92x92/
    main/                         # PixelLab state name
      rotations/
      animations/{walk,idle,run,jump,vault}/
    animations/{walk,idle,run,jump,vault}/       # convenience mirror of main
    {south,south-east,...}.png
    character-with-anims.zip
  64x64/
    ...
```

### withSkate stance idle (no board in sprite)

- **state:** `withSkate` — `assets/characters/main/character/92x92/states/withSkate/`
- **character_id:** `2be6dc14-97ed-493e-b32c-3f9d26ac1d5c`
- **pose:** knees bent, head turned right, arms slightly out; empty hands; **no skateboard drawn**
- **animation:** under `animations/` (sibling of PixelLab state `main`)
- Board is a separate object; mount in game code.

### crouch state (duck / hold low)

- **state:** `crouch` — `assets/characters/main/character/92x92/states/crouch/`
- **character_id:** `12076436-e27d-4015-98b9-5875c3ecf071`
- **pose:** deep game crouch, hips low, knees bent; empty hands; **no skateboard**
- **idle:** pose-frozen v3 breathing (`animations/idle/`) — do **not** use `breathing-idle` template (stands them up)
- **walk:** `crouched-walking` (`animations/walk/`) — stays low while stepping

### sit state (no bench)

- **state:** `sit` — `assets/characters/main/character/92x92/states/sit/`
- **character_id:** `82a5ecf5-0b39-4edb-a260-1f84ec18dfa1`
- **pose:** sitting with knees bent / hips lowered; hands on thighs; **no bench, chair, or props**
- **idle:** pose-frozen v3 breathing (`animations/idle/`) — do **not** use `breathing-idle` template (stands them up)

### Outfit / gear states (synced rotations)

Synced under `assets/characters/main/states/<name>/92x92/` (south + 8 rotations):

| state | character_id |
|-------|--------------|
| `footballOutfit` | `83a05bc7-454f-45ee-895e-170b2f44eb63` |
| `playFootballOutfit` | `8e201d38-94e6-4fc1-b196-0d04f51a3046` |
| `blueDenimJacket` | `2ac4b002-ac42-4e12-b468-5171ed206b65` |
| `nbaOutfit` | `490532ad-4201-4d13-8039-228d98491c98` |
| `holding the skateboa` → folder `holdingSkateboard` | `2db7225c-9c99-4041-9420-b4a9cb7d1492` |
| `backpackOnBackside` | `5e7e61bc-1b2a-4ebf-85f4-162c4a1193dd` |

### Scale rule

Canvas size **matters** when assets share a scene. Game reference is **92×92** main. Vehicles in this project are mostly **168×168**, buildings **256×256**, small props/animals **32–96**. Preview: `preview/` (`python3 -m http.server` from repo root → `/preview/`).

