# Characters

## Main (`assets/characters/main/`)

Primary playable character for the skate game.

- **character_id:** `b51afdd0-5318-456f-b17b-82744028af53`
- **role:** main character
- **mode:** standard
- **view:** oblique
- **directions:** 4 (south, east, north, west)
- **size:** 92x92
- **notes:** boardless; streetwear hoodie look
- **download:** https://api.pixellab.ai/mcp/characters/b51afdd0-5318-456f-b17b-82744028af53/download

### Animations

| Name | Template | Frames | Dirs | Path |
|------|----------|--------|------|------|
| `idle` | `breathing-idle` | 4 | 4 | `animations/idle/{dir}/frame_XXX.png` |
| `walk` | `walk` | 6 | 4 | `animations/walk/{dir}/frame_XXX.png` |

Also mirrored under PixelLab layout: `Idle/animations/{idle,walk}/...`  
Full package: `character-with-anims.zip`

### Static rotations

- `south.png` / `east.png` / `north.png` / `west.png`
- `Idle/rotations/*.png`
