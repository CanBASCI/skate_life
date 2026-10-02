# Characters

## HARD RULE — Main character reference

**Canonical identity reference is the 92×92 high top-down character.**

| Size | Path | character_id | Role |
|------|------|--------------|------|
| **92×92** (game scale + master reference) | `assets/characters/main/character/92x92/` | `37ad4d45-4dfd-442e-ace5-f38ec3c83706` | **Active game size.** Identity + style source for all variants. Houses/map props scale to this. |
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
    {south,south-east,east,...}.png
    animations/{walk,idle}/{dir}/frame_XXX.png
    character-with-anims.zip
  64x64/
    {south,south-east,east,...}.png
    animations/{walk,idle}/{dir}/frame_XXX.png
    character-with-anims.zip
```
