Yes, this is very doable, and what you're describing is a classic **GNOME Shell extension**.

The "black bar" is the GNOME Shell *top panel* (the top bar). It's not a separate program you can just drop a button into — it's rendered by GNOME Shell itself, which is written in JavaScript. The supported way to add your own icon + menu there is to write an extension that GNOME Shell loads and runs inside its own process.

Here's the mental model of the pieces you'd build:

- **A panel button** — an icon you add to the top bar. In extension terms this is a `PanelMenu.Button` with a `St.Icon` inside it.
- **A popup menu** — your "subwindow." When you click the button, a `PopupMenu` drops down. This is where the wallpapers go. You can put plain text items, or build a little grid of thumbnails using `St` widgets (GNOME's UI toolkit).
- **The wallpaper source** — you point the extension at a folder (say `~/Pictures/Wallpapers`), scan it for image files, and generate one menu entry per image.
- **The actual switch** — changing the wallpaper is surprisingly simple. GNOME stores it in GSettings under `org.gnome.desktop.background`, in the keys `picture-uri` (light theme) and `picture-uri-dark` (dark theme). Your click handler just writes the file path into those keys and the desktop updates instantly. No root, no restart.

So the flow is: click icon → menu opens → you loop over image files → each click sets the GSettings key.

Two things worth deciding early, because they shape the code:

1. **Simple list vs. thumbnail grid.** A text list of filenames is easy. A visual grid with previews is nicer but means loading images into `St.Icon`/`St.Widget` and laying them out — more fiddly, especially fitting them into a popup.

2. **Your GNOME version.** GNOME 45 (2023) changed the extension format significantly — it moved to ES modules and a new `Extension` class. Code written for 44 and earlier won't load on 45+, and vice versa. So knowing your version matters before writing anything.

## Carousel: automatic rotation on a timer

On top of clicking a wallpaper by hand, you can let the extension cycle through them on its own — a carousel. The idea is a background timer that, every N minutes, picks the next image in the folder and writes it into the same GSettings keys the manual click uses. Because the switch is just a GSettings write, the auto-rotation reuses the exact same code path as a manual pick; the only new part is *what* triggers it and *when*.

The pieces you'd add:

- **An interval picker in the menu.** Extend the popup with a submenu (a `PopupSubMenuMenuItem`) listing the interval choices. Constrain these to **whole minutes, 1 through 60** — nothing below 1 minute and nothing above 1 hour. You can offer every minute (1, 2, 3, … 60) or a shorter curated set (1, 5, 10, 15, 30, 60); either way each entry just stores an integer number of minutes.
- **An on/off toggle.** A `PopupSwitchMenuItem` labelled something like "Rotate wallpaper" so the carousel can be turned on and off without losing the chosen interval.
- **The timer itself.** Use `GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, callback)`. GNOME Shell extensions must **not** use raw JavaScript `setInterval` — you schedule through GLib so the timer lives in the Shell's main loop. The callback advances an index into the (sorted) image list, wraps around at the end, writes the new path to `picture-uri` / `picture-uri-dark`, and returns `GLib.SOURCE_CONTINUE` so it keeps firing.
- **Restarting cleanly on change.** Whenever the user flips the toggle on, or changes the interval, remove the existing timer with `GLib.Source.remove(id)` and add a fresh one. Storing the current source id lets you tear it down; never leave two timers running.
- **Cleanup on disable.** In the extension's `disable()`, always remove the active timer source and null out the id. A leaked `GLib` timeout that keeps firing after the extension is disabled is the single most common bug in this kind of extension — it can survive lock/unlock and even reload, so treat teardown as mandatory.
- **Remembering the choice.** Persist the interval and the on/off state in the extension's own GSettings schema (or a small settings file) so the carousel resumes with the same cadence after a reboot or a Shell restart.

So the extended flow is: pick an interval (1–60 min) → flip the toggle on → a GLib timer fires every N minutes → the callback steps to the next image and writes the GSettings keys → the desktop updates, and it repeats until you toggle it off or change the interval.

One small decision to make: **rotation order.** Sequential (alphabetical by filename) is predictable and trivial. Random/shuffle feels livelier but you'll want to avoid repeating the current wallpaper back-to-back, so track the last index and re-roll if it matches.

If you want, tell me your GNOME version (run `gnome-shell --version`) and whether you'd rather start with a simple list or go straight for thumbnails — and we can talk through the structure from there.
