# Objects

## Main skateboard (`assets/objects/skateboard/`)

4-direction board aligned to main character dirs: `south` / `east` / `north` / `west`.

### Why handmade
PixelLab object tools have **no `oblique` view** (only low/high top-down / side). Prompt-only generation stayed bird’s-eye; AI 8-dir rotation from a reference collapsed to orthographic top/side views. Canonical boards are therefore hand-authored oblique sprites.

### Direction axes
| Dir | Board axis | Matches character |
|-----|------------|-------------------|
| south | nose lower-left | south faces bottom-left |
| east | nose lower-right | east faces bottom-right |
| north | nose lower-right | north feet toward lower-right |
| west | nose lower-right | west lean in this set |

### Files
- `south.png` `east.png` `north.png` `west.png`
- `preview-4dir.png` / `preview-with-main-*.png`
- `meta/info.json`
