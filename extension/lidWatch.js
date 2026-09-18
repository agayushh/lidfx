import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const LOGIN1 = 'org.freedesktop.login1';
const LOGIN1_PATH = '/org/freedesktop/login1';
const LOGIN1_IFACE = 'org.freedesktop.login1.Manager';

function unpackMaybe(value) {
    if (value instanceof GLib.Variant)
        return value.deep_unpack();
    return value;
}

export class LidWatch {
    constructor() {
        this.onClosed = null;
        this.onOpened = null;
        this.onWake = null;
        this.closed = false;
        this._closed = false;
        this._subs = [];
        this._inhibitStream = null;
        this._pollId = 0;
        this._subscribe();
        this._readClosed();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._readClosed();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this.releaseInhibit();
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        for (const id of this._subs) {
            try {
                Gio.DBus.system.signal_unsubscribe(id);
            } catch {
                // already gone
            }
        }
        this._subs = [];
    }

    get inhibiting() {
        return this._inhibitStream != null;
    }

    inhibitLidSwitch() {
        if (this._inhibitStream)
            return;
        if (this._tryInhibit('handle-lid-switch', 'block',
            'Play the desktop fold before sleep'))
            return;
        this._tryInhibit('sleep', 'delay',
            'Play the desktop fold before sleep');
    }

    _tryInhibit(what, mode, why) {
        try {
            const [variant, fdList] = Gio.DBus.system.call_with_unix_fd_list_sync(
                LOGIN1,
                LOGIN1_PATH,
                LOGIN1_IFACE,
                'Inhibit',
                new GLib.Variant('(ssss)', [what, 'LidFx', why, mode]),
                GLib.VariantType.new('(h)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null);
            const [index] = variant.deep_unpack();
            const fd = fdList.get(index);
            this._inhibitStream = Gio.UnixInputStream.new(fd, true);
            log(`LidFx: acquired ${mode} inhibit for ${what}`);
            return true;
        } catch (error) {
            logError(error, `LidFx: could not inhibit ${what}`);
            return false;
        }
    }

    releaseInhibit() {
        if (!this._inhibitStream)
            return;
        try {
            this._inhibitStream.close(null);
        } catch {
            // already closed
        }
        this._inhibitStream = null;
        log('LidFx: released lid-switch inhibit');
    }

    _subscribe() {
        this._subs.push(Gio.DBus.system.signal_subscribe(
            LOGIN1,
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            LOGIN1_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _iface, _signal, params) => {
                const unpacked = params.deep_unpack();
                const iface = unpacked[0];
                const changed = unpacked[1];
                if (iface !== LOGIN1_IFACE || !changed || changed.LidClosed === undefined)
                    return;
                this._setClosed(Boolean(unpackMaybe(changed.LidClosed)));
            }));
        this._subs.push(Gio.DBus.system.signal_subscribe(
            LOGIN1,
            LOGIN1_IFACE,
            'PrepareForSleep',
            LOGIN1_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _iface, _signal, params) => {
                const [goingDown] = params.deep_unpack();
                if (!goingDown && this.onWake)
                    this.onWake();
            }));
    }

    _readClosed() {
        let closed = this._readProc();
        if (closed == null)
            closed = this._readLogin1();
        if (closed == null)
            return;
        this._setClosed(closed);
    }

    _readProc() {
        const root = Gio.File.new_for_path('/proc/acpi/button/lid');
        try {
            const enumerator = root.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            let result = null;
            while ((info = enumerator.next_file(null)) !== null) {
                try {
                    const child = root.get_child(info.get_name()).get_child('state');
                    const [, bytes] = child.load_contents(null);
                    const text = new TextDecoder().decode(bytes).toLowerCase();
                    if (text.includes('closed'))
                        result = true;
                    else if (text.includes('open'))
                        result = false;
                    if (result != null)
                        break;
                } catch {
                    // missing state file
                }
            }
            enumerator.close(null);
            return result;
        } catch {
            return null;
        }
    }

    _readLogin1() {
        try {
            const reply = Gio.DBus.system.call_sync(
                LOGIN1,
                LOGIN1_PATH,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', [LOGIN1_IFACE, 'LidClosed']),
                GLib.VariantType.new('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null);
            const [value] = reply.deep_unpack();
            return Boolean(unpackMaybe(value));
        } catch {
            return null;
        }
    }

    _setClosed(closed) {
        if (closed === this._closed)
            return;
        this._closed = closed;
        this.closed = closed;
        log(`LidFx: lid ${closed ? 'closed' : 'opened'}`);
        if (closed)
            this.onClosed?.();
        else
            this.onOpened?.();
    }
}
