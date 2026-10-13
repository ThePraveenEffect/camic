'use strict';
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Windows virtual devices via DirectShow filters (CamicCamera.ax / CamicMic.ax).
 *
 * Video: Electron receives Annex-B H.264 → spawns ffmpeg to decode to rawvideo
 *        yuv420p → pushes framed YUV buffers over a named pipe that the
 *        CamicCamera DirectShow source filter reads and serves to apps.
 * Audio: similarly decodes ADTS AAC to s16le PCM and pushes to CamicMic.ax.
 *
 * Named-pipe frame format (video): little-endian header + raw yuv420p planes:
 *   u32 width, u32 height, u32 pitch (Y stride), u32 flags (bit0=key), u64 ptsMs,
 *   then Y (pitch*height) + U (pitch/2*height/2) + V (pitch/2*height/2).
 *
 * Emits: 'error'(err), 'videoReady', 'audioReady'
 */
class WindowsVirtualDevice extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.supported = true;
    this.videoPipe = opts.videoPipe || '\\\\.\\pipe\\camic-video';
    this.audioPipe = opts.audioPipe || '\\\\.\\pipe\\camic-audio';
    this.width = opts.width || 1280;
    this.height = opts.height || 720;
    this.vidProc = null;
    this.audProc = null;
    this.vidPipeStream = null;
    this.audPipeStream = null;
    this.ffmpeg = opts.ffmpeg || this.findFfmpeg();
  }

  findFfmpeg() {
    // bundled ffmpeg.exe next to app, else PATH, else repo static build
    const candidates = [
      path.join(process.resourcesPath || '', 'ffmpeg.exe'),
      'ffmpeg.exe',
      'ffmpeg',
      path.join(os.homedir(), 'tools', 'ffmpeg-static', 'bin', 'ffmpeg.exe'),
    ];
    for (const c of candidates) {
      try { if (c === 'ffmpeg.exe' || c === 'ffmpeg' || fs.existsSync(c)) { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; } } catch {}
    }
    return 'ffmpeg';
  }

  /** Wait briefly for the DirectShow filter to open the named pipe, then write. */
  openVideoPipe() {
    // Node's net can create a server on a named pipe; the filter is the client.
    // We act as the pipe SERVER so the filter connects out to us.
    const net = require('net');
    return new Promise((resolve) => {
      const srv = net.createServer((sock) => {
        this.vidPipeStream = sock;
        sock.on('close', () => { this.vidPipeStream = null; });
        sock.on('error', () => {});
        resolve(true);
      });
      srv.on('error', (err) => { this.emit('error', new Error('video pipe: ' + err.message)); resolve(false); });
      try { fs.unlinkSync(this.videoPipe.replace('\\\\.\\pipe\\', '\\\\.\\pipe\\')); } catch {}
      srv.listen(this.videoPipe, () => this.emit('videoReady'));
      this._vidSrv = srv;
    });
  }

  async startVideo() {
    await this.openVideoPipe();
    // Decode H.264 → packed YUY2 (MEDIASUBTYPE_YUY2) so the DirectShow filter
    // can serve frames to apps with no further conversion.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 'h264', '-i', 'pipe:0',
      '-an', '-f', 'rawvideo', '-pix_fmt', 'yuyv420', 'pipe:1',
    ];
    this.vidProc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.vidProc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.emit('error', new Error('ffmpeg-video: ' + s)); });
    this.vidProc.on('error', (err) => this.emit('error', new Error('ffmpeg spawn: ' + err.message)));
    this.pumpVideo();
    return true;
  }

  /** Read rawvideo YUY2 frames of known size from ffmpeg stdout and write to pipe. */
  pumpVideo() {
    const frameSize = this.width * this.height * 2; // yuyv420 = 2 bytes/pixel
    let buf = Buffer.alloc(0);
    const hdr = Buffer.alloc(24); // VideoFrameHeader
    this.vidProc.stdout.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (buf.length >= frameSize) {
        const frame = buf.subarray(0, frameSize);
        buf = buf.subarray(frameSize);
        if (this.vidPipeStream) {
          hdr.writeUInt32LE(this.width, 0);
          hdr.writeUInt32LE(this.height, 4);
          hdr.writeUInt32LE(this.width * 2, 8); // pitch = width*2 for YUY2
          hdr.writeUInt32LE(0, 12); // flags
          hdr.writeBigUInt64LE(BigInt(Date.now()), 16);
          try { this.vidPipeStream.write(hdr); this.vidPipeStream.write(frame); } catch {}
        }
      }
    });
  }

  writeVideo(au) { if (this.vidProc && this.vidProc.stdin.writable) this.vidProc.stdin.write(au); }

  async startAudio() {
    const net = require('net');
    await new Promise((resolve) => {
      const srv = net.createServer((sock) => { this.audPipeStream = sock; sock.on('close', () => { this.audPipeStream = null; }); sock.on('error', () => {}); resolve(true); });
      srv.on('error', (err) => { this.emit('error', new Error('audio pipe: ' + err.message)); resolve(false); });
      srv.listen(this.audioPipe, () => this.emit('audioReady'));
      this._audSrv = srv;
    });
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'aac', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
    this.audProc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.audProc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.emit('error', new Error('ffmpeg-audio: ' + s)); });
    this.audProc.stdout.on('data', (chunk) => { if (this.audPipeStream) { try { this.audPipeStream.write(chunk); } catch {} } });
    return true;
  }

  writeAudio(adtsFrame) { if (this.audProc && this.audProc.stdin.writable) this.audProc.stdin.write(adtsFrame); }

  stopVideo() {
    if (this.vidProc) { try { this.vidProc.stdin.end(); } catch {} try { this.vidProc.kill(); } catch {} this.vidProc = null; }
    if (this.vidPipeStream) { try { this.vidPipeStream.end(); } catch {} this.vidPipeStream = null; }
    if (this._vidSrv) { try { this._vidSrv.close(); } catch {} this._vidSrv = null; }
  }
  stopAudio() {
    if (this.audProc) { try { this.audProc.stdin.end(); } catch {} try { this.audProc.kill(); } catch {} this.audProc = null; }
    if (this.audPipeStream) { try { this.audPipeStream.end(); } catch {} this.audPipeStream = null; }
    if (this._audSrv) { try { this._audSrv.close(); } catch {} this._audSrv = null; }
  }
  stop() { this.stopVideo(); this.stopAudio(); }
}

module.exports = { WindowsVirtualDevice };
