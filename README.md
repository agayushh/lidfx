# Hinge for Linux

Give your GNOME desktop a little bend. Close the lid and watch the screen softly fold and blur. Open it and everything comes back.

Give your GNOME desktop a little bend. Close the lid and watch the screen softly fold and blur. Open it and everything comes back.

Hinge is a GNOME Shell extension: the compositor itself applies the fold and blur to the live wallpaper and windows, so clicks still land on the real layout underneath. Source: [github.com/agayushh/hinge](https://github.com/agayushh/hinge).

## Install

GNOME Shell 45–48 (Ubuntu 24.04 with GNOME 46 is the development target).

```sh
git clone https://github.com/agayushh/hinge.git
cd hinge
make install
gnome-extensions enable hinge@agayushh.github.io
```

On Wayland, a first-time install may need a logout before the extension shows up. Then open the Hinge menu in the top bar and turn it **On**. Close the lid to fold, or drag **Fold** / **Play demo**.

If a HID lid sensor exists but is not readable, install the udev rule and replug / reboot:

```sh
sudo cp 99-hinge-lid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Settings live under **Hinge → Settings…** in that menu, or:

```sh
gnome-extensions prefs hinge@agayushh.github.io
```

Toggle from the keyboard with **Ctrl+Alt+H**.

To see what Linux is exposing on this machine:

```sh
make scan
```

## Using it

The default open position is 100°. **Set open position** stores a comfortable angle when a hardware sensor is present. **Reconnect sensor** repeats discovery after you load a driver or udev rule.

**Effect strength** scales the fold from 25% to 100%.

The panel and Ubuntu Dock stay put. Fullscreen games that unredirect the display are brought back under the compositor while the fold is visible.

### Lid angle

Hinge uses the first source that actually reports a live 0–180° angle:

| Source | What it is |
| --- | --- |
| IIO hinge | ChromeOS `cros-ec-lid-angle`, Intel HID hinge, and other `in_angl*` channels under `/sys/bus/iio/devices`. |
| Dual accelerometer | Convertibles with lid + base IMUs. The hinge is the angle between those two gravity vectors. |
| Display accelerometer | `atan2(-Z, -Y)` mapped so closed is 0°, a typical viewing pose is ~100°, and flat is 180°. Works when the base is on a desk. |
| HID lid angle | Apple HID (`VID 05AC`, usage page `0x20` / usage `0x8A`) and other HID sensor-page lid devices. A udev rule is in `99-hinge-lid.rules`. |
| Inclinometer | IIO `in_incli*` pitch, mapped the same way as the display IMU. |
| Webcam | No IMU. The lid camera's vertical view shift is converted to pitch. Camera LED on while Hinge is on. |
| Lid switch | Binary open/closed fallback. While Hinge is on, closing the lid can still play the fold and then sleep. |

The motion path uses a 0.6° noise band, 60 ms velocity smoothing, 35 ms look-ahead, and a critically damped second-order follow from 30–55 rad/s. Shader geometry lives in `extension/shaders/fold.glsl` (about 11.5% top inset, progressive blur toward the top, corner shading, side feathering).

## Uninstall

```sh
make uninstall
```

## Why an extension?

A regular app cannot fold other windows on GNOME Wayland without capturing the screen, and a capture overlay would film itself. A Shell effect paints the already-composited wallpaper and windows, then warps that image.

wlroots compositors are not wired up yet. The motion math and GLSL live in `extension/motion.js` and `extension/shaders/fold.glsl` if you want to reuse them.

## License

MIT. Copyright (c) 2026 Ayush Goyal. See `LICENSE`.
