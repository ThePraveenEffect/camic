'use strict';
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Linux virtual devices via ffmpeg + v4l2loopback + PipeWire null-sink.
 *
 * Video: ffmpeg reads Annex-B H.264 from stdin and writes raw frames to a
 *        v4l2loopback device (/dev/videoN) that apps see as a webcam.
 * Audio: ffmpeg reads ADTS AAC from stdin, decodes to PCM, and writes into a
 *        PipeWire/PulseAudio null-sink named "Camic Mic"; the sink's
 *        .monitor becomes a selectable microphone source for apps.
 *
 * Emits: 'error'(err), 'videoReady'(dev), 'audioReady'(sink)
 */
class LinuxVirtualDevice extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.videoDev = opts.videoDev || null; // e.g. /dev/video10
    this.sinkName = 'camic_mic';
    // Persistent v4l2 writer (rawvideo → device). Never restarted, so OBS's
    // buffer queue stays stable. Sources (test pattern / phone decoder) pipe
    // raw frames into it.
    this.writer = null;
    this.idleSrc = null;   // test pattern → writer (while idle)
    this.decoder = null;   // phone H.264 → rawvideo → writer (while streaming)
    // Frame-aligned pump cleanups (see _pump) — keep writer's raw stream intact
    // across source switches so a mid-frame kill can't byte-shift OBS's frames.
    this._idlePump = null;
    this._decPump = null;
    // Virtual-camera format (scaled from the phone stream so the writer never
    // needs a restart — resolution changes would otherwise freeze OBS).
    // Default 1080p: at 720p small details are unresolvable even with perfect
    // focus. Override via createVirtualDevice({ size: {w,h,fps} }).
    this.vsize = { w: opts.size?.w || 1920, h: opts.size?.h || 1080, fps: opts.size?.fps || 30 };
    this.audProc = null;
    this.sinkModuleId = null;
    this.sourceModuleId = null;
    this.ffmpeg = opts.ffmpeg || this.findFfmpeg();
  }

  /**
   * Resolve the ffmpeg binary: bundled next to the app (packaged builds),
   * else PATH, else the repo's static build. Returns a command that actually
   * runs, falling back to 'ffmpeg' so the error surfaces at spawn time.
   */
  findFfmpeg() {
    const candidates = [
      path.join(process.resourcesPath || '', 'ffmpeg'),
      'ffmpeg',
      path.join(os.homedir(), 'tools', 'ffmpeg-static', 'bin', 'ffmpeg'),
    ];
    for (const c of candidates) {
      try {
        if (c === 'ffmpeg' || fs.existsSync(c)) { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; }
      } catch {}
    }
    return 'ffmpeg';
  }

  /**
   * Make the virtual devices always visible to apps like OBS:
   *  - create the audio null-sink at startup (not just on first stream)
   *  - start a PERSISTENT v4l2 writer (rawvideo → /dev/videoN) that never dies,
   *    and feed it a test pattern while idle. Because the writer process never
   *    changes, OBS keeps a stable buffer queue and never freezes.
   * Call once at app startup.
   */
  ensureAvailable() {
    this.ensureSink();
    this.startWriter();
    this.startIdleFeed();
  }

  /** Persistent writer: raw YUV420P frames → v4l2 device. Never restarted. */
  startWriter() {
    if (!this.videoDev) this.videoDev = this.findVideoDev();
    if (!this.videoDev || !fs.existsSync(this.videoDev)) return false;
    if (this.writer) return true;
    const { w, h, fps } = this.vsize;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${w}x${h}`, '-r', String(fps),
      '-i', 'pipe:0',
      '-an', '-f', 'v4l2', this.videoDev,
    ];
    this.writer = spawn(this.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.writer.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.emit('error', new Error('v4l2-writer: ' + s)); });
    this.writer.on('error', (err) => this.emit('error', new Error('v4l2-writer spawn: ' + err.message)));
    this.writer.on('exit', () => { this.writer = null; });
    return true;
  }

  /** Idle feed: testsrc decoded to rawvideo, piped into the persistent writer. */
  startIdleFeed() {
    // Never run the test pattern while the live decoder is feeding the writer —
    // two raw sources interleaving would corrupt the frames OBS sees.
    if (!this.writer || this.idleSrc || this.decoder) return;
    const { w, h, fps } = this.vsize;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=${fps}`,
      '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1',
    ];
    this.idleSrc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Frame-aligned pump keeps the writer's raw stream intact across switches.
    this._idlePump = this._pump(this.idleSrc.stdout);
    this.idleSrc.on('error', () => {});
    this.idleSrc.on('exit', () => { this.idleSrc = null; });
  }

  stopIdleFeed() {
    if (this._idlePump) { this._idlePump(); this._idlePump = null; }
    if (this.idleSrc) {
      const p = this.idleSrc;
      this.idleSrc = null; // clear first so exit handler is a no-op
      try { p.kill('SIGKILL'); } catch {}
    }
  }

  /**
   * Pump a source process's stdout into the persistent v4l2 writer, emitting
   * ONLY complete frames. The writer (rawvideo -> /dev/videoN) reads a fixed
   * frame_size; if it ever receives a partial frame, every frame after that is
   * byte-shifted and OBS shows garbage. Sources are SIGKILLed mid-frame on
   * every stream start/stop (idle <-> decoder switch), so we buffer to frame
   * boundaries and discard the trailing partial when the source ends.
   * Returns a cleanup fn that detaches and drops any pending partial.
   */
  _pump(src, onFrame) {
    const FRAME = (this.vsize.w * this.vsize.h * 3) >> 1; // yuv420p bytes
    let acc = null, start = 0;
    const writeReady = () => {
      const wi = this.writer && this.writer.stdin;
      if (!acc || !wi || !wi.writable) return;
      while (acc.length - start >= FRAME) {
        const ok = wi.write(acc.subarray(start, start + FRAME));
        start += FRAME;
        if (onFrame) onFrame();
        if (!ok) {
          src.pause();
          wi.once('drain', () => { try { src.resume(); } catch {} writeReady(); });
          break;
        }
      }
      if (start >= acc.length) { acc = null; start = 0; }
      else if (start > 0) { acc = acc.subarray(start); start = 0; }
    };
    const onData = (d) => {
      if (!acc) { acc = d; start = 0; }
      else if (start > 0) { acc = Buffer.concat([acc.subarray(start), d]); start = 0; }
      else { acc = Buffer.concat([acc, d]); }
      writeReady();
    };
    const cleanup = () => {
      try { src.removeListener('data', onData); } catch {}
      acc = null; start = 0;
    };
    src.on('data', onData);
    src.on('end', cleanup);
    src.on('close', cleanup);
    return cleanup;
  }

  /** Find the v4l2loopback device (label contains "Camic"/legacy or fallback). */
  findVideoDev() {
    // v4l2loopback devices appear in /sys/class/video4linux/*/name (card_label).
    // Match current ("Camic Camera") and legacy ("CamBridge Camera") labels so a
    // module loaded before the rename still resolves.
    const base = '/sys/class/video4linux';
    const LOOP = /camic|cambridge|dummy|loopback/i;
    let entries = [];
    try { entries = fs.readdirSync(base); } catch { return null; }
    for (const e of entries) {
      let name = '';
      try { name = fs.readFileSync(`${base}/${e}/name`, 'utf8').trim(); } catch {}
      if (LOOP.test(name)) return `/dev/${e}`;
    }
    // fallback: any /dev/videoN whose label looks like a loopback/dummy device
    for (const e of entries) {
      const dev = `/dev/${e}`;
      let name = '';
      try { name = fs.readFileSync(`${base}/${e}/name`, 'utf8').trim(); } catch {}
      if (/dummy|loopback/i.test(name)) return dev;
    }
    return null;
  }

  /**
   * Start feeding live phone video into the persistent writer.
   * A decoder ffmpeg reads the phone's Annex-B H.264, scales it to the fixed
   * virtual-camera size, and pipes raw YUV420P into writer.stdin. The writer
   * itself is never restarted, so OBS keeps its buffer queue.
   */
  startVideo() {
    if (!this.videoDev) this.videoDev = this.findVideoDev();
    if (!this.videoDev || !fs.existsSync(this.videoDev)) {
      this.emit('error', new Error('No v4l2loopback device found. Run scripts/setup-linux-host.sh and ensure /dev/videoN exists.'));
      return false;
    }
    if (!this.writer && !this.startWriter()) {
      this.emit('error', new Error('Could not start v4l2 writer.'));
      return false;
    }
    this.stopIdleFeed(); // stop the test pattern; decoder takes over the pipe
    // Kill any leftover decoder (e.g. a reconnect that didn't cleanly stop),
    // otherwise it keeps feeding the writer and leaks a process.
    if (this._decPump) { this._decPump(); this._decPump = null; }
    if (this.decoder) {
      try { this.decoder.kill('SIGKILL'); } catch {}
      this.decoder = null;
    }
    const { w, h, fps } = this.vsize;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // NOTE: do NOT use '-fflags nobuffer' here — on a live (non-seekable)
      // pipe fed by the phone it makes ffmpeg emit zero frames. '-flags
      // low_delay' is safe and keeps latency down.
      '-flags', 'low_delay',
      '-f', 'h264', '-i', 'pipe:0',
      // Sharpness chain: light 3D denoise → lanczos scale (sharper than the
      // default bicubic) → FidelityFX CAS sharpen (luma-only, no chroma
      // ringing). Denoise MUST precede sharpen or sensor noise gets amplified.
      '-vf', `hqdn3d=3:2:4:3,scale=${w}:${h}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,cas=strength=0.4:planes=1,fps=${fps}`,
      '-pix_fmt', 'yuv420p',
      // Declare the color we write so OBS/consumers don't guess BT.601.
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-an',
      '-f', 'rawvideo', 'pipe:1',
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.decoder = proc;
    // Frame counter (sanity log): proves decoded frames are reaching the writer.
    let frames = 0, lastLog = Date.now();
    this._decPump = this._pump(proc.stdout, () => {
      frames++;
      const now = Date.now();
      if (now - lastLog >= 2000) { console.log('[vdev] decoder -> writer: %d frames in %ds', frames, Math.round((now - lastLog) / 1000)); frames = 0; lastLog = now; }
    });
    // Feed decoded raw frames into the persistent writer (keep stdin open).
    proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.emit('error', new Error('ffmpeg-decode: ' + s)); });
    proc.on('error', (err) => this.emit('error', new Error('ffmpeg-decode spawn: ' + err.message)));
    proc.on('exit', (code) => {
      // Only clean up if this is still the active decoder (a newer one may
      // have replaced it already).
      if (this.decoder === proc) {
        this.decoder = null;
        if (this._decPump) { this._decPump(); this._decPump = null; }
        // Stream ended (or decoder died) → resume the test pattern so OBS
        // doesn't freeze on the last frame.
        if (code !== 0 && code !== null) this.emit('error', new Error('ffmpeg-decode exited ' + code));
        this.startIdleFeed();
      }
    });
    this.emit('videoReady', this.videoDev);
    return true;
  }

  writeVideo(au) {
    if (this.decoder && this.decoder.stdin.writable) this.decoder.stdin.write(au);
  }

  /** Create the null sink if missing (via pactl), then start ffmpeg → sink. */
  startAudio() {
    this.ensureSink();
    // Kill any leftover audio process (reconnect without clean stop), else it leaks.
    if (this.audProc) {
      try { this.audProc.stdin.end(); } catch {}
      try { this.audProc.kill('SIGKILL'); } catch {}
      this.audProc = null;
    }
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'aac', '-i', 'pipe:0',
      '-f', 'pulse', this.sinkName,
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.audProc = proc;
    proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.emit('error', new Error('ffmpeg-audio: ' + s)); });
    proc.on('error', (err) => this.emit('error', new Error('ffmpeg-audio spawn: ' + err.message)));
    this.emit('audioReady', this.sinkName);
    return true;
  }

  writeAudio(adtsFrame) { if (this.audProc && this.audProc.stdin.writable) this.audProc.stdin.write(adtsFrame); }

  ensureSink() {
    // create null sink named camic_mic if it doesn't exist
    try {
      const out = require('child_process').execSync('pactl list short sinks 2>/dev/null || true', { encoding: 'utf8' });
      if (!out.includes(this.sinkName)) {
        const mod = require('child_process').execSync(
          `pactl load-module module-null-sink sink_name=${this.sinkName} sink_properties=device.description=CamicMic 2>/dev/null || true`,
          { encoding: 'utf8' }
        ).trim();
        if (mod) this.sinkModuleId = parseInt(mod, 10);
      }
      this.ensureSource();
    } catch (err) {
      this.emit('error', new Error('Could not create audio sink (is pulseaudio-utils/pactl installed?): ' + err.message));
    }
  }

  /**
   * Browsers (Chromium/Firefox) filter out PulseAudio *monitor* sources from
   * their microphone pickers — they only list real Audio/Source nodes. So the
   * null-sink's ".monitor" is visible to OBS but NOT to a browser's
   * getUserMedia list. The fix: a module-remap-source wrapping the monitor,
   * which presents as a regular source ("Monitor of Sink: n/a") and passes
   * audio through untouched.
   *
   * NOTE: pactl splits module args on spaces, so the device.description value
   * uses U+00A0 (NBSP) between words — it renders as a normal space in UIs
   * but survives the arg split.
   */
  ensureSource() {
    try {
      const out = require('child_process').execSync('pactl list short sources 2>/dev/null || true', { encoding: 'utf8' });
      if (out.includes('camic_mic_source')) return;
      const nbsp = ' ';
      const mod = require('child_process').execSync(
        `pactl load-module module-remap-source master=${this.sinkName}.monitor ` +
        `source_name=camic_mic_source ` +
        `source_properties="device.description=Camic${nbsp}Microphone device.icon_name=audio-input-microphone" ` +
        `2>/dev/null || true`,
        { encoding: 'utf8' }
      ).trim();
      if (mod) this.sourceModuleId = parseInt(mod, 10);
    } catch (err) {
      this.emit('error', new Error('Could not create microphone source: ' + err.message));
    }
  }

  stopVideo() {
    // Kill the decoder; its exit handler resumes the idle test-pattern feed so
    // OBS never freezes on a stale frame. The persistent writer stays alive.
    // The frame-aligned pump discards any trailing partial frame on source
    // close, so the idle feed that follows starts on a clean frame boundary.
    if (this._decPump) { this._decPump(); this._decPump = null; }
    if (this.decoder) {
      try { this.decoder.stdin.end(); } catch {}
      try { this.decoder.kill(); } catch {}
      this.decoder = null;
      this.startIdleFeed();
    }
  }
  stopAudio() {
    if (this.audProc) { try { this.audProc.stdin.end(); } catch {} try { this.audProc.kill(); } catch {} this.audProc = null; }
  }

  stop() {
    this.stopVideo();
    this.stopAudio();
    // On full shutdown, tear down the persistent writer too.
    this.stopIdleFeed();
    if (this.writer) { try { this.writer.stdin.end(); } catch {} try { this.writer.kill(); } catch {} this.writer = null; }
  }
}

module.exports = { LinuxVirtualDevice };
