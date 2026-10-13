# Camic User Guide

Use your phone's camera and mic as a wireless webcam and microphone for your computer over the same Wi-Fi.

## 1. One-time Linux setup

Your computer needs the **v4l2loopback** kernel module (creates the virtual webcam) and the firewall ports open. Run once:

```bash
sudo ./scripts/setup-linux-host.sh
```

This installs dependencies, builds/installs the module via DKMS, loads it (`/dev/video10` = "Camic Camera"), persists it across reboots, and opens TCP 4747 + UDP 4748. Verify with `v4l2-ctl --list-devices`.

## 2. Install & start the desktop app

**From a package** (preferred):

```bash
# Ubuntu / Debian
sudo apt install ./camic-1.0.0-amd64.deb

# Fedora
sudo dnf install ./camic-1.0.0.x86_64.rpm

# Any distro, no install
chmod +x Camic-1.0.0-x86_64.AppImage && ./Camic-1.0.0-x86_64.AppImage
```

Then launch **Camic** from your app menu (or `camic` in a terminal).

**From source:**

```bash
cd desktop
npm install     # first time
npm start
```

The app scans for phones on your Wi-Fi.

## 3. Install & open the phone app

- **Android:** install `mobile/build/app/outputs/flutter-apk/app-release.apk` (or build it — see `BUILD_ANDROID.md`). Open it, grant **Camera** and **Microphone**. It shows a **6-digit PIN** and "Ready to connect".
- **iOS:** build in Xcode on a Mac (see `BUILD_ANDROID.md` for the Flutter side). Grant camera/mic.

Keep the phone app open while streaming.

## 4. Connect

- **Auto:** your phone appears in the desktop app's device list — click **Connect**, enter the PIN.
- **Manual:** enter the phone's IP + PIN (the phone app shows it's waiting on port 4747).

Once connected, the desktop starts streaming and shows a live preview.

## 5. Use it as a webcam/mic

Camic appears as a real device:

- **Linux:** "Camic Camera" (webcam) + "Camic Mic" (microphone).
- **Windows:** same names, via the DirectShow filters (build/register first — see `BUILD_WINDOWS_DLL.md`).

Select them in Zoom / Teams / OBS / Chrome (`getUserMedia`) like any camera.

## Controls (desktop)

- **Resolution** — 480p / 720p / 1080p
- **Frame rate** — 15 / 24 / 30
- **Jitter buffer** — 1 (lowest latency) … 5 (rock solid)
- **Microphone** on/off
- **Flip camera**, **Torch**

Settings apply on the next connect.

## Troubleshooting

- **No device listed:** confirm phone + PC are on the same Wi-Fi; check the firewall ports (TCP 4747, UDP 4748); try manual IP connect.
- **Wrong PIN:** the PIN is shown on the phone screen. Re-open the app if it changed.
- **No virtual camera on Linux:** re-run `sudo scripts/setup-linux-host.sh` and check `v4l2-ctl --list-devices`.
- **High latency / stutter:** raise the jitter buffer; use 720p instead of 1080p; move closer to the router.
- **Audio not appearing:** ensure `pactl` is installed (`sudo dnf install pulseaudio-utils`); the mic is the "Camic Mic" sink.
