# Characters

## HARD RULE — Main character reference

**Canonical main character is `assets/characters/main/` (high top-down).**

- **character_id:** `37ad4d45-4dfd-442e-ace5-f38ec3c83706`
- **view:** high top-down
- **directions:** 8
- **look:** high-school male student, dark hair tied back (small bun/ponytail), white hoodie, blue jeans, red sneakers

### When adding clothes, bags, accessories, states, or variants

1. Always use this character as the identity/style reference.
2. Prefer PixelLab `style_character_id=37ad4d45-4dfd-442e-ace5-f38ec3c83706` (or `create_character_state` from this id).
3. Visual style reference file: `assets/characters/main/south.png` (and other dirs under the same folder).
4. Keep **high top-down**, **8 directions**, boardless character sprites unless explicitly requested otherwise.
5. Do **not** use `assets/characters/main-low/` as the main reference (low top-down archive only).

### Layout

- rotations: `assets/characters/main/{south,south-east,east,...}.png`
- animations: `assets/characters/main/animations/{walk,idle}/{dir}/frame_XXX.png`
- package: `assets/characters/main/character-with-anims.zip`

## Main Low Top-Down archive (`assets/characters/main-low/`)

Previous low top-down variant. Comparison / backup only — not the game main.
