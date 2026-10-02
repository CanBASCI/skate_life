# Objects

## Main skateboard (`assets/objects/skateboard/`)

4-direction prop matching the main character (south / east / north / west).

- **view:** oblique requested (Tibia-style). PixelLab object tools have no `oblique` enum, so generation used `low top-down` + oblique prompt wording.
- **size:** 64x64
- **files:** `south.png`, `east.png`, `north.png`, `west.png`
- **object_ids:** see `meta/info.json`

Not 8-direction — keeps parity with the 4-dir main character.
