# Hinge

**GNOME Shell extension** that folds and blurs your **Linux desktop** as you close the **laptop lid**.

Close the lid a little. The live wallpaper and windows follow the hinge. Open it, and everything comes back. Clicks still land on the real layout underneath.

Hinge is a Mutter compositor effect for **GNOME Wayland** — not a screen-capture overlay. It reads a lid-angle sensor, dual accelerometers, display IMU, Apple HID hinge, or the lid webcam, with a lid-switch fallback. Built for **GNOME Shell 45–48**; Ubuntu 24.04 is the development target.

[![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-45--48-4A86CF?logo=gnome&logoColor=white)](https://github.com/agayushh/hinge)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04-E95420?logo=ubuntu&logoColor=white)](https://github.com/agayushh/hinge)
[![Wayland](https://img.shields.io/badge/Wayland-compositor_effect-222)](https://github.com/agayushh/hinge)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Features

- **Live fold and blur** on the already-composited wallpaper and windows
- **Hardware lid angle** from IIO hinge, dual IMU, display accelerometer, HID, or inclinometer
- **Webcam fallback** on clamshells with no IMU (camera LED stays on while Hinge is on)
- **Lid-switch fallback** so close-to-sleep can still play the fold
- **Panel and Ubuntu Dock stay put**; fullscreen games are brought back under the compositor while the fold is visible
- **Fold slider, demo, and Ctrl+Alt+H** when you want to drive it by hand
- **No extra window, no screen capture** — a GNOME Shell effect, so input hits the real layout

## Install

GNOME Shell 45–48 (Ubuntu 24.04 with GNOME 46 is the development target). You do not need to clone this repository.

### GNOME extension zip

Download [`hinge.shell-extension.zip`](https://github.com/agayushh/hinge/raw/main/website/downloads/hinge.shell-extension.zip) from this repo, then:

```sh
gnome-extensions install --force hinge.shell-extension.zip
gnome-extensions enable hinge@agayushh.github.io
```

Or in GNOME’s Extensions app: **Install from File…**

### Debian package (Ubuntu)

Download [`gnome-shell-extension-hinge_5_all.deb`](https://github.com/agayushh/hinge/raw/main/website/downloads/gnome-shell-extension-hinge_5_all.deb), then install from a terminal:

```sh
sudo apt install ./gnome-shell-extension-hinge_5_all.deb
gnome-extensions enable hinge@agayushh.github.io
```

The package also installs the HID udev rule. Ubuntu App Center will warn that this is a third-party package — that is expected for any `.deb` that is not in the Ubuntu archive. Prefer the terminal command, or the GNOME zip above.

### From source

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

### Lid angle sensors

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

The motion path uses a 0.6° noise band, 60 ms velocity smoothing, 35 ms look-ahead, and a critically damped second-order follow from 30–55 rad/s. Shader geometry lives in `extension/shaders/fold.glsl` (about 11.5% top inset, progressive blur toward the top, corner shading, side feathering). Motion notes: [`MOTION.md`](MOTION.md).

## Why a GNOME Shell extension?

A regular Linux app cannot fold other windows on GNOME Wayland without capturing the screen, and a capture overlay would film itself. A Shell effect paints the already-composited wallpaper and windows, then warps that image.

wlroots compositors (Hyprland, Sway, niri) are not wired up yet. The motion math and GLSL live in `extension/motion.js` and `extension/shaders/fold.glsl` if you want to reuse them.

## FAQ

**Does this work on Ubuntu 24.04 / GNOME 46?**  
Yes. GNOME Shell 45–48 is supported. Ubuntu 24.04 with GNOME 46 is the development target.

**Does it work on Wayland?**  
Yes. That is the point: Hinge is a GNOME Shell / Mutter compositor effect, so it can warp the live desktop without a capture overlay.

**Is this Bendy for Linux?**  
It is the same idea as the macOS lid-fold demos (Bendy, Expo Duo): the desktop appears to bend with the laptop hinge. The implementation is a GNOME Shell extension, not a port of those apps.

**Do I need a hinge sensor?**  
No. Hardware angle is preferred (IIO, dual IMU, HID). Laptops without an IMU can use the lid webcam. Any clamshell can use the lid switch, Fold slider, or Play demo.

**Will KDE, Hyprland, or Sway work?**  
Not yet. Those are not GNOME Shell. The fold shader and motion filter are reusable if you are writing a compositor effect elsewhere.

**Does closing the lid still sleep the laptop?**  
Yes. While Hinge is on, the lid switch can play the fold and then sleep as usual.

## Uninstall

User zip:

```sh
gnome-extensions uninstall hinge@agayushh.github.io
```

Debian package:

```sh
sudo apt remove gnome-shell-extension-hinge
```

From a source checkout: `make uninstall`.

## License

MIT. Copyright (c) 2026 Ayush Goyal. See [`LICENSE`](LICENSE).
