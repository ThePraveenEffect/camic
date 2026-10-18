# Final quality pass — sharp, non-blurry webcam

## Goal
Maximize sharpness end-to-end: phone ISP → encoder → network → desktop decode → virtual camera + preview. No AI super-resolution (research verdict below), but the full modern sharpness stack.

## Research verdict (2026)
- **On-phone AI SR: infeasible** — A20 (Mali-G71 MP2, no NPU) can't do 1080p30 real-time SR. CameraX Extensions: A20 unsupported (Android 11, not on Google's list), and extensions don't cover video.
- **NVIDIA RTX VSR: infeasible** — Chromium-only hook on browser video decode; never touches v4l2/ffmpeg.
- **Real-ESRGAN ncnn: not practical** — file-based API only; would need a custom raw-frame harness; marginal text gain, real latency risk.
- **What actually works (modern, cheap, proven):** FidelityFX CAS sharpening (ffmpeg `cas` + WebGL preview), lanczos scaling, ISP hardware edge enhancement (`EDGE_MODE`), minimal noise reduction, high bitrate, correct BT.709 color. Your ffmpeg 8.0.1 has `cas`, `hqdn3d`, `unsharp`; your RTX 3060 makes even GPU paths trivial, but CPU cas@1080p30 is already <1% load.

## Why it's still soft today (stack of causes, each fixed below)
1. AF was globally dead (fixed last round: minFocus gate).
2. Desktop virtual camera was hardcoded 720p (fixed last round).
3. No hardware sharpening / heavy noise reduction smearing detail (ISP).
4. 6 Mbps CBR at 1080p is modest (encoder).
5. ffmpeg bicubic scale + no denoise/sharpen (desktop).
6. EIS crop+resample softens (ISP) — A20 has no OIS, digital EIS only.
7. Possible BT.601/709 mismatch reads as washed-out "soft".

## Changes

### A. Phone — `mobile/.../VideoEncoder.kt`
1. **Diagnostics first** (one log line at session create):
   - `INFO_SUPPORTED_HARDWARE_LEVEL` (LEGACY/LIMITED/FULL) — gates everything.
   - Available `NOISE_REDUCTION_MODES`, `EDGE_MODES`, max `getOutputSizes(PRIV)`, fps ranges.
2. **ISP quality requests** (each only if listed in the available-modes query):
   - `EDGE_MODE = FAST` (hardware sharpening; no strength param exists — FAST avoids HQ frame-rate stalls).
   - `NOISE_REDUCTION_MODE = MINIMAL` (HQ temporal NR smears fine detail — the indoor sharpness killer; MINIMAL skips NR on the max-res stream). Fallback FAST.
   - `CONTROL_AE_ANTIBANDING_MODE = AUTO`.
   - Prefer hard `[30,30]` AE fps range (constant cadence; no judder) from `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES`.
3. **EIS default OFF** (`CONTROL_VIDEO_STABILIZATION_MODE = OFF` explicitly) — digital EIS crops+warps (measurable softness, no OIS on A20). Static/stand webcam = pure win. One-line revert constant if handheld shake becomes the complaint.
4. **Encoder color correctness**: `MediaFormat` keys `KEY_COLOR_STANDARD=BT709`, `KEY_COLOR_RANGE=LIMITED`, `KEY_COLOR_TRANSFER=SDR_VIDEO` so ffmpeg decodes correct colors (verified: constants exist on API 36).
5. **Bitrate up**: 1080p floor 6 → **8 Mbps**; scene-adaptive ceiling 8 → **12 Mbps** (Wi-Fi LAN, CBR, adaptive stays).

### B. Desktop OBS path — `desktop/src/main/devices/linuxVirtualDevice.js`
6. Decoder `-vf` chain becomes: `hqdn3d=3:2:4:3` (light 3D denoise) → `scale=…:flags=lanczos` (sharp scaler, was default bicubic) → `cas=strength=0.4:planes=1` (FidelityFX CAS, luma-only to avoid chroma ringing) → `fps=N`. Denoise-then-sharpen order (sharpen-first amplifies noise).
7. Decoder output `-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709` on the rawvideo pipe (documented intent for OBS assumptions).

### C. Desktop preview — `desktop/src/renderer/renderer.js`
8. Replace the plain `ctx.drawImage` paint with a **WebGL2 CAS pass** (~90 lines: VideoFrame → texture → CAS fragment shader → canvas). Strength uniform default 0.5. Graceful fallback to the existing 2D path if WebGL2 is unavailable. This is FidelityFX CAS in GLSL — <1ms/frame at 1080p.

### D. Not doing (with reasons)
- AI super-resolution (phone/RTX VSR/Real-ESRGAN): see research verdict.
- 4K capture supersampling: A20 caps at 1080p30 encode; log sizes to confirm, revisit only if log shows 4K.
- 10-bit/HDR: v4l2 consumers assume 8-bit yuv420p; skip.
- CameraX migration: large rewrite, no quality gain for A20.

## Verify
- Build APK; `node --check` desktop JS.
- Phone log must show: hardware level, `edge=fast`, `nr=minimal`, `color=bt709`, bitrate line.
- Text test: printed page at 25–40 cm, back camera, Focus tap → text edges crisp in both desktop preview and OBS at 1080p.
- If still soft: log tells us which requests the HAL ignored (e.g. LEGACY) → next lever is external lighting advice.

## User checklist
- Install APK, restart desktop app.
- OBS canvas/video device at 1920×1080.
- Back camera, 10–40 cm for macro, decent light, tap Focus.
