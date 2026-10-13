# Camic Architecture

Camic turns a phone into a wireless webcam + mic for a PC on the same LAN. It follows the same shape as popular tools in this category (DroidCam / Iriun / EpocCam): hardware encode on the phone, low-latency UDP on the wire, and a real virtual device on the PC.

## Pipeline

```
┌────────────── Phone ──────────────┐
│ Camera2/AVCaptureSession          │
│   → MediaCodec / VideoToolbox     │  H.264 (HW), Annex-B, SPS/PPS on keyframes
│ Mic → MediaCodec / AudioToolbox   │  AAC-LC 20 ms
│   → UDP packetizer (12-B header)  │──► UDP :4748 ──┐
│ TCP control server :4747 (JSON)   │◄───────────────┼── TCP :4747
│ mDNS advertise _camic._tcp    │                │
└───────────────────────────────────┘                │
                                                     ▼
┌────────────── Desktop (Electron) ──────────────────┴──────────────┐
│ mDNS browse → TCP control client → UDP StreamReceiver             │
│   → video: reassemble AUs, in-order + gap-skip, jitter buffer     │
│   → audio: ADTS-wrap AAC frames                                   │
│   ├─ preview: WebCodecs VideoDecoder (Annex-B→AVCC) → canvas      │
│   └─ virtual device:                                            │
│        Linux:   ffmpeg → v4l2loopback (/dev/videoN)             │
│                 ffmpeg → PipeWire null-sink (mic)               │
│        Windows: ffmpeg → YUY2 → named pipe → DirectShow filter   │
└───────────────────────────────────────────────────────────────────┘
```

## Wire protocol (summary)

Full spec: [`protocol/PROTOCOL.md`](../protocol/PROTOCOL.md).

| Channel | Transport | Purpose |
|---|---|---|
| Discovery | mDNS `_camic._tcp:4747` | auto-find phone; TXT carries id/name/codecs |
| Control | TCP 4747, JSON-lines | `hello`(PIN) / `start` / `stop` / `keyframe` / `torch` / `status` / `ping` |
| Video | UDP 4748 | H.264 access units, fragmented ≤1400 B, 12-byte header |
| Audio | UDP 4748 | AAC-LC frames (desktop wraps ADTS) |

**Header (12 B, big-endian):** `version | type | flags | reserved | seq(4) | timestamp(4)`.
Flags: bit0 `KEYFRAME`, bit1 `END_OF_FRAME`, bit2 `CONFIG`.

Keyframes embed SPS/PPS so a mid-stream joiner can decode. Desktop requests a keyframe every 2 s and after loss.

## Latency budget

- Phone capture + HW encode: ~1 frame (33 ms @30fps)
- Packetize + LAN: <5 ms
- Jitter buffer: 1–2 frames (configurable)
- Decode (HW) + virtual-device present: ~10–20 ms

**Total ~60–120 ms** on clean Wi-Fi.

## Receiver details

- **Reassembly:** packets buffered by `seq`; consumed in order; gaps skip ahead to the lowest pending seq (counts loss); partial AUs discarded until the next keyframe.
- **Preview:** main process forwards Annex-B AUs to the renderer; WebCodecs `VideoDecoder` needs AVCC, so the renderer builds the `avcC` (description) from SPS/PPS and converts start-codes → length-prefixed NALs.
- **Virtual camera (Linux):** `ffmpeg -f h264 -i pipe:0 -f v4l2 /dev/videoN`. Mic: PipeWire null-sink named `camic_mic`; its `.monitor` is the selectable source.
- **Virtual camera (Windows):** Electron decodes H.264 → YUY2 with a bundled `ffmpeg.exe`, writes framed buffers to `\\.\pipe\camic-video`; the DirectShow **CamicCamera** filter (a `CSource` push-source) serves them. Audio mirrors over `camic-audio`.

## Security

Trust-on-first-use with a 6-digit PIN (rate-limited on the phone). After pairing, the desktop id is stored. Traffic is plaintext (LAN-trusted model, same as this app category); the control socket is structured so TLS can be added later.
