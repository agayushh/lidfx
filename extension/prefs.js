import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function spawnScan(helperPath) {
    try {
        const proc = Gio.Subprocess.new(
            ['python3', '-u', helperPath, '--scan'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [, stdout] = proc.communicate_utf8(null, null);
        const line = stdout.trim().split('\n').filter(part => part.startsWith('{')).pop();
        return JSON.parse(line);
    } catch {
        return null;
    }
}

export default class LidFxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(420, 640);
        const settings = this.getSettings();
        const helper = this.dir.get_child('sensor-helper.py').get_path();
        const scan = spawnScan(helper);

        const page = new Adw.PreferencesPage({
            title: _('LidFx'),
            icon_name: 'computer-symbolic',
        });

        const intro = new Adw.PreferencesGroup({
            title: _('LidFx'),
            description: _('Your desktop follows your lid.'),
        });

        const enabled = new Adw.SwitchRow({
            title: _('On'),
            subtitle: _('Fold the live desktop as the lid closes'),
        });
        settings.bind('effect-on', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        intro.add(enabled);
        page.add(intro);

        const sensor = new Adw.PreferencesGroup({title: _('Sensor')});
        const detected = new Adw.ActionRow({
            title: _('Detected'),
            subtitle: scan?.available
                ? `${scan.label}${scan.angle != null ? ` · ${Math.round(scan.angle)}°` : ''}`
                : _('No lid-angle sensor, accelerometer, or lid webcam is available'),
        });
        sensor.add(detected);
        const camera = new Adw.SwitchRow({
            title: _('Estimate lid angle from the webcam'),
            subtitle: _('Fallback on laptops with no lid-angle sensor or accelerometer. The camera LED stays on while LidFx is on.'),
        });
        settings.bind('camera-estimate', camera, 'active', Gio.SettingsBindFlags.DEFAULT);
        sensor.add(camera);
        const invert = new Adw.SwitchRow({
            title: _('Invert webcam direction'),
            subtitle: _('Use this if closing the lid unfolds the desktop instead of folding it'),
        });
        settings.bind('camera-invert', invert, 'active', Gio.SettingsBindFlags.DEFAULT);
        sensor.add(invert);
        page.add(sensor);

        const look = new Adw.PreferencesGroup({title: _('Look')});

        const strengthAdj = new Gtk.Adjustment({
            lower: 25,
            upper: 100,
            step_increment: 5,
            page_increment: 10,
        });
        const strength = new Adw.SpinRow({
            title: _('Effect strength'),
            subtitle: _('100% is the full fold'),
            adjustment: strengthAdj,
            digits: 0,
        });
        const syncStrength = () => {
            const value = Math.round(settings.get_double('effect-strength') * 100);
            if (strength.value !== value)
                strength.value = value;
        };
        syncStrength();
        strength.connect('notify::value', () => {
            settings.set_double('effect-strength', strength.value / 100);
        });
        settings.connect('changed::effect-strength', syncStrength);
        look.add(strength);

        const openAdj = new Gtk.Adjustment({
            lower: 25,
            upper: 180,
            step_increment: 1,
            page_increment: 10,
        });
        const open = new Adw.SpinRow({
            title: _('Open position'),
            subtitle: _('Comfortable viewing angle in degrees. Default is 100°.'),
            adjustment: openAdj,
            digits: 0,
        });
        const syncOpen = () => {
            const value = Math.round(settings.get_double('open-angle'));
            if (open.value !== value)
                open.value = value;
        };
        syncOpen();
        open.connect('notify::value', () => {
            settings.set_double('open-angle', open.value);
        });
        settings.connect('changed::open-angle', syncOpen);
        look.add(open);
        page.add(look);

        const hardware = ['iio-lid', 'intel-lid', 'dual-accel', 'hid', 'accel', 'inclinometer'].includes(scan?.source);
        const input = new Adw.PreferencesGroup({
            title: _('Lid'),
            description: hardware
                ? _('A hardware sensor is driving the fold. Set your open position from the top-bar menu, then close the lid to follow it.')
                : _('If no lid-angle sensor is present, LidFx can estimate the angle from the built-in webcam, or fold on lid close / the Fold slider.'),
        });
        const lidSwitch = new Adw.SwitchRow({
            title: _('Fold on lid close'),
            subtitle: _('Used when no live angle sensor is found. Holds off sleep long enough to play the fold.'),
        });
        settings.bind('lid-switch-fold', lidSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        input.add(lidSwitch);
        const foldAdj = new Gtk.Adjustment({
            lower: 8,
            upper: 180,
            step_increment: 1,
            page_increment: 10,
        });
        const virtual = new Adw.SpinRow({
            title: _('Manual lid angle'),
            subtitle: _('Used when no hardware sensor is found'),
            adjustment: foldAdj,
            digits: 0,
        });
        const syncVirtual = () => {
            const value = Math.round(settings.get_double('virtual-angle'));
            if (virtual.value !== value)
                virtual.value = value;
        };
        syncVirtual();
        virtual.connect('notify::value', () => {
            settings.set_double('virtual-angle', virtual.value);
        });
        settings.connect('changed::virtual-angle', syncVirtual);
        input.add(virtual);
        page.add(input);

        const keys = new Adw.PreferencesGroup({title: _('Keyboard')});
        const shortcut = new Adw.ActionRow({
            title: _('Toggle LidFx'),
            subtitle: _('Ctrl+Alt+H'),
        });
        keys.add(shortcut);
        page.add(keys);

        window.add(page);
    }
}
