import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const IIO_ROOT = '/sys/bus/iio/devices';
const AXIS_MAPS = [
    ['y', 'z'], ['y', '-z'], ['-y', 'z'], ['-y', '-z'],
    ['z', 'y'], ['z', '-y'], ['-z', 'y'], ['-z', '-y'],
    ['x', 'z'], ['x', '-z'], ['-x', 'z'], ['-x', '-z'],
    ['z', 'x'], ['z', '-x'], ['-z', 'x'], ['-z', '-x'],
    ['x', 'y'], ['x', '-y'], ['-x', 'y'], ['-x', '-y'],
    ['y', 'x'], ['y', '-x'], ['-y', 'x'], ['-y', '-x'],
];

function readText(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [, bytes] = file.load_contents(null);
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return null;
    }
}

function listDir(path) {
    try {
        const dir = Gio.File.new_for_path(path);
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const names = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null)
            names.push(info.get_name());
        enumerator.close(null);
        return names;
    } catch {
        return [];
    }
}

function parseNumber(text) {
    if (text == null)
        return null;
    const value = Number(text.split(/\s+/)[0]);
    return Number.isFinite(value) ? value : null;
}

function clamp(value, lo, hi) {
    return Math.min(Math.max(value, lo), hi);
}

export function angleFromYZ(ay, az) {
    return clamp(Math.atan2(-az, -ay) * (180 / Math.PI) + 90, 0, 180);
}

function pickAxis(name, ax, ay, az) {
    switch (name) {
    case 'x': return ax;
    case '-x': return -ax;
    case 'y': return ay;
    case '-y': return -ay;
    case 'z': return az;
    case '-z': return -az;
    default: return ay;
    }
}

function vectorOk(ax, ay, az) {
    const mag = Math.hypot(ax, ay, az);
    return mag >= 0.35 * 9.80665 && mag <= 2.6 * 9.80665;
}

export function chooseAccelMapping(ax, ay, az, lidOpen = true) {
    let best = ['y', 'z'];
    let bestScore = Infinity;
    for (const [yName, zName] of AXIS_MAPS) {
        const angle = angleFromYZ(pickAxis(yName, ax, ay, az), pickAxis(zName, ax, ay, az));
        if (lidOpen && angle < 40)
            continue;
        if (!lidOpen && angle > 50)
            continue;
        const score = lidOpen ? Math.abs(angle - 100) : angle;
        if (score < bestScore) {
            best = [yName, zName];
            bestScore = score;
        }
    }
    return best;
}

function readScaled(base, rawFile) {
    const raw = parseNumber(readText(`${base}/${rawFile}`));
    if (raw == null)
        return null;
    const stem = rawFile.replace(/_raw$/, '');
    const family = stem.replace(/_[xyz0-9]+$/, '');
    const scale = parseNumber(readText(`${base}/${stem}_scale`))
        ?? parseNumber(readText(`${base}/${family}_scale`))
        ?? 1;
    const offset = parseNumber(readText(`${base}/${stem}_offset`)) ?? 0;
    return (raw + offset) * scale;
}

export class LidSensor {
    constructor() {
        this.angle = null;
        this.source = 'pending';
        this.label = 'Looking for a lid sensor…';
        this.onAngle = null;
        this._tracking = false;
        this._timeoutId = 0;
        this._iio = null;
        this._helper = null;
        this._helperOut = null;
        this._extensionPath = null;
        this._scanGeneration = 0;
        this._helperGen = 0;
        this._useCamera = true;
        this._baseline = 100;
        this._cameraInvert = false;
    }

    get available() {
        return this.source !== 'none' && this.source !== 'pending';
    }

    setTracking(active) {
        this._tracking = active;
        this._armTimer();
    }

    setCameraOptions({enabled = true, baseline = 100, invert = false} = {}) {
        this._useCamera = enabled;
        this._baseline = baseline;
        this._cameraInvert = invert;
    }

    reconnect() {
        this._stopHelper();
        this._iio = null;
        this.source = 'pending';
        this.label = 'Looking for a lid sensor…';
        this._scan();
        this._armTimer();
        this._sample();
    }

    stop() {
        this._armTimer(true);
        this._stopHelper();
        this.angle = null;
        this.source = 'none';
        this._emit(null);
    }

    setExtensionPath(path) {
        this._extensionPath = path;
    }

    _armTimer(forceOff = false) {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (forceOff || !this._iio)
            return;
        const ms = this._tracking ? 8 : 100;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _emit(value) {
        this.angle = value;
        if (this.onAngle)
            this.onAngle(value);
    }

    _scan() {
        const generation = ++this._scanGeneration;
        if (this._startAutoHelper())
            return;
        if (this._scanIioLidAngle() || this._scanIioAccel()) {
            this._armTimer();
            return;
        }
        if (generation !== this._scanGeneration)
            return;
        this.source = 'none';
        this.label = 'No lid sensor';
    }

    _helperPath() {
        if (!this._extensionPath)
            return null;
        const helper = GLib.build_filenamev([this._extensionPath, 'sensor-helper.py']);
        return GLib.file_test(helper, GLib.FileTest.IS_REGULAR) ? helper : null;
    }

    _startAutoHelper() {
        const helper = this._helperPath();
        if (!helper)
            return false;
        this._stopHelper();
        try {
            const args = ['python3', '-u', helper];
            if (!this._tracking)
                args.push('--slow');
            else if (this._useCamera) {
                args.push('--camera', '--baseline', String(this._baseline));
                if (this._cameraInvert)
                    args.push('--camera-invert');
            }
            const proc = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const gen = ++this._helperGen;
            this._helper = proc;
            this._helperOut = new Gio.DataInputStream({
                base_stream: proc.get_stdout_pipe(),
                close_base_stream: true,
            });
            this._readHelper(gen);
            return true;
        } catch {
            this._helper = null;
            this._helperOut = null;
            return false;
        }
    }

    _readHelper(gen) {
        if (!this._helperOut || gen !== this._helperGen)
            return;
        this._helperOut.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            if (gen !== this._helperGen)
                return;
            try {
                const [line] = stream.read_line_finish(res);
                if (line == null) {
                    this._stopHelper();
                    if (this.source === 'pending' || this.source === 'hid' ||
                        this.source === 'accel' || this.source === 'dual-accel' ||
                        this.source === 'iio-lid' || this.source === 'intel-lid' || this.source === 'inclinometer' ||
                        this.source === 'camera' || this.source === 'helper') {
                        if (!this._scanIioLidAngle() && !this._scanIioAccel()) {
                            this.source = 'none';
                            this.label = 'No lid sensor';
                            this._emit(null);
                        } else {
                            this._armTimer();
                            this._sample();
                        }
                    }
                    return;
                }
                const text = new TextDecoder().decode(line).trim();
                if (text.startsWith('#')) {
                    this._applyMeta(text.slice(1).trim());
                    this._readHelper(gen);
                    return;
                }
                const value = parseNumber(text);
                if (value != null && value >= 0 && value <= 180) {
                    if (this.source === 'pending') {
                        this.source = 'helper';
                        this.label = 'Lid sensor';
                    }
                    this._emit(value);
                }
                this._readHelper(gen);
            } catch {
                if (gen === this._helperGen)
                    this._stopHelper();
            }
        });
    }

    _applyMeta(text) {
        if (!text)
            return;
        if (text.startsWith('{')) {
            try {
                const meta = JSON.parse(text);
                if (meta.source === 'none') {
                    this.source = 'none';
                    this.label = meta.label || 'No lid sensor';
                    this._emit(null);
                    return;
                }
                if (meta.source)
                    this.source = meta.source;
                if (meta.label)
                    this.label = meta.label;
                return;
            } catch {
                // fall through to key=value
            }
        }
        const source = text.match(/source=([^\s]+)/);
        const label = text.match(/label=(.+)$/);
        if (source)
            this.source = source[1];
        if (label)
            this.label = label[1];
    }

    _stopHelper() {
        this._helperGen++;
        if (this._helper) {
            try {
                this._helper.send_signal(15);
            } catch {
                // already gone
            }
            try {
                this._helper.force_exit();
            } catch {
                // Gio version without force_exit, or already gone
            }
            this._helper = null;
        }
        this._helperOut = null;
    }

    _scanIioLidAngle() {
        for (const name of listDir(IIO_ROOT)) {
            if (!name.startsWith('iio:device'))
                continue;
            const base = `${IIO_ROOT}/${name}`;
            const deviceName = (readText(`${base}/name`) || '').toLowerCase();
            const label = (readText(`${base}/label`) || '').toLowerCase();
            const isLid = deviceName.includes('lid') || deviceName.includes('cros-ec-lid-angle') ||
                deviceName.includes('hid-sensor-custom-intel-hin') ||
                label.includes('lid');
            const channels = [];
            for (const file of listDir(base)) {
                if (/^in_angl(?:[0-9]+)?_raw$/.test(file))
                    channels.push(file);
            }
            if (!channels.length)
                continue;
            if (!isLid && !(deviceName.includes('angl') && !deviceName.includes('anglvel')))
                continue;
            channels.sort();
            const rawFile = channels[0];
            const scale = parseNumber(readText(`${base}/${rawFile.replace(/_raw$/, '_scale')}`)) ?? 1;
            const offset = parseNumber(readText(`${base}/${rawFile.replace(/_raw$/, '_offset')}`)) ?? 0;
            const raw = parseNumber(readText(`${base}/${rawFile}`));
            if (raw == null)
                continue;
            const angle = (raw + offset) * scale;
            if (angle < 0 || angle > 360)
                continue;
            this._iio = {kind: 'angle', base, rawFile, scale, offset};
            this.source = deviceName.includes('intel') ? 'intel-lid' : 'iio-lid';
            this.label = `Lid sensor (${deviceName || name})`;
            return true;
        }
        return false;
    }

    _scanIioAccel() {
        for (const name of listDir(IIO_ROOT)) {
            if (!name.startsWith('iio:device'))
                continue;
            const base = `${IIO_ROOT}/${name}`;
            const deviceName = (readText(`${base}/name`) || name).trim();
            const ax = readScaled(base, 'in_accel_x_raw');
            const ay = readScaled(base, 'in_accel_y_raw');
            const az = readScaled(base, 'in_accel_z_raw');
            if (ax == null || ay == null || az == null || !vectorOk(ax, ay, az))
                continue;
            const mapping = chooseAccelMapping(ax, ay, az, true);
            this._iio = {kind: 'accel', base, mapping};
            this.source = 'accel';
            this.label = `Display accelerometer (${deviceName}, ${mapping[0]}/${mapping[1]})`;
            return true;
        }
        return false;
    }

    _sample() {
        if (!this._iio)
            return;
        if (this._iio.kind === 'angle') {
            const raw = parseNumber(readText(`${this._iio.base}/${this._iio.rawFile}`));
            if (raw == null) {
                this._emit(null);
                return;
            }
            let angle = (raw + this._iio.offset) * this._iio.scale;
            if (angle > 180 && angle <= 360)
                angle = 360 - angle;
            this._emit(angle >= 0 && angle <= 180 ? angle : null);
            return;
        }
        if (this._iio.kind === 'accel') {
            const ax = readScaled(this._iio.base, 'in_accel_x_raw');
            const ay = readScaled(this._iio.base, 'in_accel_y_raw');
            const az = readScaled(this._iio.base, 'in_accel_z_raw');
            if (ax == null || ay == null || az == null || !vectorOk(ax, ay, az)) {
                this._emit(null);
                return;
            }
            const [yName, zName] = this._iio.mapping;
            this._emit(angleFromYZ(pickAxis(yName, ax, ay, az), pickAxis(zName, ax, ay, az)));
        }
    }
}
