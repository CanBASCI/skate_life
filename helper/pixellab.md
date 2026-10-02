# PixelLab MCP — Vibe Coding AI Toolkit

> Quick reference for generating pixel art while coding. Full docs: https://api.pixellab.ai/mcp/docs

## Setup (Cursor)

API token lives in repo-root `.env` as `PIXELLAB_API_TOKEN` (gitignored). Do not commit the token.

```json
{
  "mcpServers": {
    "pixellab": {
      "url": "https://api.pixellab.ai/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}
```

- Token / setup page: https://api.pixellab.ai/mcp
- Vibe Coding guide: https://pixellab.ai/vibe-coding
- API v2 (REST, when MCP tools are unavailable): https://api.pixellab.ai/v2/llms.txt

## Rules of use

- These are **MCP tools**, not REST endpoints. Prefer MCP tools when available.
- If PixelLab tools are missing in the session, say MCP is not configured — do not invent curl flows for MCP tool names.
- Creation tools are **non-blocking**: they return a job/character ID immediately (~2–5 min background).
- Poll with the matching `get_*` tool, or use `wait_for_jobs` / `list_jobs`.
- Download URLs use UUID as access key (no auth needed to download).
- Tool names may appear as `create_character` or prefixed (`mcp__pixellab__create_character`).

## Workflow pattern

```text
1. create_character(...)           → character_id
2. animate_character(id, 'walk')   → queue immediately (no wait)
3. animate_character(id, 'idle')
4. get_character(id) / wait_for_jobs → when ready, download
```

Connected tilesets can chain via `lower_base_tile_id` without waiting for the first job to finish.

## Tool map (high level)

### Characters & animation
| Tool | Role |
|------|------|
| `create_character` | Queue character (standard / pro / v3) |
| `create_character_pro_flash` | Pro Flash character + views |
| `create_character_state` | Variant of existing character |
| `animate_character` | Queue walk/idle/etc. |
| `get_character` / `list_characters` / `delete_character` | Status & CRUD |
| `update_character_tags` | Tags |
| `create_portrait_character` / `get_portrait_character` / `set_character_portrait` | Portraits |
| `create_vocal_animation` / `get_vocal_animation` / `create_talking_gif` / `get_lip_sync` | Voice / lipsync |

### Tiles & maps
| Tool | Role |
|------|------|
| `create_topdown_tileset` / `get_*` / `list_*` / `delete_*` | Top-down Wang-style tilesets |
| `create_sidescroller_tileset` / `get_*` / `list_*` / `delete_*` | Side-scroller tilesets |
| `create_isometric_tile` / `get_*` / `list_*` / `delete_*` | Isometric tiles |
| `create_tiles_pro` / `create_path_tiles` / `create_building_kit` | Pro tiles / paths / buildings |
| `get_tiles_pro` / `list_tiles_pro` / `delete_tiles_pro` | Pro tiles CRUD |

### Objects & placement
| Tool | Role |
|------|------|
| `create_map_object` / `create_1_direction_object` / `create_8_direction_object` | Objects |
| `create_object_pro_flash` / `animate_object` / `create_object_state` | Object flash / anim / state |
| `get_object` / `list_objects` / `delete_object` / `update_object_tags` | Object CRUD |
| `place_map_object` / `list_map_objects` / `move_map_object` / `remove_map_object` | Map placement |
| `select_object_frames` / `dismiss_review` | Frame review |

### Images / UI / fonts
| Tool | Role |
|------|------|
| `create_image_pro_flash` / `edit_image_pro_flash` | Image gen / edit |
| `inpaint_image` / `inpaint_image_pro_flash` | Inpaint |
| `get_pro_flash_capabilities` | Capabilities |
| `create_ui_asset` / `get_ui_asset` / `list_ui_assets` / `delete_ui_asset` | UI assets |
| `create_font` | Pixel font |

### Projects, jobs, agents, sandbox
| Tool | Role |
|------|------|
| `list_projects` / `add_to_project` / `remove_from_project` | Projects |
| `get_balance` / `list_jobs` / `wait_for_jobs` / `cancel_job` | Billing & jobs |
| `delete_animation` | Remove animation |
| `search_knowledge` | Phaser / game-dev tips |
| `agent_help` / `agent_feedback` / `agent_list` / `agent_inspect` / `agent_talk` | Deployed agents |
| `chat_*` | PixelLab chat |
| `sandbox_*` | Sandbox session / bash / deploy / playtest |

### Maps (editing / view)
See full docs for map edit tools (`view_map`, terrain edits, etc.): https://api.pixellab.ai/mcp/docs

## Useful defaults

- **Directions:** 4 (S/W/E/N) or 8 (+ diagonals). Pro/v3 often force 8.
- **Size:** default ~48px; standard/pro max 128; v3 up to 256.
- **View:** `low top-down` (classic RPG 3/4), `high top-down`, `side`, `oblique` (beta).
- **Proportions (humanoid):** presets `default`, `chibi`, `cartoon`, `stylized`, `realistic_male`, `realistic_female`, `heroic`.
- **Quadrupeds:** `body_type='quadruped'` + `template` in `bear` \| `cat` \| `dog` \| `horse` \| `lion`.
- Character fills ~60% of canvas height.

## MCP resources (docs inside the server)

- `pixellab://docs/overview`
- `pixellab://docs/python/sidescroller-tilesets`
- `pixellab://docs/python/wang-tilesets`
- `pixellab://docs/godot/sidescroller-tilesets`
- `pixellab://docs/godot/isometric-tiles`
- `pixellab://docs/godot/wang-tilesets`
- `pixellab://docs/unity/isometric-tilemaps-2d`

## Status icons in responses

- Success / Processing / Error — creation is async; always follow up with `get_*` or `wait_for_jobs`.

## Notes for this repo

- Repo: `skate_life`
- Secrets: `.env` (`PIXELLAB_API_TOKEN`, `PIXELLAB_MCP_URL`)
- This file is the durable cheat-sheet; prefer updating it when we add project-specific character/tileset IDs.
