# Objects

## Main skateboard

Separate prop (not pre-mounted under the character). Game scale follows the **96×96** main character.

| Size | Path | object_id | Role |
|------|------|-----------|------|
| **68×68 base** (canonical) | `assets/objects/skateboard/68x68/base/` | `2c0c672d-7165-47d0-99f5-3b27bbf9b586` | In-game board (correct E/W) |
| **80×80** (legacy) | `assets/objects/skateboard/80x80/` | `4cee3c3b-bb9c-4805-b83b-e1e0ccb09e4d` | Older board |
| **48×48** (legacy) | `assets/objects/skateboard/48x48/` | `719fe069-30be-4dff-89ef-6cc04e7cd4fa` | Kept for reference |

- **view:** high top-down
- **directions:** 8 (`rotations/{dir}.png` + `south.png`)
- **sizing:** preview default scale **0.70** vs 96px character; east/west are horizontal decks
- **360:** legacy `80x80/animations/spin-360/` — yaw-only turntable spin (deck face-up)

Keep board and character separate in assets; mounting/offset happens in game code.

## World props (synced day set)

| Kind | Source canvas | Path pattern |
|------|---------------|--------------|
| Buildings (day) | 256×256 → **trimmed** | `assets/buildings/<name>/256x256/day/` |
| Vehicles (day) | 168×168 → **trimmed** | `assets/vehicles/<name>/168x168/day/` |
| Park / lights / road / animals / balls | varies → **trimmed** | `assets/props/...` |

Transparent PixelLab padding is **tight-trimmed per rotation frame** (empty margin removed). Preview also re-trims on load and ignores transparent pixels when dragging. **Do not trim character animation canvases** the same way — foot/pivot alignment needs a fixed frame size.

Buildings synced (day): singleHouse, duplexHouse, cafe, bank, hospital, gasStation, highSchool, policeStation, superMarket, library, fireStation, thePub.

Vehicles synced (day): jeep, police, car, schoolBus, pickup, ambulance.
