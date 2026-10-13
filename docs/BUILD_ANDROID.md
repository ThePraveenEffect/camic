# Building the Camic Android app

The phone app is Flutter with a native Kotlin media pipeline (Camera2 + MediaCodec hardware H.264/AAC).

## Prerequisites

- **Flutter SDK** (3.x stable)
- **JDK 17**
- **Android SDK** (platform 35, build-tools 35) + **platform-tools**
- An Android device (or emulator — note: emulators have weak cameras)

On this repo's build host these live under `~/tools` (`flutter`, `jdk17`, `Android/Sdk`); `~/.bashrc` has a `camic-toolchain` block exporting them.

## Environment

```bash
export JAVA_HOME=~/tools/jdk17
export ANDROID_HOME=~/tools/Android/Sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export PATH=$JAVA_HOME/bin:~/tools/flutter/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
```

## Build the APK

```bash
cd mobile
flutter pub get
flutter build apk --release
```

Output: `build/app/outputs/flutter-apk/app-release.apk` (~45 MB). Install with `adb install` or copy to the phone.

## Memory note (small machines)

Flutter's default `android/gradle.properties` sets `-Xmx8G`, which can OOM on hosts with <8 GB RAM. This repo sets `-Xmx2G`. If a Gradle build hangs or dies, check free memory (`free -h`) and close heavy apps first.

## Native media pipeline

- `android/.../VideoEncoder.kt` — Camera2 → MediaCodec H.264 via a zero-copy input Surface; emits Annex-B AUs with SPS/PPS on keyframes.
- `android/.../AudioEncoder.kt` — AudioRecord → MediaCodec AAC-LC (20 ms).
- `android/.../StreamPlugin.kt` — MethodChannel `camic/stream` + EventChannel `camic/frames`.
- `android/.../NsdPlugin.kt` — mDNS advertise via NsdManager (`_camic._tcp`).

The shared Dart layer (`lib/services/`) handles the TCP control server, UDP packetizer, and the native bridge, so the iOS build reuses it.

## iOS

The Swift encoders (`ios/Runner/VideoEncoder.swift`, `AudioEncoder.swift`, `StreamPlugin.swift`) mirror the Android channels. To build, open `ios/Runner.xcworkspace` in **Xcode on a Mac**, set your development team/signing, and run on a device. Camera/mic permission strings are already in `Info.plist`. The iOS audio encoder's AudioConverter path is a starting scaffold — expect to refine it during the Mac build/test cycle.
