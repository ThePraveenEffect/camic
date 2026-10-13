# Building the Camic Windows filters

The Windows virtual camera and mic are **DirectShow source filters** (`CamicFilters.dll`) that make Windows see real **"Camic Camera"** / **"Camic Microphone"** devices in Zoom / Teams / OBS / browsers.

See [`../native/windows/README.md`](../native/windows/README.md) for the full step-by-step (prerequisites, base-classes setup, CMake commands, registration). Summary:

1. Build on **Windows with MSVC** + Windows SDK (the DirectShow base classes are not in mingw).
2. Build the SDK's **baseclasses** sample once; point CMake at it via `-DBASECLASSES_DIR=...`.
3. `cmake -B build -G "Visual Studio 17 2022" -A x64 && cmake --build build --config Release`
4. Register as Admin: `register.bat build\Release\CamicFilters.dll`

The Camic Electron app on Windows decodes the stream to **YUY2** with a bundled `ffmpeg.exe` and feeds the filter over a named pipe (`\\.\pipe\camic-video` / `camic-audio`).

**This DLL is scaffolded on Linux and must be compiled and tested on a real Windows machine.** Budget a build + test cycle; you may need to reconcile the exact `baseclasses.lib` path for your SDK.
