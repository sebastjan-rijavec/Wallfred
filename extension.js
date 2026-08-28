/* extension.js — Wallfred (GNOME 45+/46/47, ESM format)
 *
 * A top-panel button that:
 *   - lists the images in a folder and sets one as the wallpaper on click,
 *   - runs an optional carousel that rotates through them every 1–60 minutes.
 *
 * Setting the wallpaper is a single GSettings write to
 * org.gnome.desktop.background (picture-uri + picture-uri-dark). The carousel
 * reuses that exact code path — the only new part is a GLib timer that decides
 * *when* to rotate. Raw setInterval is never used; the timer lives in the
 * Shell main loop and is always torn down in destroy()/disable().
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IMAGE_RE = /\.(png|jpe?g)$/i;
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;
const THUMB_COLUMNS = 3;
const THUMB_SIZE = 120;   // display px; source thumbnails are 128px (cached)
const FAV_COUNT = 5;      // how many "most used" thumbnails to surface
const FAV_THUMB_SIZE = 84;

function log(msg) {
    console.log(`[Wallfred] ${msg}`);
}

/* A menu row holding a 1–60 slider and a live "Every N min" label.
 * The slider's 0..1 value maps to whole minutes; changes flow both ways
 * through the interval-minutes GSetting. */
const IntervalItem = GObject.registerClass(
class IntervalItem extends PopupMenu.PopupBaseMenuItem {
    _init(settings) {
        super._init({activate: false, reactive: true, can_focus: false});
        this._settings = settings;

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 92px;',
        });

        const minutes = settings.get_int('interval-minutes');
        this._slider = new Slider.Slider(this._toValue(minutes));
        this._slider.x_expand = true;

        this.add_child(this._label);
        this.add_child(this._slider);
        this._updateLabel(minutes);

        this._sliderChangedId = this._slider.connect('notify::value', () => {
            const m = this._toMinutes(this._slider.value);
            this._updateLabel(m);
            if (this._settings.get_int('interval-minutes') !== m)
                this._settings.set_int('interval-minutes', m);
        });

        // Reflect changes made elsewhere (e.g. the prefs window).
        this._settingChangedId = settings.connect('changed::interval-minutes', () => {
            const m = settings.get_int('interval-minutes');
            this._updateLabel(m);
            const v = this._toValue(m);
            if (Math.abs(this._slider.value - v) > 1e-6)
                this._slider.value = v;
        });

    }

    destroy() {
        if (this._sliderChangedId) {
            this._slider.disconnect(this._sliderChangedId);
            this._sliderChangedId = null;
        }
        if (this._settingChangedId) {
            this._settings.disconnect(this._settingChangedId);
            this._settingChangedId = null;
        }
        super.destroy();
    }

    _toMinutes(value) {
        return Math.round(MIN_MINUTES + value * (MAX_MINUTES - MIN_MINUTES));
    }

    _toValue(minutes) {
        return (minutes - MIN_MINUTES) / (MAX_MINUTES - MIN_MINUTES);
    }

    _updateLabel(minutes) {
        this._label.text = `Every ${minutes} min`;
    }

    // Let keyboard and scroll interact with the slider directly.
    vfunc_key_press_event(event) {
        return this._slider.vfunc_key_press_event(event);
    }

    vfunc_scroll_event(event) {
        return this._slider.vfunc_scroll_event(event);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Wallfred');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._timerId = null;

        // Shared thumbnail cache (disk-backed under ~/.cache/thumbnails).
        this._thumbFactory = GnomeDesktop.DesktopThumbnailFactory.new(
            GnomeDesktop.DesktopThumbnailSize.NORMAL);
        this._thumbCache = new Map();

        this.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic',
            style_class: 'system-status-icon',
        }));

        // --- "Most used" thumbnails (rebuilt when the menu opens) ----------
        // Populated from usage-stats; stays empty (zero height) until the
        // user has picked at least one wallpaper.
        this._favSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._favSection);

        // --- Rotate on/off -------------------------------------------------
        this._rotateSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Rotate Wallpaper', this._settings.get_boolean('rotate-enabled'));
        // PopupSwitchMenuItem exposes no bindable 'state' *property*, so wire
        // the toggle to the GSetting by hand instead of Gio.Settings.bind().
        this._rotateSwitch.connect('toggled', (_item, state) => {
            if (this._settings.get_boolean('rotate-enabled') !== state)
                this._settings.set_boolean('rotate-enabled', state);
        });
        this.menu.addMenuItem(this._rotateSwitch);

        // --- Interval 1–60 min --------------------------------------------
        this.menu.addMenuItem(new IntervalItem(this._settings));

        // --- Shuffle vs sequential ----------------------------------------
        this._shuffleSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Shuffle Order', this._settings.get_boolean('shuffle'));
        this._shuffleSwitch.connect('toggled', (_item, state) => {
            if (this._settings.get_boolean('shuffle') !== state)
                this._settings.set_boolean('shuffle', state);
        });
        this._shuffleChangedId = this._settings.connect('changed::shuffle', () => {
            const on = this._settings.get_boolean('shuffle');
            if (this._shuffleSwitch.state !== on)
                this._shuffleSwitch.setToggleState(on);
        });
        this.menu.addMenuItem(this._shuffleSwitch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Manual advance -----------------------------------------------
        const nextItem = new PopupMenu.PopupMenuItem('Next Wallpaper Now');
        nextItem.connect('activate', () => this._rotate());
        this.menu.addMenuItem(nextItem);

        // --- All wallpapers, in a collapsible submenu ----------------------
        this._listSub = new PopupMenu.PopupSubMenuMenuItem('Wallpapers');
        this.menu.addMenuItem(this._listSub);

        // Refresh the "Most used" row and the full grid when the menu opens.
        this._menuStateId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._rebuildFavorites();
                this._rebuildList();
            }
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('Settings');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);

        // --- React to setting changes -------------------------------------
        this._enabledChangedId = this._settings.connect(
            'changed::rotate-enabled', () => this._onEnabledChanged());
        this._intervalChangedId = this._settings.connect(
            'changed::interval-minutes', () => this._onIntervalChanged());

        // Resume the carousel if it was left on.
        if (this._settings.get_boolean('rotate-enabled')) {
            this._rotate();
            this._restartTimer();
        }
    }

    // --- carousel folder --------------------------------------------------
    _carouselDir() {
        const configured = this._settings.get_string('carousel-dir');
        if (configured && configured.length > 0)
            return configured;
        return GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'Wallpapers']);
    }

    _scanImages() {
        const dir = Gio.File.new_for_path(this._carouselDir());
        const out = [];
        let en;
        try {
            en = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return out;
        }
        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            if (IMAGE_RE.test(name))
                out.push(dir.get_child(name).get_path());
        }
        en.close(null);
        out.sort((a, b) => a.localeCompare(b));
        return out;
    }

    _toUri(path) {
        return GLib.filename_to_uri(path, null);
    }

    _setWallpaper(path) {
        const uri = this._toUri(path);
        this._bg.set_string('picture-uri', uri);
        this._bg.set_string('picture-uri-dark', uri);
        log(`wallpaper -> ${path}`);
    }

    // --- usage tracking ---------------------------------------------------
    // Explicit user choices (thumbnail clicks) both apply the wallpaper and
    // bump its counter. Automatic rotations call _setWallpaper directly and
    // are deliberately not counted, so the ranking reflects real preference.
    _applyChoice(path) {
        this._recordChoice(path);
        this._setWallpaper(path);
    }

    _recordChoice(path) {
        const stats = this._settings.get_value('usage-stats').deep_unpack();
        stats[path] = (stats[path] || 0) + 1;
        this._settings.set_value('usage-stats', new GLib.Variant('a{su}', stats));

        const last = this._settings.get_value('usage-last').deep_unpack();
        last[path] = Math.floor(GLib.get_real_time() / 1e6);
        this._settings.set_value('usage-last', new GLib.Variant('a{sx}', last));

        log(`choice recorded: ${path} (×${stats[path]})`);
    }

    // Top FAV_COUNT existing files by count, ties broken by most-recent use.
    _topChoices() {
        const stats = this._settings.get_value('usage-stats').deep_unpack();
        const last = this._settings.get_value('usage-last').deep_unpack();
        return Object.keys(stats)
            .filter(p => stats[p] > 0 && GLib.file_test(p, GLib.FileTest.EXISTS))
            .sort((a, b) =>
                stats[b] - stats[a] || (last[b] || 0) - (last[a] || 0))
            .slice(0, FAV_COUNT)
            .map(p => [p, stats[p]]);
    }

    // Pick the next image and apply it. Shuffle avoids an immediate repeat;
    // sequential steps to the next filename after the current one.
    _rotate() {
        const images = this._scanImages();
        if (images.length === 0) {
            log(`no images in ${this._carouselDir()}`);
            return;
        }
        const current = this._bg.get_string('picture-uri');
        let next;
        if (this._settings.get_boolean('shuffle')) {
            if (images.length === 1) {
                next = images[0];
            } else {
                do {
                    next = images[Math.floor(Math.random() * images.length)];
                } while (this._toUri(next) === current);
            }
        } else {
            const idx = images.findIndex(p => this._toUri(p) === current);
            next = images[(idx + 1) % images.length];
        }
        this._setWallpaper(next);
    }

    // Return the path to a cached 128px thumbnail for `path`, generating and
    // saving one the first time. Falls back to the original image on failure.
    _thumbFor(path) {
        if (this._thumbCache.has(path))
            return this._thumbCache.get(path);

        let thumb = null;
        try {
            const file = Gio.File.new_for_path(path);
            const info = file.query_info(
                'standard::content-type,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
            const uri = file.get_uri();
            const mtime = info.get_modification_date_time().to_unix();

            thumb = this._thumbFactory.lookup(uri, mtime);
            if (!thumb &&
                !this._thumbFactory.has_valid_failed_thumbnail(uri, mtime)) {
                const pix = this._thumbFactory.generate_thumbnail(
                    uri, info.get_content_type(), null);
                if (pix) {
                    this._thumbFactory.save_thumbnail(pix, uri, mtime, null);
                    thumb = this._thumbFactory.lookup(uri, mtime);
                }
            }
        } catch (e) {
            logError(e, '[Wallfred] thumbnail generation failed');
        }

        this._thumbCache.set(path, thumb);
        return thumb;
    }

    // Fill the top-of-menu "Most used" row from usage-stats. Empty when the
    // user hasn't picked anything yet, so it takes no space.
    _rebuildFavorites() {
        this._favSection.removeAll();
        const top = this._topChoices();
        if (top.length === 0)
            return;

        const header = new PopupMenu.PopupMenuItem('Most Used', {
            reactive: false,
            can_focus: false,
        });
        header.add_style_class_name('wallfred-section-header');
        this._favSection.addMenuItem(header);

        const current = this._bg.get_string('picture-uri');
        const layout = new Clutter.GridLayout({
            column_spacing: 8,
            row_spacing: 4,
        });
        const grid = new St.Widget({
            layout_manager: layout,
            style_class: 'wallfred-fav-grid',
            x_expand: true,
        });

        top.forEach(([path, count], i) => {
            const box = new St.BoxLayout({
                vertical: true,
                style_class: 'wallfred-fav-item',
            });
            box.add_child(new St.Icon({
                gicon: new Gio.FileIcon({
                    file: Gio.File.new_for_path(this._thumbFor(path) || path),
                }),
                icon_size: FAV_THUMB_SIZE,
            }));
            box.add_child(new St.Label({
                text: `×${count}`,
                style_class: 'wallfred-fav-count',
                x_align: Clutter.ActorAlign.CENTER,
            }));

            const selected = this._toUri(path) === current;
            const button = new St.Button({
                child: box,
                can_focus: true,
                style_class: selected
                    ? 'wallfred-thumb wallfred-thumb-selected'
                    : 'wallfred-thumb',
                x_expand: false,
            });
            button.accessible_name =
                `${path.replace(/^.*\//, '')}, chosen ${count} times`;
            button.connect('clicked', () => {
                this._applyChoice(path);
                this.menu.close();
            });
            layout.attach(button, i, 0, 1, 1);
        });

        const holder = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            reactive: false,
            can_focus: false,
        });
        holder.add_child(grid);
        this._favSection.addMenuItem(holder);
        this._favSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    // Fill the collapsible "Wallpapers" submenu with a thumbnail grid of
    // every image in the folder — the way to reach anything not yet a favorite.
    _rebuildList() {
        this._listSub.menu.removeAll();

        const images = this._scanImages();
        if (images.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('(no images found)');
            empty.setSensitive(false);
            this._listSub.menu.addMenuItem(empty);
            return;
        }

        const current = this._bg.get_string('picture-uri');

        const layout = new Clutter.GridLayout({
            column_spacing: 8,
            row_spacing: 8,
        });
        const grid = new St.Widget({
            layout_manager: layout,
            style_class: 'wallfred-thumb-grid',
            x_expand: true,
        });

        images.forEach((path, i) => {
            const icon = new St.Icon({
                gicon: new Gio.FileIcon({
                    file: Gio.File.new_for_path(this._thumbFor(path) || path),
                }),
                icon_size: THUMB_SIZE,
            });
            const selected = this._toUri(path) === current;
            const button = new St.Button({
                child: icon,
                can_focus: true,
                style_class: selected
                    ? 'wallfred-thumb wallfred-thumb-selected'
                    : 'wallfred-thumb',
                x_expand: false,
            });
            button.accessible_name = path.replace(/^.*\//, '');
            button.connect('clicked', () => {
                this._applyChoice(path);
                this.menu.close();
            });
            layout.attach(button, i % THUMB_COLUMNS,
                Math.floor(i / THUMB_COLUMNS), 1, 1);
        });

        const holder = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            reactive: false,
            can_focus: false,
        });
        holder.add_child(grid);
        this._listSub.menu.addMenuItem(holder);
    }

    // --- timer lifecycle --------------------------------------------------
    _restartTimer() {
        this._stopTimer();
        const secs = this._settings.get_int('interval-minutes') * 60;
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, secs, () => {
                this._rotate();
                return GLib.SOURCE_CONTINUE;
            });
        log(`carousel started: every ${this._settings.get_int('interval-minutes')} min`);
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
            log('carousel stopped');
        }
    }

    _onEnabledChanged() {
        const on = this._settings.get_boolean('rotate-enabled');
        // Keep the menu switch in step with changes made elsewhere (prefs).
        if (this._rotateSwitch.state !== on)
            this._rotateSwitch.setToggleState(on);
        if (on) {
            this._rotate();          // immediate feedback when turned on
            this._restartTimer();
        } else {
            this._stopTimer();
        }
    }

    _onIntervalChanged() {
        // Re-arm at the new cadence without forcing a rotation.
        if (this._settings.get_boolean('rotate-enabled'))
            this._restartTimer();
    }

    destroy() {
        this._stopTimer();
        if (this._menuStateId) {
            this.menu.disconnect(this._menuStateId);
            this._menuStateId = null;
        }
        if (this._enabledChangedId)
            this._settings.disconnect(this._enabledChangedId);
        if (this._intervalChangedId)
            this._settings.disconnect(this._intervalChangedId);
        if (this._shuffleChangedId)
            this._settings.disconnect(this._shuffleChangedId);
        this._enabledChangedId = null;
        this._intervalChangedId = null;
        this._shuffleChangedId = null;
        super.destroy();
    }
});

export default class WallfredExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        log('enabled');
    }

    disable() {
        // Mandatory teardown: destroy() removes the GLib timer source.
        this._indicator?.destroy();
        this._indicator = null;
        log('disabled');
    }
}
