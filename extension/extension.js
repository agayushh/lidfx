import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {createFoldEffect} from './foldEffect.js';
import {LidWatch} from './lidWatch.js';
import {LidMotion, nowSeconds} from './motion.js';
import {LidSensor} from './sensor.js';

function clamp(value, lo, hi) {
    return Math.min(Math.max(value, lo), hi);
}

function disableUnredirect() {
    try {
        if (Meta.disable_unredirect_for_display)
            Meta.disable_unredirect_for_display(global.display);
        else if (global.compositor?.disable_unredirect)
            global.compositor.disable_unredirect();
    } catch {
        // compositor API varies across shell versions
    }
}

function enableUnredirect() {
    try {
        if (Meta.enable_unredirect_for_display)
            Meta.enable_unredirect_for_display(global.display);
        else if (global.compositor?.enable_unredirect)
            global.compositor.enable_unredirect();
    } catch {
        // compositor API varies across shell versions
    }
}

function backgroundGroup() {
    return Main.layoutManager._backgroundGroup ?? Main.layoutManager.backgroundGroup;
}

const HingeIndicator = GObject.registerClass({
    GTypeName: 'HingeIndicator',
}, class HingeIndicator extends PanelMenu.Button {
    _init(hinge) {
        super._init(0.5, _('Hinge'));
        this._hinge = hinge;

        this._icon = new St.Icon({
            icon_name: 'computer-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._toggle = new PopupMenu.PopupSwitchMenuItem(_('On'), hinge.isOn);
        this._toggle.connect('toggled', (_item, state) => hinge.setOn(state));
        this.menu.addMenuItem(this._toggle);

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        try {
            this._status.label.clutter_text.line_wrap = true;
        } catch {
            // St.Label wrapping differs across shell versions
        }
        this.menu.addMenuItem(this._status);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._foldItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        this._foldItem.add_child(new St.Label({
            text: _('Fold'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'hinge-menu-label',
        }));
        this._foldSlider = new Slider.Slider(0);
        this._foldSlider.connect('notify::value', slider => {
            if (!this._syncing)
                hinge.setFoldAmount(slider.value);
        });
        this._foldItem.add_child(this._foldSlider);
        this.menu.addMenuItem(this._foldItem);

        this._demo = new PopupMenu.PopupMenuItem(_('Play demo'));
        this._demo.connect('activate', () => hinge.playDemo());
        this.menu.addMenuItem(this._demo);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._strengthItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        this._strengthItem.add_child(new St.Label({
            text: _('Strength'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'hinge-menu-label',
        }));
        this._strengthSlider = new Slider.Slider(1);
        this._strengthSlider.connect('notify::value', slider => {
            if (!this._syncing)
                hinge.setStrength(0.25 + slider.value * 0.75);
        });
        this._strengthItem.add_child(this._strengthSlider);
        this.menu.addMenuItem(this._strengthItem);

        this._openItem = new PopupMenu.PopupMenuItem(_('Open position'), {reactive: false});
        this.menu.addMenuItem(this._openItem);

        this._calibrate = new PopupMenu.PopupMenuItem(_('Set open position'));
        this._calibrate.connect('activate', () => hinge.calibrate());
        this.menu.addMenuItem(this._calibrate);

        this._resync = new PopupMenu.PopupMenuItem(_('Reconnect sensor'));
        this._resync.connect('activate', () => hinge.reconnectSensor());
        this.menu.addMenuItem(this._resync);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._prefs = new PopupMenu.PopupMenuItem(_('Settings…'));
        this._prefs.connect('activate', () => hinge.openPrefs());
        this.menu.addMenuItem(this._prefs);

        this.sync();
    }

    sync() {
        this._syncing = true;
        const hinge = this._hinge;
        this._toggle.setToggleState(hinge.isOn);
        this._toggle.setSensitive(!hinge.isStarting);
        this._status.label.text = hinge.statusText;
        this._foldItem.visible = !hinge.hasHardwareSensor;
        this._foldSlider.value = hinge.foldAmount;
        this._strengthSlider.value = (hinge.strength - 0.25) / 0.75;
        this._openItem.label.text = `${_('Open position')}: ${Math.round(hinge.openAngle)}°`;
        this._calibrate.setSensitive(hinge.hasHardwareSensor && !hinge.isStarting);
        this._resync.setSensitive(!hinge.isStarting);
        this._icon.icon_name = hinge.isOn && hinge.isClosing
            ? 'computer-symbolic'
            : 'computer-symbolic';
        this._syncing = false;
    }
});

export default class HingeExtension extends Extension {
    enable() {
        log('Hinge: enabling');
        this._settings = this.getSettings();
        this._effects = [];
        this._signals = [];
        this._demoStart = 0;
        this._lidAnim = null;
        this._lidFinishId = 0;
        this._resting = true;
        this._overview = false;
        this._unredirected = false;
        this._lastShownAngle = undefined;
        this._lastShownSource = undefined;

        const openAngle = this._readOpenAngle();
        this._motion = new LidMotion(openAngle);
        this._sensor = new LidSensor();
        this._sensor.onAngle = angle => this._onSensor(angle);
        this._applySensorOptions();
        this._sensor.setExtensionPath(this.path);

        this._lidWatch = new LidWatch();
        this._lidWatch.onClosed = () => this._onLidClosed();
        this._lidWatch.onOpened = () => this._onLidOpened();
        this._lidWatch.onWake = () => this._onWake();

        this._indicator = new HingeIndicator(this);
        Main.panel.addToStatusArea('hinge@agayushh.github.io', this._indicator);

        this._bindShortcut();
        this._connect(this._settings, 'changed', (_s, key) => this._onSettings(key));
        this._connect(Main.overview, 'showing', () => this._setOverview(true));
        this._connect(Main.overview, 'hidden', () => this._setOverview(false));
        this._connect(Main.layoutManager, 'startup-complete', () => this._syncEnabled());
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._dropEffects();
            this._syncLidIntercept();
            if (this.isOn)
                this._tick();
        });

        this._timeline = new Clutter.Timeline({repeat_count: -1, duration: 1000});
        if (this._timeline.set_actor)
            this._timeline.set_actor(global.stage);
        this._timelineId = this._timeline.connect('new-frame', () => this._tick());

        this._syncEnabled();
        this._indicator.sync();
        log(`Hinge: enabled (sensor=${this._sensor.source}, on=${this.isOn}, lidFold=${this._usesLidSwitchFold()})`);
    }

    disable() {
        for (const [obj, id] of this._signals) {
            try {
                obj.disconnect(id);
            } catch {
                // already disconnected
            }
        }
        this._signals = [];

        Main.wm.removeKeybinding('toggle-shortcut');
        this._stopTimeline();
        if (this._timeline) {
            if (this._timelineId)
                this._timeline.disconnect(this._timelineId);
            this._timeline.run_dispose();
        }
        this._timelineId = 0;
        this._dropEffects();
        this._restoreUnredirect();
        if (this._lidFinishId) {
            GLib.source_remove(this._lidFinishId);
            this._lidFinishId = 0;
        }
        this._lidWatch?.destroy();
        this._lidWatch = null;
        this._sensor?.stop();
        this._sensor = null;
        this._motion = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._timeline = null;
        this._settings = null;
    }

    get isOn() {
        return this._settings?.get_boolean('effect-on') ?? false;
    }

    get isStarting() {
        return false;
    }

    get isClosing() {
        return this._motion?.isClosing ?? false;
    }

    get hasHardwareSensor() {
        return this._sensor?.available ?? false;
    }

    get openAngle() {
        return this._readOpenAngle();
    }

    get strength() {
        return clamp(this._settings.get_double('effect-strength'), 0.25, 1);
    }

    get foldAmount() {
        const open = this.openAngle;
        const angle = this._virtualAngle;
        return clamp((open - angle) / Math.max(open - 8, 1), 0, 1);
    }

    get statusText() {
        if (this._lidAnim)
            return this._lidAnim.kind === 'close'
                ? _('Lid closing — folding the desktop, then sleep.')
                : _('Lid opening — unfolding the desktop.');
        if (this._demoStart)
            return _('Playing a close and open demo.');
        if (this._sensor?.source === 'pending')
            return _('Looking for a lid or accelerometer sensor…');
        if (this.hasHardwareSensor) {
            const angle = this._sensor.angle;
            const reading = angle == null ? _('waiting') : `${Math.round(angle)}°`;
            return `${this._sensor.label} · ${reading}`;
        }
        return _('No live lid angle. Close the lid to fold, drag Fold, or play a demo.');
    }

    get _virtualAngle() {
        return clamp(this._settings.get_double('virtual-angle'), 8, 180);
    }

    setOn(value) {
        this._settings.set_boolean('effect-on', value);
    }

    setFoldAmount(amount) {
        const open = this.openAngle;
        const angle = open - clamp(amount, 0, 1) * (open - 8);
        this._settings.set_double('virtual-angle', angle);
        if (amount > 0.001)
            this.setOn(true);
        this._startTimeline();
    }

    setStrength(value) {
        this._settings.set_double('effect-strength', clamp(value, 0.25, 1));
    }

    calibrate() {
        const angle = this._motion.calibrate();
        if (angle == null) {
            Main.notify(_('Hinge'), _('Open the lid to your comfortable viewing position first.'));
            return;
        }
        this._settings.set_double('open-angle', angle);
        this._applySensorOptions();
        this._indicator.sync();
    }

    reconnectSensor() {
        this._sensor?.reconnect();
        this._indicator?.sync();
        Main.notify(_('Hinge'), _('Looking for a lid or accelerometer sensor…'));
    }

    playDemo() {
        this._demoStart = nowSeconds();
        this.setOn(true);
        this._startTimeline();
        this._indicator.sync();
    }

    openPrefs() {
        this.openPreferences();
    }

    _readOpenAngle() {
        const value = this._settings.get_double('open-angle');
        return Number.isFinite(value) && value >= 25 && value <= 180 ? value : 100;
    }

    _applySensorOptions() {
        let camera = true;
        let invert = false;
        try {
            camera = this._settings.get_boolean('camera-estimate');
        } catch {
            camera = true;
        }
        try {
            invert = this._settings.get_boolean('camera-invert');
        } catch {
            invert = false;
        }
        this._sensor?.setCameraOptions({
            enabled: camera,
            baseline: this.openAngle,
            invert,
        });
    }

    _connect(obj, signal, cb) {
        const id = obj.connect(signal, cb);
        this._signals.push([obj, id]);
        return id;
    }

    _bindShortcut() {
        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.setOn(!this.isOn));
    }

    _onSettings(key) {
        if (key === 'open-angle') {
            this._motion.setBaseline(this.openAngle);
            this._applySensorOptions();
        }
        if (key === 'camera-estimate' || key === 'camera-invert') {
            this._applySensorOptions();
            this._sensor?.reconnect();
        }
        if (key === 'effect-on' || key === 'lid-switch-fold')
            this._syncEnabled();
        if (key === 'toggle-shortcut') {
            Main.wm.removeKeybinding('toggle-shortcut');
            this._bindShortcut();
        }
        if (this.isOn && (key === 'virtual-angle' || key === 'effect-strength'))
            this._startTimeline();
        this._indicator?.sync();
    }

    _onSensor(angle) {
        this._syncLidIntercept();
        const rounded = angle == null ? null : Math.round(angle);
        if (rounded !== this._lastShownAngle || this._sensor?.source !== this._lastShownSource) {
            this._lastShownAngle = rounded;
            this._lastShownSource = this._sensor?.source;
            this._indicator?.sync();
        }
        if (!this.isOn || this._demoStart || this._lidAnim)
            return;
        const update = this._motion.receive(angle);
        if (update.beganClosing)
            this._startTimeline();
    }

    _usesLidSwitchFold() {
        let lidFold = true;
        try {
            lidFold = this._settings.get_boolean('lid-switch-fold');
        } catch {
            lidFold = true;
        }
        return this.isOn && lidFold && !this.hasHardwareSensor && !this._hasExternalMonitor();
    }

    _hasExternalMonitor() {
        return (Main.layoutManager.monitors?.length ?? 1) > 1;
    }

    _syncLidIntercept() {
        if (this._usesLidSwitchFold())
            this._lidWatch?.inhibitLidSwitch();
        else
            this._lidWatch?.releaseInhibit();
    }

    _onLidClosed() {
        if (!this._usesLidSwitchFold())
            return;
        this._playLidClose();
    }

    _onLidOpened() {
        if (this._lidAnim?.kind === 'close') {
            this._cancelLidFinish();
            this._playLidOpen();
            return;
        }
        if (!this.isOn || this.hasHardwareSensor)
            return;
        this._playLidOpen();
    }

    _onWake() {
        if (!this.isOn)
            return;
        this._syncLidIntercept();
        this._sensor?.reconnect();
        let camera = false;
        try {
            camera = this._settings.get_boolean('camera-estimate');
        } catch {
            camera = false;
        }
        if (this.hasHardwareSensor || camera)
            return;
        this._playLidOpen();
    }

    _playLidClose() {
        this._demoStart = 0;
        this._cancelLidFinish();
        this._dropEffects();
        this._lidAnim = {kind: 'close', t0: nowSeconds(), duration: 1.15};
        this._motion.setEnabled(true);
        this._startTimeline();
        this._indicator?.sync();
        log('Hinge: playing lid-close fold');
    }

    _playLidOpen() {
        if (this._lidAnim?.kind === 'open')
            return;
        this._demoStart = 0;
        this._cancelLidFinish();
        this._dropEffects();
        this._lidAnim = {kind: 'open', t0: nowSeconds(), duration: 1.2};
        this._motion.setEnabled(true);
        this._motion.receive(12, nowSeconds());
        this._motion.snapProgress(1);
        this._startTimeline();
        this._tick();
        this._indicator?.sync();
        log('Hinge: playing lid-open unfold');
    }

    _lidAnimAngle(time) {
        const anim = this._lidAnim;
        const u = clamp((time - anim.t0) / anim.duration, 0, 1);
        const ease = u * u * (3 - 2 * u);
        const open = this.openAngle;
        const closed = 12;
        if (anim.kind === 'close') {
            if (u >= 1) {
                this._lidAnim = null;
                this._finishLidClose();
                return closed;
            }
            return open + (closed - open) * ease;
        }
        if (u >= 1) {
            this._lidAnim = null;
            this._indicator?.sync();
            return open;
        }
        return closed + (open - closed) * ease;
    }

    _finishLidClose() {
        this._indicator?.sync();
        if (!this._lidWatch?.closed)
            return;
        this._lidFinishId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._lidFinishId = 0;
            if (this._lidWatch?.closed)
                this._lidWatch.releaseInhibit();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelLidFinish() {
        if (this._lidFinishId) {
            GLib.source_remove(this._lidFinishId);
            this._lidFinishId = 0;
        }
    }

    _syncEnabled() {
        const on = this.isOn;
        this._motion.setEnabled(on);
        this._syncLidIntercept();
        if (on) {
            this._sensor.setTracking(true);
            this._sensor.reconnect();
            this._startTimeline();
        } else {
            this._demoStart = 0;
            this._lidAnim = null;
            this._cancelLidFinish();
            this._sensor.setTracking(false);
            this._sensor.reconnect();
            this._motion.receive(this._currentAngle());
            this._tick();
            if (this._resting)
                this._stopTimeline();
        }
    }

    _setOverview(hiddenUnderOverview) {
        this._overview = hiddenUnderOverview;
        if (hiddenUnderOverview && !this._lidAnim)
            this._dropEffects();
        else if (this.isOn)
            this._startTimeline();
    }

    _currentAngle() {
        if (this._lidAnim)
            return this._lidAnimAngle(nowSeconds());
        if (this._demoStart)
            return this._demoAngle(nowSeconds());
        if (this.hasHardwareSensor)
            return this._sensor.angle;
        return this._virtualAngle;
    }

    _demoAngle(time) {
        const elapsed = time - this._demoStart;
        const cycle = 3.2;
        const repeats = 3;
        if (elapsed >= cycle * repeats) {
            this._demoStart = 0;
            this._indicator?.sync();
            return this.openAngle;
        }
        const local = elapsed % cycle;
        const closed = 18;
        const open = this.openAngle;
        if (local < 1.2) {
            const u = local / 1.2;
            const ease = u * u * (3 - 2 * u);
            return open + (closed - open) * ease;
        }
        if (local < 1.6)
            return closed;
        if (local < 2.8) {
            const u = (local - 1.6) / 1.2;
            const ease = u * u * (3 - 2 * u);
            return closed + (open - closed) * ease;
        }
        return open;
    }

    _startTimeline() {
        if (this._timeline && !this._timeline.is_playing())
            this._timeline.start();
    }

    _stopTimeline() {
        if (this._timeline?.is_playing())
            this._timeline.stop();
    }

    _tick() {
        if (this._overview && !this._lidAnim) {
            this._dropEffects();
            return;
        }

        const time = nowSeconds();
        const angle = this._currentAngle();
        if (!this.hasHardwareSensor || this._demoStart || this._lidAnim)
            this._motion.receive(angle, time);
        const progress = this._motion.sample(time) * this.strength;

        if (progress <= 0.00001) {
            this._dropEffects();
            this._resting = true;
            this._restoreUnredirect();
            if (!this.isOn && !this._demoStart && !this._lidAnim)
                this._stopTimeline();
            return;
        }

        this._resting = false;
        this._holdUnredirect();
        this._ensureEffects();
        for (const {actor, effect} of this._effects) {
            const width = Math.max(actor.width, 1);
            const height = Math.max(actor.height, 1);
            effect.setFold(progress, width, height);
        }
    }

    _ensureEffects() {
        if (this._effects.length)
            return;
        const shaderDir = this.dir;
        const targets = (this._lidAnim
            ? [Main.layoutManager.uiGroup]
            : [global.window_group, backgroundGroup()]).filter(actor => actor);
        for (const actor of targets) {
            try {
                const effect = createFoldEffect(shaderDir);
                if (!effect.compiled)
                    continue;
                actor.add_effect_with_name('hinge-fold', effect);
                this._effects.push({actor, effect});
            } catch (error) {
                logError(error, 'Hinge: could not attach fold effect');
            }
        }
        if (this._effects.length)
            log(`Hinge: attached ${this._effects.length} fold effects`);
    }

    _dropEffects() {
        for (const {actor, effect} of this._effects) {
            try {
                actor.remove_effect(effect);
            } catch {
                try {
                    actor.remove_effect_by_name('hinge-fold');
                } catch {
                    // actor already gone
                }
            }
        }
        this._effects = [];
    }

    _holdUnredirect() {
        if (this._unredirected)
            return;
        disableUnredirect();
        this._unredirected = true;
    }

    _restoreUnredirect() {
        if (!this._unredirected)
            return;
        enableUnredirect();
        this._unredirected = false;
    }
}
