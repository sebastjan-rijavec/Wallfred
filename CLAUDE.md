# Wallfred — project notes for Claude Code

Wallfred is a **GNOME Shell extension** (a "wallpaper valet"): a top-panel
button that shows wallpapers as thumbnails, rotates through a folder on a
1–60 minute timer, and tracks which wallpapers you pick most.

- **Format:** GNOME 45+ ESM extension (`import`/`export`, `Extension` class).
  Developed on **GNOME 46, X11**. `metadata.json` targets shell 45/46/47.
- **UUID:** `wallfred@sebastjan-rijavec.github.io`
- **Settings schema:** `org.gnome.shell.extensions.wallfred`
- **Layout:** extension files at the **repo root** (extensions.gnome.org style),
  dev tooling alongside.

## Files

| Path | What |
|------|------|
| `metadata.json` | UUID, name, `shell-version`, `settings-schema` |
| `extension.js` | panel `Indicator`, menu, carousel `GLib` timer, usage tracking, thumbnail grid |
| `prefs.js` | Adwaita prefs (folder, interval, shuffle, rotate, reset stats) |
| `stylesheet.css` | `.wallfred-*` thumbnail-grid styling (auto-loaded) |
| `schemas/*.gschema.xml` | the 6 settings; `gschemas.compiled` is built, git-ignored |
| `gnome-ext.sh` | dev/install/test dispatcher (all workflows go through here) |
| `Makefile` | thin `make <cmd>` wrapper over `gnome-ext.sh` |
| `docs/shell_extension.md` | original design notes |

## Dev workflow

Everything is `./gnome-ext.sh <cmd>` (or `make <cmd>`):

- `make test` — **isolated nested GNOME Shell** in a window with its own
  throwaway XDG profile (`.dev-home/`). Installs+enables Wallfred there and
  runs the carousel. **Does not touch the real desktop.** This is the primary
  way to see changes — especially safe on Wayland where you can't hot-reload.
  Knobs: `TEST_INTERVAL` (min, default 1), `NESTED_SIZE`, `CAROUSEL_DIR`.
- `make install` — compiles the schema and **symlinks the repo** into
  `~/.local/share/gnome-shell/extensions/<UUID>`. Because it's a symlink,
  editing files here + reloading the shell picks up changes (no reinstall).
  `CAROUSEL_DIR=/path make install` sets the wallpaper folder.
- `make reload` — **X11 only**: `gnome-shell --replace` (windows survive).
  On Wayland you must log out/in (or just use `make test`).
- `make enable` / `disable` / `prefs` / `status` / `logs` / `schemas` / `pack`.
- `make logs` follows the journal filtered to `[Wallfred]` lines.

**Installing a brand-new extension the running shell hasn't seen:** on X11 the
shell only discovers it on reload, and `gnome-extensions enable` fails until
then. Add the UUID to `org.gnome.shell enabled-extensions` (gsettings) and it
auto-enables on the next reload.

## Gotchas we actually hit

- **Recompile the schema after editing `schemas/*.gschema.xml`:**
  `make schemas` (== `glib-compile-schemas schemas/`). The extension won't see
  new keys / changed defaults otherwise.
- **A stored GSetting always beats the schema default.** Changing a `<default>`
  does nothing for a value that's already been written; `gsettings reset` it.
  (The `make test` harness seeds `interval-minutes=1` for a fast demo, which is
  why the slider can show 1 even though the default is 30 — override with
  `TEST_INTERVAL=30`.)
- **Thumbnails:** wallpapers are large (2560×2880). We use
  `GnomeDesktop.DesktopThumbnailFactory` (pinned `gi://GnomeDesktop?version=4.0`
  — there are 3.0 and 4.0 typelibs, so pin to avoid the ambiguity warning) to
  generate/cache 128px thumbnails under `~/.cache/thumbnails`, then display the
  small cached file via `St.Icon` + `Gio.FileIcon`. Never load the full-size
  image into `St.Icon`. API: `generate_thumbnail(uri, mime, null)` then
  `save_thumbnail(pix, uri, mtime, null)` then `lookup(uri, mtime)` — the
  4.0 signatures need the trailing `cancellable` arg.
- **Carousel timer:** created with `GLib.timeout_add_seconds` (never JS
  `setInterval`), stored as `this._timerId`, and **always removed in
  `destroy()` / `disable()`** with `GLib.Source.remove`. A leaked timeout that
  keeps firing after disable is the classic bug here.
- **Usage tracking counts explicit picks only** (thumbnail clicks go through
  `_applyChoice` → `_recordChoice`); automatic rotations call `_setWallpaper`
  directly and are **not** counted, so "Most used" reflects real preference.
  Stored as `usage-stats` (`a{su}` path→count) and `usage-last` (`a{sx}`
  path→unix-seconds, for tie-breaking). Read with
  `settings.get_value(k).deep_unpack()`, write with `new GLib.Variant('a{su}', obj)`.
- **`carousel-dir` empty → falls back to `~/Pictures/Wallpapers`.** This install
  is pointed at `/mnt/storage/GitHub/IRIX-wallpaper-tiles/Pool_Carousel`.

## Menu structure (extension.js `Indicator`)

Panel icon `view-grid-symbolic` → menu, top to bottom:
1. **Most used** row — top ≤5 by count (empty until you pick something).
2. Rotate switch · interval slider (1–60) · Shuffle switch.
3. Next wallpaper now.
4. **Wallpapers ▸** collapsible submenu — full thumbnail grid (how you reach
   anything not yet a favourite; clicking bumps its count).
5. Settings…

The favourites row and full grid are rebuilt on `menu` `open-state-changed`.

## Validating without a live shell

- **JS syntax:** copy to a `.mjs` and `node --check` it (parses ESM + gi
  imports as syntax). `gi://` imports don't resolve under node, only parse.
- **Run gi code for real:** `gjs -m script.js` (module mode). Use a memory
  backend for settings tests: `GSETTINGS_SCHEMA_DIR=schemas GSETTINGS_BACKEND=memory gjs -m ...`.
- **Schema:** `glib-compile-schemas --strict schemas`.
- **Bash:** `bash -n gnome-ext.sh`.

## Current status (handover)

- ✅ Extension complete, renamed to Wallfred, committed locally
  (`Initial commit: Wallfred wallpaper valet`). **No GitHub remote yet.**
- ✅ Installed + enabled in the real session, pointed at the IRIX
  `Pool_Carousel`. **Pending: a shell reload** (Alt+F2 → `r`, or `make reload`)
  to load it under the new identity.
- ↩ The code was moved out of `../IRIX-wallpaper-tiles`; removing the old
  copies there is a manual step left to the user (`rm -rf src/extension
  src/gnome-ext.sh Makefile shell_extension.md .dev-home` + `git checkout --
  .gitignore` in that repo).

Possible next steps: push to GitHub (`gh repo create sebastjan-rijavec/Wallfred`),
add a screenshot/GIF to the README, prepare an extensions.gnome.org submission
(`make pack`), rename the `.wallfred-*` CSS / internal `irix`-free — already done.
