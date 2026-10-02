# Git identity (required)

All commits and pushes for this repo must be authored **only** as:

- Name: `CanBASCI`
- Email: `CanBASCI@users.noreply.github.com`

`Cursor Agent` / `cursoragent@cursor.com` must **never** appear as commit author, committer, or GitHub contributor.

## How to commit

Prefer env overrides (do not change `git config`):

```bash
GIT_AUTHOR_NAME="CanBASCI" \
GIT_AUTHOR_EMAIL="CanBASCI@users.noreply.github.com" \
GIT_COMMITTER_NAME="CanBASCI" \
GIT_COMMITTER_EMAIL="CanBASCI@users.noreply.github.com" \
git commit -m "..."
```

Or:

```bash
git -c user.name="CanBASCI" -c user.email="CanBASCI@users.noreply.github.com" commit -m "..."
```

After commit, verify:

```bash
git log -1 --format='%an <%ae> | %cn <%ce>'
# expect: CanBASCI <CanBASCI@users.noreply.github.com> both sides
```

Push to `main` when the user asks; do not open Cursor-named branches unless requested.
