#!/usr/bin/env python3
"""Stream laptop lid angle in degrees, one sample per line.

Most laptops have no dedicated hinge chip. This helper reads the display
accelerometer and maps gravity to 0–180° (closed → flat), then falls back
to dual accelerometers, IIO hinge channels, inclinometers, and HID lid-angle
feature reports.

Laptops with no IMU can still track the lid from the webcam: the camera
sits in the lid, so closing the lid tilts the view. Vertical image shift
is converted into a pitch delta. The camera is only opened on portable
chassis when requested, and never on desktops.
"""
from __future__ import annotations

import array
import fcntl
import json
import math
import os
import signal
import sys
import time
from pathlib import Path

IIO_ROOT = Path("/sys/bus/iio/devices")
HIDRAW_ROOT = Path("/sys/class/hidraw")
APPLE_VID = 0x05AC

_IOC_WRITE = 1 << 30
_IOC_READ = 2 << 30


def _ioc(direction, type_char, nr, size):
    return direction | (size << 16) | (ord(type_char) << 8) | nr


def hid_get_feature(length):
    return _ioc(_IOC_WRITE | _IOC_READ, "H", 0x07, length)


def read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None


def read_number(path):
    text = read_text(path)
    if text is None:
        return None
    try:
        return float(text.split()[0])
    except (TypeError, ValueError, IndexError):
        return None


def lid_is_open():
    root = Path("/proc/acpi/button/lid")
    if not root.is_dir():
        return True
    try:
        for state in root.glob("*/state"):
            text = state.read_text(encoding="utf-8", errors="replace").lower()
            if "closed" in text:
                return False
            if "open" in text:
                return True
    except OSError:
        return True
    return True


def clamp(value, lo, hi):
    return lo if value < lo else hi if value > hi else value


def angle_from_yz(ay, az):
    """Display IMU mapping: screen Y up the panel, Z out of the panel."""
    deg = math.degrees(math.atan2(-az, -ay)) + 90.0
    return clamp(deg, 0.0, 180.0)


def vector_ok(ax, ay, az, g=9.80665):
    mag = math.sqrt(ax * ax + ay * ay + az * az)
    return 0.35 * g <= mag <= 2.6 * g


def apply_mount_matrix(ax, ay, az, matrix):
    if not matrix:
        return ax, ay, az
    x = matrix[0][0] * ax + matrix[0][1] * ay + matrix[0][2] * az
    y = matrix[1][0] * ax + matrix[1][1] * ay + matrix[1][2] * az
    z = matrix[2][0] * ax + matrix[2][1] * ay + matrix[2][2] * az
    return x, y, z


def parse_mount_matrix(text):
    if not text:
        return None
    try:
        rows = []
        for row in text.replace(",", " ").split(";"):
            nums = [float(part) for part in row.split() if part]
            if len(nums) == 3:
                rows.append(nums)
        if len(rows) == 3:
            return rows
    except ValueError:
        return None
    return None


# Screen-up (Y) and screen-out (Z) candidates. IIO mount matrices differ by OEM.
AXIS_MAPS = (
    ("y", "z"),
    ("y", "-z"),
    ("-y", "z"),
    ("-y", "-z"),
    ("z", "y"),
    ("z", "-y"),
    ("-z", "y"),
    ("-z", "-y"),
    ("x", "z"),
    ("x", "-z"),
    ("-x", "z"),
    ("-x", "-z"),
    ("z", "x"),
    ("z", "-x"),
    ("-z", "x"),
    ("-z", "-x"),
    ("x", "y"),
    ("x", "-y"),
    ("-x", "y"),
    ("-x", "-y"),
    ("y", "x"),
    ("y", "-x"),
    ("-y", "x"),
    ("-y", "-x"),
)


def pick_axis(name, ax, ay, az):
    if name == "x":
        return ax
    if name == "-x":
        return -ax
    if name == "y":
        return ay
    if name == "-y":
        return -ay
    if name == "z":
        return az
    if name == "-z":
        return -az
    return ay


def choose_accel_mapping(ax, ay, az, lid_open=True):
    best = None
    best_score = None
    for y_name, z_name in AXIS_MAPS:
        angle = angle_from_yz(pick_axis(y_name, ax, ay, az), pick_axis(z_name, ax, ay, az))
        if lid_open:
            if angle < 40:
                continue
            score = abs(angle - 100.0)
        else:
            if angle > 50:
                continue
            score = angle
        if best_score is None or score < best_score:
            best = (y_name, z_name)
            best_score = score
    if best:
        return best
    # Last resort: native Y/Z, even if the laptop is at an unusual angle.
    return ("y", "z")


def accel_angle(ax, ay, az, mapping):
    y_name, z_name = mapping
    return angle_from_yz(pick_axis(y_name, ax, ay, az), pick_axis(z_name, ax, ay, az))


def pitch_yz(ay, az):
    return math.degrees(math.atan2(-az, ay if ay != 0 else 1e-9))


def dual_hinge_angle(lid, base):
    lid_pitch = pitch_yz(lid[1], lid[2])
    base_pitch = pitch_yz(base[1], base[2])
    hinge = abs(lid_pitch - base_pitch)
    if hinge > 180:
        hinge = 360 - hinge
    return clamp(hinge, 0.0, 180.0)


class IioDevice:
    def __init__(self, base: Path):
        self.base = base
        self.name = (read_text(base / "name") or base.name).strip()
        self.label = (read_text(base / "label") or "").strip()
        self.location = (
            read_text(base / "location")
            or read_text(base / "in_accel_location")
            or ""
        ).strip().lower()

    @property
    def title(self):
        extra = self.label or self.location
        return f"{self.name} {extra}".strip() if extra else self.name

    def channel_files(self, prefix):
        files = []
        try:
            names = os.listdir(self.base)
        except OSError:
            return files
        for name in names:
            if not name.endswith("_raw") or not name.startswith(prefix):
                continue
            rest = name[len(prefix) : -len("_raw")]
            # in_anglvel is a gyroscope. Hinge channels are in_angl or in_angl0.
            if prefix == "in_angl" and rest not in ("",) and not rest.isdigit():
                continue
            files.append(name)
        files.sort()
        return files

    def _scale_offset(self, raw_name):
        stem = raw_name[: -len("_raw")]
        scale = (
            read_number(self.base / f"{stem}_scale")
            or read_number(self.base / f"{stem.rsplit('_', 1)[0]}_scale")
            or 1.0
        )
        offset = read_number(self.base / f"{stem}_offset") or 0.0
        return scale, offset

    def read_scaled(self, raw_name):
        raw = read_number(self.base / raw_name)
        if raw is None:
            return None
        scale, offset = self._scale_offset(raw_name)
        return (raw + offset) * scale

    def read_angle_channel(self):
        channels = self.channel_files("in_angl")
        if not channels:
            return None
        value = self.read_scaled(channels[0])
        if value is None:
            return None
        if 0 <= value <= 360:
            return value if value <= 180 else clamp(360 - value, 0.0, 180.0)
        return None

    def read_inclinometer(self):
        channels = self.channel_files("in_incli")
        if not channels:
            return None
        # Prefer Y (pitch) when present.
        preferred = [name for name in channels if "_y_" in name] or channels
        value = self.read_scaled(preferred[0])
        if value is None:
            return None
        return clamp(180.0 - abs(value), 0.0, 180.0)

    def read_accel(self):
        needed = ("in_accel_x_raw", "in_accel_y_raw", "in_accel_z_raw")
        if not all((self.base / name).is_file() for name in needed):
            return None
        ax = self.read_scaled("in_accel_x_raw")
        ay = self.read_scaled("in_accel_y_raw")
        az = self.read_scaled("in_accel_z_raw")
        if ax is None or ay is None or az is None:
            return None
        matrix = parse_mount_matrix(
            read_text(self.base / "in_accel_mount_matrix")
            or read_text(self.base / "in_mount_matrix")
        )
        ax, ay, az = apply_mount_matrix(ax, ay, az, matrix)
        if not vector_ok(ax, ay, az):
            return None
        return (ax, ay, az)

    def looks_like_hinge(self):
        blob = f"{self.name} {self.label} {self.location}".lower()
        return any(token in blob for token in ("lid", "hinge", "cros-ec-lid-angle"))

    def looks_like_lid_accel(self):
        blob = f"{self.name} {self.label} {self.location}".lower()
        return any(token in blob for token in ("lid", "display", "screen", "panel"))

    def looks_like_base_accel(self):
        blob = f"{self.name} {self.label} {self.location}".lower()
        return any(token in blob for token in ("base", "kbd", "keyboard", "chassis"))


def list_iio():
    if not IIO_ROOT.is_dir():
        return []
    try:
        names = sorted(os.listdir(IIO_ROOT))
    except OSError:
        return []
    return [IioDevice(IIO_ROOT / name) for name in names if name.startswith("iio:device")]


def hid_uevent(node):
    return read_text(HIDRAW_ROOT / node / "device/uevent") or ""


def hid_vendor(uevent):
    for line in uevent.splitlines():
        if line.startswith("HID_ID="):
            parts = line.split("=")[1].split(":")
            if len(parts) >= 2:
                try:
                    return int(parts[1], 16)
                except ValueError:
                    return 0
    return 0


def hid_name(uevent):
    for line in uevent.splitlines():
        if line.startswith("HID_NAME="):
            return line.split("=", 1)[1]
    return "hidraw"


def hid_descriptor_has_sensor(node):
    path = HIDRAW_ROOT / node / "device/report_descriptor"
    try:
        data = path.read_bytes()
    except OSError:
        return False
    if b"\x05\x20" not in data:
        return False
    return (b"\x09\x8a" in data) or (b"\x09\xe4" in data) or (b"\x0a\xe1\x05" in data)


def hid_read_angle(fd, precise=False):
    buf = array.array("B", [7 if precise else 1] + [0] * 7)
    try:
        fcntl.ioctl(fd, hid_get_feature(len(buf)), buf)
    except OSError:
        return None
    if precise:
        raw = buf[1] | (buf[2] << 8) | (buf[3] << 16) | (buf[4] << 24)
        angle = raw / 100.0
    else:
        angle = float(buf[1] | (buf[2] << 8))
    if 0 <= angle <= 180:
        return angle
    return None


def open_hid_angle(dev_node):
    try:
        fd = os.open(dev_node, os.O_RDWR)
    except OSError:
        try:
            fd = os.open(dev_node, os.O_RDONLY)
        except OSError:
            return None, False
    for precise in (True, False):
        angle = hid_read_angle(fd, precise=precise)
        if angle is not None:
            return fd, precise
    os.close(fd)
    return None, False


CAMERA_VFOV = 50.0
CAMERA_WIDTH = 160
CAMERA_HEIGHT = 120
PORTABLE_CHASSIS = {8, 9, 10, 11, 14, 30, 31, 32}


def chassis_type():
    text = read_text("/sys/class/dmi/id/chassis_type")
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def is_portable_chassis(value=None):
    if value is None:
        value = chassis_type()
    if value is None:
        return True
    return value in PORTABLE_CHASSIS


def iter_capture_nodes():
    root = Path("/sys/class/video4linux")
    if not root.is_dir():
        return []
    nodes = []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    skip = ("metadata", "infrared", "ir camera", "dummy", "isp")
    for name in names:
        if not name.startswith("video"):
            continue
        title = (read_text(root / name / "name") or "").lower()
        if any(token in title for token in skip):
            continue
        nodes.append((f"/dev/{name}", title))
    return nodes


def camera_device_present():
    return bool(iter_capture_nodes()) or os.path.exists("/dev/video0")


def camera_suitable():
    return is_portable_chassis() and camera_device_present()


def vertical_shift(prev, curr, max_shift=14):
    """Pixels the image content moved down (positive) or up (negative)."""
    import numpy as np

    if prev.shape != curr.shape:
        return 0.0
    if float(prev.std()) < 4.0 or float(curr.std()) < 4.0:
        return 0.0
    height = prev.shape[0]
    prev_i = prev.astype(np.int16)
    curr_i = curr.astype(np.int16)
    zero_err = float(np.mean(np.abs(curr_i - prev_i)))
    best_dy = 0
    best_err = zero_err
    for dy in range(-max_shift, max_shift + 1):
        if dy == 0:
            continue
        if dy >= 0:
            err = float(np.mean(np.abs(curr_i[dy:] - prev_i[: height - dy])))
        else:
            err = float(np.mean(np.abs(curr_i[: height + dy] - prev_i[-dy:])))
        if err < best_err * 0.92 and err < best_err - 0.4:
            best_err = err
            best_dy = dy
    return float(best_dy)


def lid_delta_from_shift(dy, height, vfov=CAMERA_VFOV):
    """Content moving down means the camera looks up, so the lid opens."""
    if height <= 0:
        return 0.0
    return (dy / height) * vfov


class CameraLidSource:
    def __init__(self, baseline=100.0, invert=False):
        self.angle = clamp(baseline, 25.0, 180.0)
        self.baseline = self.angle
        self.sign = -1.0 if invert else 1.0
        self.prev = None
        self._pipeline = None
        self._sink = None
        self._failures = 0
        if not self._start():
            raise RuntimeError("webcam unavailable")

    def _start(self):
        try:
            import gi
            import numpy as np

            gi.require_version("Gst", "1.0")
            from gi.repository import Gst
        except (ImportError, ValueError):
            return False
        Gst.init(None)
        pipelines = []
        nodes = iter_capture_nodes() or [("/dev/video0", "")]
        sink = (
            f"videoconvert ! videoscale ! video/x-raw,format=GRAY8,"
            f"width={CAMERA_WIDTH},height={CAMERA_HEIGHT} ! "
            "appsink name=sink max-buffers=1 drop=true sync=false"
        )
        for device, _title in nodes[:2]:
            pipelines.append(f"v4l2src device={device} ! {sink}")
            pipelines.append(f"v4l2src device={device} ! image/jpeg ! jpegdec ! {sink}")
        pipelines.append(f"pipewiresrc ! {sink}")
        for desc in pipelines:
            try:
                pipeline = Gst.parse_launch(desc)
            except Exception:
                continue
            sink_el = pipeline.get_by_name("sink")
            pipeline.set_state(Gst.State.PLAYING)
            ok, _state, _pending = pipeline.get_state(int(0.8 * Gst.SECOND))
            if ok == Gst.StateChangeReturn.FAILURE or sink_el is None:
                pipeline.set_state(Gst.State.NULL)
                continue
            self._pipeline = pipeline
            self._sink = sink_el
            self._Gst = Gst
            self._np = np
            return True
        return False

    def _grab(self):
        if self._sink is None:
            return None
        sample = self._sink.emit("try-pull-sample", int(0.15 * self._Gst.SECOND))
        if sample is None:
            return None
        buf = sample.get_buffer()
        caps = sample.get_caps().get_structure(0)
        width = int(caps.get_value("width"))
        height = int(caps.get_value("height"))
        success, mapped = buf.map(self._Gst.MapFlags.READ)
        if not success:
            return None
        try:
            data = self._np.frombuffer(mapped.data, dtype=self._np.uint8)
            if data.size < width * height:
                return None
            frame = data[: width * height].reshape((height, width)).copy()
        except ValueError:
            return None
        finally:
            buf.unmap(mapped)
        return frame

    def read(self):
        frame = self._grab()
        if frame is None:
            self._failures += 1
            if self._failures >= 20:
                return None
            return self.angle
        self._failures = 0
        if not lid_is_open():
            self.angle = clamp(min(self.angle, 16.0), 8.0, 180.0)
            self.prev = frame
            return self.angle
        if self.prev is None:
            self.prev = frame
            return self.angle
        if float(frame.std()) < 4.0:
            # Nearly black / closed against the body.
            if float(frame.mean()) < 22.0:
                self.angle = clamp(self.angle - 3.0, 8.0, 180.0)
            self.prev = frame
            return self.angle
        dy = vertical_shift(self.prev, frame)
        delta = lid_delta_from_shift(dy, frame.shape[0]) * self.sign
        delta = clamp(delta, -6.0, 6.0)
        self.angle = clamp(self.angle + delta, 8.0, 180.0)
        if float(frame.mean()) < 18.0:
            self.angle = clamp(self.angle - 2.0, 8.0, 180.0)
        self.prev = frame
        return self.angle

    def close(self):
        if self._pipeline is not None:
            self._pipeline.set_state(self._Gst.State.NULL)
            self._pipeline = None
            self._sink = None


class Source:
    def __init__(self, kind, label, reader, closer=None):
        self.kind = kind
        self.label = label
        self.reader = reader
        self.closer = closer

    def read(self):
        return self.reader()

    def close(self):
        if self.closer:
            try:
                self.closer()
            except Exception:
                pass


def discover_sources(use_camera=False, baseline=100.0, camera_invert=False):
    sources = []
    iio = list_iio()

    for device in iio:
        channels = device.channel_files("in_angl")
        if not channels:
            continue
        sample = device.read_angle_channel()
        if sample is None and not device.looks_like_hinge():
            continue
        sources.append(
            Source(
                "iio-hinge",
                f"Lid sensor ({device.title})",
                device.read_angle_channel,
            )
        )

    accels = []
    for device in iio:
        sample = device.read_accel()
        if sample is None:
            continue
        accels.append((device, sample))

    lid_accels = [(d, s) for d, s in accels if d.looks_like_lid_accel()]
    base_accels = [(d, s) for d, s in accels if d.looks_like_base_accel()]
    if lid_accels and base_accels:
        lid_dev, _ = lid_accels[0]
        base_dev, _ = base_accels[0]

        def dual_reader(lid=lid_dev, base=base_dev):
            lid_vec = lid.read_accel()
            base_vec = base.read_accel()
            if lid_vec is None or base_vec is None:
                return None
            return dual_hinge_angle(lid_vec, base_vec)

        sources.append(
            Source(
                "dual-accel",
                f"Dual accelerometer ({lid_dev.title} / {base_dev.title})",
                dual_reader,
            )
        )
    elif len(accels) >= 2 and not (lid_accels and base_accels):
        first, _ = accels[0]
        second, _ = accels[1]

        def dual_reader(lid=first, base=second):
            lid_vec = lid.read_accel()
            base_vec = base.read_accel()
            if lid_vec is None or base_vec is None:
                return None
            return dual_hinge_angle(lid_vec, base_vec)

        if dual_reader() is not None:
            hinge = dual_reader()
            if hinge is not None and 25.0 <= hinge <= 165.0:
                sources.append(
                    Source(
                        "dual-accel",
                        f"Dual accelerometer ({first.title} / {second.title})",
                        dual_reader,
                    )
                )

    if accels:
        device, sample = accels[0]
        if lid_accels:
            device, sample = lid_accels[0]
        mapping = choose_accel_mapping(*sample, lid_open=lid_is_open())

        def accel_reader(dev=device, axes=mapping):
            vec = dev.read_accel()
            if vec is None:
                return None
            return accel_angle(*vec, axes)

        sources.append(
            Source(
                "accel",
                f"Display accelerometer ({device.title}, {mapping[0]}/{mapping[1]})",
                accel_reader,
            )
        )

    for device in iio:
        if not device.channel_files("in_incli"):
            continue
        sample = device.read_inclinometer()
        if sample is None:
            continue

        sources.append(
            Source("inclinometer", f"Inclinometer ({device.title})", device.read_inclinometer)
        )

    hid_nodes = []
    if HIDRAW_ROOT.is_dir():
        try:
            hid_nodes = sorted(os.listdir(HIDRAW_ROOT))
        except OSError:
            hid_nodes = []
    for node in hid_nodes:
        uevent = hid_uevent(node)
        apple = hid_vendor(uevent) == APPLE_VID
        sensor = hid_descriptor_has_sensor(node)
        if not apple and not sensor:
            continue
        dev_node = f"/dev/{node}"
        fd, precise = open_hid_angle(dev_node)
        if fd is None:
            continue

        def hid_reader(handle=fd, use_precise=precise):
            return hid_read_angle(handle, precise=use_precise)

        def hid_close(handle=fd):
            try:
                os.close(handle)
            except OSError:
                pass

        label = "Apple lid angle sensor" if apple else f"HID lid sensor ({hid_name(uevent)})"
        sources.append(Source("hid", label, hid_reader, hid_close))

    if use_camera and not sources and camera_suitable():
        try:
            camera = CameraLidSource(baseline=baseline, invert=camera_invert)
            sources.append(
                Source(
                    "camera",
                    "Webcam lid estimate (camera on while Hinge is on)",
                    camera.read,
                    camera.close,
                )
            )
        except Exception as exc:
            sys.stderr.write(f"Hinge: camera unavailable: {exc}\n")

    return sources


def pick_source(sources):
    order = ("iio-hinge", "hid", "dual-accel", "accel", "inclinometer", "camera")
    ranked = sorted(sources, key=lambda item: order.index(item.kind) if item.kind in order else 99)
    for source in ranked:
        value = source.read()
        if value is not None:
            return source, value
    return (ranked[0], None) if ranked else (None, None)


def emit_meta(source):
    payload = {
        "source": source.kind,
        "label": source.label,
    }
    sys.stdout.write(f"# {json.dumps(payload, separators=(',', ':'))}\n")
    sys.stdout.flush()


def emit_angle(value):
    sys.stdout.write(f"{value:.2f}\n")
    sys.stdout.flush()


def scan_json(use_camera=False, baseline=100.0, camera_invert=False):
    sources = discover_sources(
        use_camera=use_camera, baseline=baseline, camera_invert=camera_invert
    )
    chosen, value = pick_source(sources)
    for item in sources:
        item.close()
    devices = [{"source": item.kind, "label": item.label} for item in sources]
    available = chosen is not None and (value is not None or chosen.kind == "camera")
    if not available and camera_suitable():
        result = {
            "available": True,
            "source": "camera",
            "label": "Webcam lid estimate (used while Hinge is on)",
            "angle": None,
            "devices": devices,
            "lid_open": lid_is_open(),
        }
    else:
        result = {
            "available": available,
            "source": chosen.kind if chosen else "none",
            "label": chosen.label if chosen else "No lid sensor",
            "angle": None if value is None else round(value, 2),
            "devices": devices,
            "lid_open": lid_is_open(),
        }
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


def stream(source, interval):
    try:
        emit_meta(source)
    except BrokenPipeError:
        source.close()
        return
    failures = 0
    last = None
    try:
        while True:
            try:
                value = source.read()
            except (OSError, BrokenPipeError):
                value = None
            if value is None:
                failures += 1
                if failures >= 12:
                    break
            else:
                failures = 0
                if last is None or abs(value - last) >= 0.05:
                    try:
                        emit_angle(value)
                    except BrokenPipeError:
                        break
                    last = value
            time.sleep(interval)
    finally:
        source.close()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    use_camera = "--camera" in argv
    camera_invert = "--camera-invert" in argv
    baseline = 100.0
    if "--baseline" in argv:
        index = argv.index("--baseline")
        if index + 1 < len(argv):
            try:
                baseline = float(argv[index + 1])
            except ValueError:
                baseline = 100.0

    if "--scan" in argv:
        scan_json(use_camera=False, baseline=baseline, camera_invert=camera_invert)
        return 0

    interval = 1 / 120
    if "--slow" in argv:
        interval = 0.1
        argv.remove("--slow")
        use_camera = False
    if use_camera:
        interval = 1 / 30

    running = []

    def _stop(_signum=None, _frame=None):
        for item in running:
            item.close()
        raise SystemExit(0)

    try:
        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)
    except (ValueError, OSError):
        pass

    # Legacy: python3 sensor-helper.py /dev/hidrawN
    if argv and argv[0].startswith("/dev/hidraw"):
        fd, precise = open_hid_angle(argv[0])
        if fd is None:
            return 1

        def hid_reader(handle=fd, use_precise=precise):
            return hid_read_angle(handle, precise=use_precise)

        def hid_close(handle=fd):
            try:
                os.close(handle)
            except OSError:
                pass

        source = Source("hid", "HID lid angle sensor", hid_reader, hid_close)
        running.append(source)
        stream(source, interval)
        return 0

    sources = discover_sources(
        use_camera=use_camera, baseline=baseline, camera_invert=camera_invert
    )
    source, value = pick_source(sources)
    for item in sources:
        if item is not source:
            item.close()
    if source is None or (value is None and source.kind != "camera"):
        sys.stdout.write("# {\"source\":\"none\",\"label\":\"No lid sensor\"}\n")
        sys.stdout.flush()
        return 1
    running.append(source)
    stream(source, interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
