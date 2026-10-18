# Camic Wire Protocol v1

Same-LAN transport for phone→computer audio/video. Three channels: mDNS discovery, TCP control, UDP media.

## Ports & Service

| Item | Value |
|---|---|
| Control TCP | `4747` (phone listens, desktop connects) |
| Media UDP | `4748` (phone sends, desktop listens) |
| mDNS service type | `_camic._tcp` (advertised by phone) |
| Protocol version | `1` |

All multi-byte integers are **big-endian (network order)**.

## 1. Discovery (mDNS / DNS-SD)

Phone advertises via NsdManager (Android) / Bonjour (iOS):

- Service name: `<DeviceName>-<last4ofId>` (e.g. `Pixel8-a1b2`)
- Port: `4747`
- TXT records:
  - `id` — stable random device id (hex, 16 chars)
  - `ver` — protocol version, `"1"`
  - `enc` — supported video codecs, comma list, e.g. `"h264"`
  - `aenc` — supported audio codecs, e.g. `"aac"`
  - `pin` — `"1"` if pairing required (always `"1"` in v1)

Desktop browses `_camic._tcp`. Fallback: manual `IP:port` entry in UI.

## 2. Control Channel (TCP, JSON Lines)

Newline-delimited UTF-8 JSON. Desktop connects to phone. First message must be `hello` within 3 s or phone closes.

### Desktop → Phone

```json
{"cmd":"hello","v":1,"pin":"482913","client":"linux/1.0.0","wantAudio":true,"wantVideo":true}
{"cmd":"start","video":{"w":1280,"h":720,"fps":30,"bitrate":4000000},"audio":{"enabled":true,"sampleRate":48000,"channels":1,"bitrate":64000}}
{"cmd":"stop"}
{"cmd":"keyframe"}
{"cmd":"switchCamera"}
{"cmd":"refocus"}
{"cmd":"netq","loss":4.2}
{"cmd":"setTorch","on":true}
{"cmd":"setZoom","level":1.5}
{"cmd":"ping","t":1718000000000}
```

### Phone → Desktop

```json
{"cmd":"helloAck","v":1,"id":"a1b2c3d4e5f60708","name":"Pixel 8","battery":82,"temp":31.2,
 "cameras":[{"id":0,"name":"Back","facing":"back","res":[[1920,1080],[1280,720],[640,480]]},
            {"id":1,"name":"Front","facing":"front","res":[[1280,720],[640,480]]}]}
{"cmd":"started","video":{"w":1280,"h":720,"fps":30,"codec":"h264"},"audio":{"enabled":true,"sampleRate":48000,"channels":1,"codec":"aac"}}
{"cmd":"stopped"}
{"cmd":"status","fps":29.4,"bitrate":3950000,"battery":81,"temp":33.0,"lossPct":0.2}
{"cmd":"pong","t":1718000000000,"lt":1718000000120}
{"cmd":"error","code":"encode_failed","message":"Camera encoder failed"}
```

Errors are non-fatal unless the socket closes. `status` is sent every 1 s while streaming.

### Pairing

Phone shows a 6-digit PIN on first launch / when unpaired. Desktop must send it in `hello`. Phone replies `helloAck` on success or `{"cmd":"error","code":"bad_pin"}` and closes on failure. After success the desktop `id` (from mDNS TXT or first `helloAck`) is added to the phone trust list and future connections skip the PIN.

## 3. Media Channel (UDP)

One socket on phone (`sendTo(desktopIp, 4748)`), one on desktop (bind `0.0.0.0:4748`). Every datagram: 12-byte header + payload. Max datagram 1400 bytes (safe under typical 1500 MTU).

### Header (12 bytes)

```
offset  size  field
0       1     version   = 1
1       1     type      = 0 video, 1 audio
2       1     flags     bit0 = KEYFRAME (video only)
                        bit1 = END_OF_FRAME (last packet of this frame)
                        bit2 = CONFIG (payload is codec config: SPS/PPS for h264, ASC for aac)
3       1     reserved  = 0
4       4     seq       uint32, per-type sequence number (wraps)
8       4     timestamp uint32, ms since stream start (media clock)
```

### Video (type 0)

Payload is raw **H.264 Annex-B** bytes (start codes included) — one NAL or one fragment of an access unit per packet. Packets with the same `seq` stream fragment one AU until `END_OF_FRAME`.

- Keyframes MUST embed SPS/PPS NALs before the IDR (so a mid-stream joiner can decode).
- Phone sends a `CONFIG` packet (SPS/PPS only, KEYFRAME|CONFIG flags) immediately after `started` and every 2 s.
- Phone requests nothing; desktop requests keyframes via control `keyframe` command (on join, and after loss).
- Default: 1280×720@30fps, 4 Mbps CBR-ish; 720p is the sweet spot, 1080p optional.

Receiver reassembly:
1. Buffer packets by `seq` for one AU; `END_OF_FRAME` completes it.
2. Feed completed AU to decoder (must contain SPS/PPS on keyframes).
3. On gap in `seq` > 0 → count loss; discard partial AU; wait for next keyframe to resume decode.
4. Jitter buffer: reorder & delay `N` frames (default 2, configurable 1–5) before decode/present.

### Audio (type 1)

Payload is one **AAC-LC** frame per packet (ADTS optional; if absent, ASC from CONFIG packet or from `started.audio`). 20 ms frames (default 48 kHz mono, 64 kbps). `CONFIG` packet carries AudioSpecificConfig (2 bytes) flagged `CONFIG`.

PCM fallback (v1.1): type 1 with `codec:"pcm"` in `started.audio`, payload = little-endian s16le interleaved samples, 20 ms per packet.

### Timing / Latency

- `timestamp` is capture time in ms (monotonic). Desktop presents using arrival + jitter buffer, not wall-clock sync (one-way, no RTT needed).
- Target glass-to-glass: 60–120 ms on clean LAN (encode 1 frame + net + jitter 1–2 frames + decode + virtual-device present).
- Desktop sends control `keyframe` at least every 2 s if the stream is active (phone may also IDR periodically on its own, default GOP 2 s).

## 4. Security

- Trust-on-first-use with PIN (see Pairing). PIN is 6 digits, rate-limited to 5 attempts/min on phone.
- After pairing, phone stores desktop id; unpaired desktops with wrong id are rejected even with a valid PIN? No — PIN alone is sufficient; id is for display/forget.
- All traffic is plaintext (LAN-trusted model, same as DroidCam/Iriun v1). TLS is out of scope for v1 but the control socket is structured so a TLS wrapper can be added later.
- Phone only binds the control server on the LAN interface; never advertises off-link.

## 5. Versioning

`v` field in `hello`/`helloAck` must be `1`. Unknown JSON keys are ignored (forward compat). Unknown `cmd` values are ignored with no error. Breaking changes bump `v`.

## 6. Codec Mandates (v1)

| Media | Codec | Notes |
|---|---|---|
| Video | H.264 Baseline/Main, Annex-B | HW encode on phone (MediaCodec / VideoToolbox) |
| Audio | AAC-LC | HW encode (MediaCodec / AudioToolbox); PCM fallback reserved |
