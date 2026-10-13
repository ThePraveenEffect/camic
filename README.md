# Camic

Turn your phone's **camera + microphone** into a wireless webcam and mic for your computer — over the same Wi-Fi. Your phone shows up as a **real system camera and microphone**, so Zoom / Teams / OBS / browsers use it natively.

| Desktop receiver | Android app |
|---|---|
| ![Camic desktop — live](docs/images/camic-desktop-live.png) | ![Camic Android](docs/images/camic-android.png) |

```
Phone (Android)  ──H.264 + AAC over Wi-Fi──►  PC (Linux / Windows)
 Camera2               UDP :4748 + TCP :4747      v4l2loopback / DirectShow
 MediaCodec            mDNS auto-discovery         "Camic Camera" + "camic_mic"
```

- **~60–120 ms** glass-to-glass latency on a clean LAN (hardware encode on the phone).
- **Auto-discovery** via mDNS, plus a **6-digit pairing PIN** so neighbours can't connect.
- Real virtual devices: **v4l2loopback + PipeWire** on Linux, **DirectShow** on Windows.

---

## Install

Prebuilt packages live in [`dist/`](dist/). Checksums are in [`dist/SHA256SUMS`](dist/SHA256SUMS).

### Ubuntu / Debian — `.deb`

```bash
# one-time: fetch our APT repository key (see docs/PUBLISHING.md for how this repo is hosted)
curl -fsSL https://YOUR-APT-HOST/camic/KEY.gpg | sudo gpg --dearmor -o /usr/share/keyrings/camic.gpg
echo "deb [signed-by=/usr/share/keyrings/camic.gpg] https://YOUR-APT-HOST/camic ./" | \
  sudo tee /etc/apt/sources.list.d/camic.list
sudo apt update && sudo apt install camic
```

Or install the file directly:

```bash
sudo apt install ./camic-1.0.0-amd64.deb
```

### Fedora — `.rpm`

```bash
# one-time: enable our repo (see docs/PUBLISHING.md)
sudo dnf config-manager --add-repo https://YOUR-DNF-HOST/camic/camic.repo
sudo dnf install camic
```

Or install the file directly:

```bash
sudo dnf install ./camic-1.0.0.x86_64.rpm
```

### Android — `.apk`

1. Copy `camic-1.0.0-android.apk` to your phone (USB, or from this machine over HTTP).
2. Open it and allow **Install from this source** when prompted.
3. Open **Camic**, grant **Camera** and **Microphone**.
4. Note the **pairing PIN** shown on screen.

> Android 8.0+ (minSdk 24). The app keeps the camera alive as a foreground service, so it
> keeps streaming when the screen is off or you switch apps.

### Any other Linux — AppImage (no install)

```bash
chmod +x Camic-1.0.0-x86_64.AppImage
./Camic-1.0.0-x86_64.AppImage
```

Or unpack the tarball:

```bash
tar -xzf Camic-1.0.0-x64.tar.gz && ./Camic-1.0.0-x64/camic-desktop
```

### From source

```bash
# desktop (Linux/Windows receiver)
cd desktop && npm install && npm start

# android
cd mobile && flutter build apk --release
# -> mobile/build/app/outputs/flutter-apk/app-release.apk
```

---

## One-time Linux host setup

The PC needs the **v4l2loopback** kernel module (virtual webcam) and open firewall ports:

```bash
sudo ./scripts/setup-linux-host.sh
```

This loads `v4l2loopback` with the label `Camic Camera`, creates the `camic_mic`
PulseAudio/PipeWire sink, and opens UDP `4748` + TCP `4747` in `firewalld`/`ufw`.

Manual equivalent:

```bash
sudo modprobe v4l2loopback card_label="Camic Camera" exclusive_caps=1
# persist across reboots:
echo v4l2loopback | sudo tee /etc/modules-load.d/camic.conf
echo 'options v4l2loopback card_label="Camic Camera" exclusive_caps=1' | \
  sudo tee /etc/modprobe.d/camic.conf
```

---

## Usage

1. On the phone: open **Camic**, grant camera + mic. It advertises itself on the Wi-Fi.
2. On the PC: launch **Camic**. Your phone appears under *Devices* — hit **Connect**
   and type the PIN (or enter the IP + PIN manually).
3. Pick **Camic Camera** / **Camic Microphone** in Zoom, Teams, OBS or your browser.

---

## Building the installers

```bash
# 1. Electron dir build (no installers)
cd desktop && npx electron-builder --linux dir && cd ..

# 2. native .deb + .rpm from that output
scripts/build-linux-packages.sh          # both
scripts/build-linux-packages.sh deb      # Ubuntu/Debian only
scripts/build-linux-packages.sh rpm      # Fedora only
```

`scripts/build-linux-packages.sh` needs `ar`, `tar`, `fakeroot` (for `.deb`) and
`rpmbuild` (for `.rpm`) — it does **not** need `dpkg` or `fpm`.

The other targets come straight from electron-builder:

```bash
cd desktop
npx electron-builder --linux AppImage tar.gz     # works locally
npx electron-builder --linux deb rpm             # needs dpkg + rpmbuild/fpm
```

| Package | Built where |
|---|---|
| `.deb` | `scripts/build-linux-packages.sh` (any distro) or CI (Ubuntu) |
| `.rpm` | `scripts/build-linux-packages.sh` (any distro) or CI (Fedora/Ubuntu) |
| `AppImage`, `tar.gz` | `npx electron-builder` anywhere |
| `.apk` | `flutter build apk --release` |
| Flatpak / Snap | `packaging/flatpak/`, `snap/` (see `docs/PUBLISHING.md`) |

---

## Testing without a phone

The fake-phone harness speaks the real protocol and streams synthetic video:

```bash
# terminal 1 — start the fake phone (streams to your PC's IP)
cd tools
node fake-phone.js --desktop <your-pc-ip> --pin 123456

# terminal 2 — full receive-path test (no GUI)
node integration-test.js
```

Receiver unit tests (packet reassembly, corrupt-frame handling):

```bash
node /tmp/opencode/video-recv-test.js desktop/src/main/videoReceiver.js
```

---

## Publishing to apt / dnf

Step-by-step for a Debian/Ubuntu APT repository and a Fedora `dnf` repository
(COPR or self-hosted), plus Flatpak and Snap, is in
**[`docs/PUBLISHING.md`](docs/PUBLISHING.md)**.

---

## Repository layout

```
camic/
├── protocol/            Wire spec (PROTOCOL.md) + JSON schemas
├── mobile/              Flutter app (Android + iOS)
│   ├── lib/             UI, TCP control server, UDP packetizer, native bridge
│   ├── android/         Kotlin: Camera2 + MediaCodec H.264/AAC, mDNS (NsdManager)
│   └── ios/             Swift: VideoToolbox + AudioToolbox (build on a Mac)
├── desktop/             Electron app (Linux + Windows)
│   ├── src/main/        discovery, TCP control, UDP+jitter receiver, virtual devices
│   ├── src/renderer/    UI + WebCodecs H.264 preview
│   └── native/windows/  DirectShow video + mic filters (MSVC) + build files
├── packaging/flatpak/   Flatpak manifest + desktop entry + metainfo
├── snap/                snapcraft.yaml + launcher assets
├── scripts/             host setup, installer packaging
├── tools/fake-phone/    Node test sender (synthetic H.264) — no phone needed
├── dist/                built installers + SHA256SUMS
└── docs/                architecture, build, publishing, user guide
```

## Documentation

- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — end-user setup
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — apt / dnf / Flatpak / Snap release process
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pipeline works
- [`docs/BUILD_ANDROID.md`](docs/BUILD_ANDROID.md) — building the Android APK
- [`docs/BUILD_WINDOWS_DLL.md`](docs/BUILD_WINDOWS_DLL.md) — building the Windows filters
- [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) — the wire protocol

## Status

| Part | State |
|---|---|
| Protocol + fake-phone test harness | ✅ done, integration test passes |
| Linux desktop receiver (Electron) | ✅ verified — virtual cam + mic, `.deb`/`.rpm`/AppImage built |
| Android app (Flutter + MediaCodec) | ✅ APK built (44.9 MB) and installed on a real device |
| Flatpak / Snap | 🟡 manifests written, not yet published |
| Windows DirectShow filters | 🟡 scaffolded — **must be built/tested on Windows (MSVC)** |
| iOS (VideoToolbox/AudioToolbox) | 🟡 scaffolded — **must be built/tested on a Mac** |

## License

MIT
