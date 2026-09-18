#!/usr/bin/env python3
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "sensor_helper", ROOT / "extension" / "sensor-helper.py"
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def near(value, expected, slack=1.5):
    if abs(value - expected) > slack:
        raise SystemExit(f"expected {expected}±{slack}, got {value}")


def test_windows_mapping():
    # Closed, upright, and flat — same gravity cases as hinge-windows.
    near(helper.angle_from_yz(0.0, 1.0), 0.0)
    near(helper.angle_from_yz(-0.94, -0.10), 96.1)
    near(helper.angle_from_yz(0.0, -1.0), 180.0)


def test_axis_picker_prefers_viewing_angle():
    mapping = helper.choose_accel_mapping(0.0, -0.94, -0.10, lid_open=True)
    angle = helper.accel_angle(0.0, -0.94, -0.10, mapping)
    if not 70 <= angle <= 130:
        raise SystemExit(f"open-lid mapping {mapping} produced {angle}")


def test_dual_hinge():
    # Lid upright, base flat on a desk.
    lid = (0.0, -0.94, -0.10)
    base = (0.0, 0.0, -1.0)
    angle = helper.dual_hinge_angle(lid, base)
    if not 70 <= angle <= 120:
        raise SystemExit(f"dual hinge expected ~90°, got {angle}")


def test_vertical_shift_content_down():
    import numpy as np

    prev = np.zeros((40, 60), dtype=np.uint8)
    prev[8:16, :] = 200
    curr = np.zeros((40, 60), dtype=np.uint8)
    curr[12:20, :] = 200
    dy = helper.vertical_shift(prev, curr)
    if abs(dy - 4) > 1:
        raise SystemExit(f"expected downward shift ~4, got {dy}")
    delta = helper.lid_delta_from_shift(dy, 40, vfov=50)
    if delta <= 0:
        raise SystemExit(f"opening lid should increase angle, got {delta}")


def test_vertical_shift_still_frame():
    import numpy as np

    frame = np.full((40, 60), 80, dtype=np.uint8)
    if helper.vertical_shift(frame, frame) != 0:
        raise SystemExit("still frame should report no shift")


def test_portable_chassis():
    if helper.is_portable_chassis(3):
        raise SystemExit("desktop chassis must not use the webcam lid fallback")
    if not helper.is_portable_chassis(10):
        raise SystemExit("notebook chassis should allow the webcam lid fallback")
    if not helper.is_portable_chassis(31):
        raise SystemExit("convertible chassis should allow the webcam lid fallback")
    if not helper.is_portable_chassis(None):
        raise SystemExit("unknown chassis should stay permissive")


def test_dual_unlabeled_rejected_when_parallel():
    lid = (0.0, 0.0, -1.0)
    base = (0.0, 0.0, -1.0)
    angle = helper.dual_hinge_angle(lid, base)
    if angle >= 25:
        raise SystemExit(f"parallel accels should not look like an open hinge, got {angle}")


if __name__ == "__main__":
    test_windows_mapping()
    test_axis_picker_prefers_viewing_angle()
    test_dual_hinge()
    test_vertical_shift_content_down()
    test_vertical_shift_still_frame()
    test_portable_chassis()
    test_dual_unlabeled_rejected_when_parallel()
    print("ok sensor-helper")
