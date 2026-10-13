# Building the Camic Windows filters

These are the DirectShow source filters that make Windows see a real **"Camic Camera"** and **"Camic Microphone"** in Zoom / Teams / OBS / browsers.

## Why MSVC (not mingw)

The filters use the **DirectShow base classes** (`streams.h`, `CSource`, `CSourceStream`, `AMovieDllRegisterServer2`). Those ship with the Windows SDK *samples* (`baseclasses` project) and are not available in mingw-w64. So the supported build path is **MSVC on Windows**. (The wire/network side of Camic is cross-platform Node/Flutter — only these DLLs are Windows-native.)

## Prerequisites

1. **Visual Studio 2022** with the *Desktop development with C++* workload.
2. **Windows 10/11 SDK** (installed with VS).
3. The **DirectShow base classes** sample, built once:
   - Install the "Windows SDK Samples" (via the SDK's "SDK Management" or the VS Installer → *Individual components → Windows 10/11 SDK → SDK samples*).
   - Open `Samples/multimedia/directshow/baseclasses/baseclasses.vcxproj` and build it (Release x64). Note the output `baseclasses.lib` and the folder containing `streams.h`.

## Build

```bat
cd camic\native\windows
cmake -B build -G "Visual Studio 17 2022" -A x64 -DBASECLASSES_DIR="C:\path\to\directshow\baseclasses"
cmake --build build --config Release
```

`BASECLASSES_DIR` must contain `Include\streams.h` and `Lib\BaseClasses\baseclasses.lib` (adjust the CMake `target_link_libraries` path if your layout differs). If your base-classes build places the lib elsewhere, edit `CMakeLists.txt` accordingly.

Output: `build\Release\CamicFilters.dll`

## Register (as Administrator)

```bat
cd camic\native\windows
register.bat build\Release\CamicFilters.dll
```

Then open Zoom/Teams/OBS/browser → camera/mic pickers → select **Camic Camera** / **Camic Microphone**.

To unregister: `regsvr32 /u build\Release\CamicFilters.dll`

## How it works

The Camic Electron app (Windows build) receives H.264 over Wi-Fi, decodes to raw **YUY2** with a bundled `ffmpeg.exe`, and writes framed buffers to the named pipe `\\.\pipe\camic-video`. The **CamicCamera** filter is a DirectShow *push source*: a worker thread reads those frames and serves them downstream. Audio works the same over `\\.\pipe\camic-audio` (PCM s16le), served by **CamicMic**.

## Note

This DLL is scaffolded here on Linux and **must be compiled and tested on a real Windows machine** — it cannot be verified from the Linux build host. Budget a build+test cycle on Windows; expect to reconcile the exact `baseclasses.lib` path for your SDK.
