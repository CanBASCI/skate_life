# Objects

## Main skateboard

Separate prop (not pre-mounted under the character). Game scale follows the **92×92** main character.

| Size | Path | object_id | Role |
|------|------|-----------|------|
| **80×80** (canonical for 92 char) | `assets/objects/skateboard/80x80/` | `4cee3c3b-bb9c-4805-b83b-e1e0ccb09e4d` | In-game board |
| **48×48** (legacy) | `assets/objects/skateboard/48x48/` | `719fe069-30be-4dff-89ef-6cc04e7cd4fa` | Kept for reference |

- **view:** high top-down
- **directions:** 8
- **sizing:** character content height ≈66px → board length ≈33–39px (~50–60%); canvas **80×80** leaves room for diagonal trucks/wheels
- **360:** `animations/spin-360/` — yaw-only turntable spin (deck face-up). Avoid underside flips: they invent extra wheels / wrong trucks.
- **files:** `south.png` … `south-west.png`, plus `rotations/` and `animations/spin-360/{dir}/frame_XXX.png`

Keep board and character separate in assets; mounting/offset happens in game code.
