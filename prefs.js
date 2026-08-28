/* prefs.js — Adwaita preferences for Wallfred (GNOME 45+/46/47).
 *
 * Same four settings as the panel menu, in a proper window: folder chooser,
 * interval (1–60), shuffle, and the rotation on/off switch. */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WallfredPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Carousel',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Wallpaper carousel',
            description: 'Rotate through a folder of wallpapers every 1–60 minutes.',
        });
        page.add(group);

        // --- Folder --------------------------------------------------------
        const folderRow = new Adw.EntryRow({title: 'Wallpaper folder'});
        settings.bind('carousel-dir', folderRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);

        const browse = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
        });
        browse.add_css_class('flat');
        browse.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose wallpaper folder'});
            dialog.select_folder(window, null, (dlg, res) => {
                try {
                    const folder = dlg.select_folder_finish(res);
                    if (folder)
                        settings.set_string('carousel-dir', folder.get_path());
                } catch (_e) {
                    // dismissed — ignore
                }
            });
        });
        folderRow.add_suffix(browse);
        group.add(folderRow);

        // --- Interval 1–60 -------------------------------------------------
        const intervalRow = new Adw.SpinRow({
            title: 'Rotation interval',
            subtitle: 'Minutes (1–60)',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 60, step_increment: 1, page_increment: 5,
            }),
        });
        // Bind int<->double manually to avoid a GType mismatch on the binding.
        intervalRow.set_value(settings.get_int('interval-minutes'));
        const intervalSettingId = settings.connect('changed::interval-minutes',
            () => intervalRow.set_value(settings.get_int('interval-minutes')));
        intervalRow.connect('notify::value', () => {
            const v = Math.round(intervalRow.get_value());
            if (settings.get_int('interval-minutes') !== v)
                settings.set_int('interval-minutes', v);
        });
        window.connect('close-request',
            () => settings.disconnect(intervalSettingId));
        group.add(intervalRow);

        // --- Shuffle -------------------------------------------------------
        const shuffleRow = new Adw.SwitchRow({
            title: 'Shuffle order',
            subtitle: 'Random, never repeating the current wallpaper',
        });
        settings.bind('shuffle', shuffleRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(shuffleRow);

        // --- Rotate on/off -------------------------------------------------
        const rotateRow = new Adw.SwitchRow({title: 'Enable rotation'});
        settings.bind('rotate-enabled', rotateRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(rotateRow);

        // --- Usage statistics ---------------------------------------------
        const statsGroup = new Adw.PreferencesGroup({
            title: 'Usage statistics',
            description: 'The panel menu surfaces your most-chosen wallpapers.',
        });
        page.add(statsGroup);

        const resetRow = new Adw.ActionRow({
            title: 'Reset usage statistics',
            subtitle: 'Clear all recorded selection counts',
        });
        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('destructive-action');
        resetButton.connect('clicked', () => {
            settings.reset('usage-stats');
            settings.reset('usage-last');
        });
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;
        statsGroup.add(resetRow);

        window.add(page);
    }
}
