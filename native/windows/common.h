// Camic DirectShow filter — shared declarations (MSVC + Windows SDK).
// Uses the standard DirectShow base classes (streams.h) — the professional,
// well-trodden path for building virtual webcams on Windows (same approach the
// classic virtual-cam filters use). Build with MSVC; see BUILD_WINDOWS_DLL.md.
#ifndef CAMIC_COMMON_H
#define CAMIC_COMMON_H

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define STRICT
#include <windows.h>
#include <streams.h>     // DirectShow base classes (CSource, CSourceStream, ...)
#include <dshow.h>
#else
#error "Camic filters are Windows-only (build on Windows with MSVC)."
#endif

#include <stdint.h>

// {B7E1A1D0-4C3F-4E7A-9C2B-5D8F0E6A1B20} — Camic Camera filter CLSID
static const GUID CLSID_CamicCamera =
{ 0xb7e1a1d0, 0x4c3f, 0x4e7a, { 0x9c, 0x2b, 0x5d, 0x8f, 0x0e, 0x6a, 0x1b, 0x20 } };

// {C8F2B2E1-5D40-4F8B-8D3C-6E9A1F7B2C31} — Camic Mic filter CLSID
static const GUID CLSID_CamicMic =
{ 0xc8f2b2e1, 0x5d40, 0x4f8b, { 0x8d, 0x3c, 0x6e, 0x9a, 0x1f, 0x7b, 0x2c, 0x31 } };

#define VIDEO_PIPE_NAME L"\\\\.\\pipe\\camic-video"
#define AUDIO_PIPE_NAME L"\\\\.\\pipe\\camic-audio"

// Frame header written by the Camic app before each raw YUY2 frame.
#pragma pack(push, 1)
struct VideoFrameHeader {
    uint32_t width;
    uint32_t height;
    uint32_t pitch;    // bytes per line (= width*2 for YUY2)
    uint32_t flags;    // bit0 = keyframe
    uint64_t ptsMs;
};
#pragma pack(pop)

extern HINSTANCE g_hInst;

#endif // CAMIC_COMMON_H
