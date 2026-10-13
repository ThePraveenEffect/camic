#!/usr/bin/env node
/**
 * Camic fake-phone test harness.
 *
 * Implements the phone side of protocol v1 against a real Camic desktop
 * receiver, using synthetic video (ffmpeg testsrc) and a tone for audio so the
 * entire desktop path can be developed and verified without a physical phone.
 *
 * Usage:
 *   node fake-phone.js --desktop 192.168.1.6        # stream to a receiver
 *   node fake-phone.js --selftest                    # run protocol unit checks
 *   node fake-phone.js --desktop IP --w 1280 --h 720 --fps 30 --bitrate 4M
 */
'use strict';

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const PROTO_VER = 1;
const CONTROL_PORT = 4747;
const MEDIA_PORT = 4748;
const MTU = 1400;
const HDR_SIZE = 12;

const TYPE_VIDEO = 0;
const TYPE_AUDIO = 1;
const FLAG_KEYFRAME = 1 << 0;
const FLAG_EOF = 1 << 1;
const FLAG_CONFIG = 1 << 2;

// ---------- args ----------
function parseArgs(argv) {
  const a = { desktop: null, w: 1280, h: 720, fps: 30, bitrate: 4_000_000, selftest: false, pin: '000000', name: 'FakePhone' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--selftest') a.selftest = true;
    else if (k === '--desktop') a.desktop = argv[++i];
    else if (k === '--w') a.w = parseInt(argv[++i], 10);
    else if (k === '--h') a.h = parseInt(argv[++i], 10);
    else if (k === '--fps') a.fps = parseInt(argv[++i], 10);
    else if (k === '--bitrate') a.bitrate = parseBitrate(argv[++i]);
    else if (k === '--pin') a.pin = argv[++i];
    else if (k === '--name') a.name = argv[++i];
  }
  return a;
}
function parseBitrate(s) {
  if (typeof s === 'number') return s;
  const m = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(String(s));
  if (!m) return 4_000_000;
  const n = parseFloat(m[1]);
  return Math.round(n * (m[2] ? { k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]] : 1));
}

// ---------- protocol header ----------
function packHeader(type, flags, seq, ts) {
  const buf = Buffer.alloc(HDR_SIZE);
  buf.writeUInt8(PROTO_VER, 0);
  buf.writeUInt8(type, 1);
  buf.writeUInt8(flags, 2);
  buf.writeUInt8(0, 3);
  buf.writeUInt32BE(seq >>> 0, 4);
  buf.writeUInt32BE(ts >>> 0, 8);
  return buf;
}
function unpackHeader(buf) {
  if (buf.length < HDR_SIZE) return null;
  return {
    version: buf.readUInt8(0), type: buf.readUInt8(1), flags: buf.readUInt8(2),
    seq: buf.readUInt32BE(4), timestamp: buf.readUInt32BE(8),
  };
}

// ---------- annex-b splitter ----------
/** Find start-code positions in buf: returns [{pos, scLen}] for each 00 00 01 / 00 00 00 01. */
function findStartCodes(buf) {
  const out = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) { out.push({ pos: i, scLen: 3 }); i += 2; }
      else if (buf[i + 2] === 0 && buf[i + 3] === 1) { out.push({ pos: i, scLen: 4 }); i += 3; }
    }
  }
  return out;
}
/** Split an Annex-B byte stream into NAL units (each still includes its start code). */
function splitAnnexB(buf) {
  const scs = findStartCodes(buf);
  if (scs.length === 0) return [];
  const nals = [];
  for (let k = 0; k < scs.length; k++) {
    const start = scs[k].pos;
    const end = k + 1 < scs.length ? scs[k + 1].pos : buf.length;
    const nal = buf.subarray(start, end);
    if (nal.length > scs[k].scLen) nals.push(nal);
  }
  return nals;
}
function nalType(nal) {
  let off = 0;
  if (nal[2] === 1) off = 3; else if (nal[2] === 0 && nal[3] === 1) off = 4; else return -1;
  if (off >= nal.length) return -1;
  return nal[off] & 0x1f;
}

// ---------- packetizer ----------
class Packetizer {
  constructor(sock, destPort) {
    this.sock = sock;
    this.destPort = destPort;
    this.seq = { [TYPE_VIDEO]: 0, [TYPE_AUDIO]: 0 };
    this.start = Date.now();
  }
  ts() { return Date.now() - this.start; }
  sendPacket(type, flags, payload) {
    const seq = this.seq[type]++;
    const hdr = packHeader(type, flags, seq, this.ts());
    const pkt = Buffer.concat([hdr, payload]);
    this.sock.send(pkt, this.destPort, this.destIp);
  }
  /** Fragment an access unit into MTU-sized packets, last one flagged EOF. */
  sendVideoAU(au, keyframe) {
    let off = 0;
    const firstFlags = keyframe ? FLAG_KEYFRAME : 0;
    if (au.length <= MTU) {
      this.sendPacket(TYPE_VIDEO, firstFlags | FLAG_EOF, au);
      return 1;
    }
    let sent = 0;
    while (off < au.length) {
      const end = Math.min(off + MTU, au.length);
      const flags = (off === 0 ? firstFlags : 0) | (end === au.length ? FLAG_EOF : 0);
      this.sendPacket(TYPE_VIDEO, flags, au.subarray(off, end));
      off = end;
      sent++;
    }
    return sent;
  }
  sendConfig(payload) {
    this.sendPacket(TYPE_VIDEO, FLAG_KEYFRAME | FLAG_CONFIG, payload);
  }
  sendAudio(frame) {
    this.sendPacket(TYPE_AUDIO, FLAG_EOF, frame);
  }
}

// ---------- synthetic media via ffmpeg ----------
/**
 * Spawn ffmpeg producing Annex-B H.264 (libopenh264 or libx264) from testsrc.
 * Returns an object emitting 'au' (Buffer annexb, isKey) events.
 */
function startFakeVideo(opts) {
  const { w, h, fps, bitrate } = opts;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`,
    '-t', '3600',
    '-c:v', pickVideoEnc(), '-b:v', String(bitrate), '-g', String(fps * 2),
    '-bf', '0', '-f', 'h264', 'pipe:1',
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const em = new (require('events').EventEmitter)();
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Emit complete AUs. An AU boundary is: a new frame-start NAL (SPS=7/IDR=5/non-IDR=1)
    // arriving while we already have a VCL NAL pending. Everything up to that boundary is flushed.
    const scs = findStartCodes(buf);
    if (scs.length === 0) return;
    let auStartOff = scs[0].pos;
    let sawVcl = false;
    let flushAt = null; // byte offset where the *next* AU begins
    for (let k = 0; k < scs.length; k++) {
      const { pos, scLen } = scs[k];
      const nalEnd = k + 1 < scs.length ? scs[k + 1].pos : buf.length;
      const t = nalType(buf.subarray(pos, nalEnd));
      const startsFrame = t === 7 || t === 5 || t === 1;
      if (k === 0) { sawVcl = (t === 1 || t === 5); continue; }
      if (sawVcl && startsFrame) { flushAt = pos; break; }
      if (t === 1 || t === 5) sawVcl = true;
    }
    if (flushAt !== null && flushAt > auStartOff) {
      const au = buf.subarray(auStartOff, flushAt);
      // detect keyframe: contains IDR(5) or SPS(7)
      let isKey = false;
      for (const n of splitAnnexB(au)) { const t = nalType(n); if (t === 5 || t === 7) { isKey = true; break; } }
      em.emit('au', Buffer.from(au), isKey);
      buf = buf.subarray(flushAt);
    }
    // safety: avoid unbounded growth if stream malformed
    if (buf.length > 8 * 1024 * 1024) buf = buf.subarray(buf.length - 1024 * 1024);
  });
  ff.on('exit', (code) => em.emit('exit', code));
  em.proc = ff;
  return em;
}
function pickVideoEnc() {
  // prefer libx264 (static ffmpeg builds), fall back to libopenh264
  return process.env.CB_VIDEO_ENC || 'libx264';
}

function startFakeAudio(opts) {
  const { sampleRate = 48000, bitrate = 64000 } = opts;
  // AAC via ffmpeg: sine tone, ADTS-less m4a? we want raw AAC frames. Use -f adts and strip 7-byte headers per frame,
  // or use mpeg4audio payload. Simplest for harness: -f adts and strip header per 1024-sample frame.
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sampleRate}`,
    '-t', '3600', '-c:a', 'aac', '-b:a', String(bitrate), '-ac', '1',
    '-f', 'adts', 'pipe:1',
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const em = new (require('events').EventEmitter)();
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // ADTS frames: sync 0xFFF, parse length, strip 7-byte header → raw AAC AU
    let off = 0;
    while (off + 7 <= buf.length) {
      if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) { off++; continue; }
      const fl = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] & 0xe0) >> 5);
      if (fl < 7 || off + fl > buf.length) break;
      em.emit('frame', buf.subarray(off + 7, off + fl));
      off += fl;
    }
    buf = buf.subarray(off);
  });
  ff.on('exit', (code) => em.emit('exit', code));
  em.proc = ff;
  return em;
}

// ---------- phone control server ----------
class FakePhone {
  constructor(opts) {
    this.opts = opts;
    this.id = 'f' + require('crypto').randomBytes(8).toString('hex');
    this.trusted = new Set(); // paired desktop ids
    this.paired = false;
    this.clients = new Set();
    this.streaming = false;
    this.currentCam = 0;
    this.torch = false;
  }

  startMdns() {
    // best-effort mDNS advertise via dns-sd if present, else skip (manual IP used by harness)
    // For the harness we rely on --desktop manual connect; mDNS is implemented in the mobile app.
  }

  startControl() {
    this.server = net.createServer((sock) => this.onConnection(sock));
    this.server.listen(CONTROL_PORT, '0.0.0.0', () => {
      console.log(`[fake-phone] control listening on :${CONTROL_PORT}`);
    });
  }

  onConnection(sock) {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    console.log(`[fake-phone] desktop connected ${peer}`);
    let buf = '';
    let authed = false;
    const authTimer = setTimeout(() => { if (!authed) sock.destroy(); }, 3000);
    sock.setEncoding('utf8');
    sock.on('data', (data) => {
      buf += data;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) {
          if (msg.cmd !== 'hello') { sock.write(JSON.stringify({ cmd: 'error', code: 'no_hello' }) + '\n'); sock.destroy(); return; }
          if (String(msg.pin) !== String(this.opts.pin)) {
            console.log(`[fake-phone] bad pin from ${peer}`);
            sock.write(JSON.stringify({ cmd: 'error', code: 'bad_pin', message: 'Incorrect PIN' }) + '\n');
            sock.destroy(); return;
          }
          authed = true;
          this.clients.add(sock);
          sock.write(JSON.stringify({
            cmd: 'helloAck', v: PROTO_VER, id: this.id, name: this.opts.name,
            battery: 87, temp: 30.1,
            cameras: [
              { id: 0, name: 'Back', facing: 'back', res: [[this.opts.w, this.opts.h], [640, 480]] },
              { id: 1, name: 'Front', facing: 'front', res: [[640, 480]] },
            ],
          }) + '\n');
          console.log(`[fake-phone] authenticated ${peer}`);
          continue;
        }
        this.handleCommand(msg, sock);
      }
    });
    sock.on('close', () => { clearTimeout(authTimer); this.clients.delete(sock); if (this.clients.size === 0) this.stopStream(); });
    sock.on('error', () => {});
  }

  handleCommand(msg, sock) {
    switch (msg.cmd) {
      case 'start': return this.startStream(msg, sock);
      case 'stop': return this.stopStream();
      case 'keyframe': return this.forceKeyframe();
      case 'switchCamera': this.currentCam ^= 1; console.log(`[fake-phone] switchCamera -> ${this.currentCam}`); return;
      case 'setTorch': this.torch = !!msg.on; console.log(`[fake-phone] torch=${this.torch}`); return;
      case 'ping': return sock.write(JSON.stringify({ cmd: 'pong', t: msg.t, lt: Date.now() }) + '\n');
      default: return; // ignore unknown
    }
  }

  startStream(msg, sock) {
    this.stopStream();
    const v = msg.video || {};
    const a = msg.audio || {};
    const w = v.w || this.opts.w, h = v.h || this.opts.h;
    const fps = v.fps || this.opts.fps, bitrate = v.bitrate || this.opts.bitrate;
    const desktopIp = sock.remoteAddress.replace('::ffff:', '');
    console.log(`[fake-phone] start ${w}x${h}@${fps} ${bitrate}bps -> ${desktopIp}:${MEDIA_PORT}`);

    this.mediaSock = dgram.createSocket('udp4');
    this.pkt = new Packetizer(this.mediaSock, MEDIA_PORT);
    this.pkt.destIp = desktopIp;

    // CONFIG: h264 SPS/PPS — emitted from first keyframe path; we also emit a standalone config on start.
    // We'll capture SPS/PPS from the first AU that contains them and re-send as CONFIG every 2s.
    let cachedConfig = null;

    this.video = startFakeVideo({ w, h, fps, bitrate });
    this.video.on('au', (au, isKey) => {
      if (!this.streaming) return;
      if (isKey) {
        // extract SPS/PPS for config resend
        const nals = splitAnnexB(au);
        const cfgNals = nals.filter((n) => { const t = nalType(n); return t === 7 || t === 8; });
        if (cfgNals.length) cachedConfig = Buffer.concat(cfgNals);
      }
      this.pkt.sendVideoAU(au, isKey);
    });
    this.video.on('exit', (code) => console.log(`[fake-phone] ffmpeg video exited ${code}`));

    if (a.enabled !== false) {
      this.audio = startFakeAudio({ sampleRate: a.sampleRate || 48000, bitrate: a.bitrate || 64000 });
      // AudioSpecificConfig for AAC-LC 48k mono: 0x11 0x90 (objectType=2, sfIndex=3, channels=1)
      const asc = Buffer.from([0x12, 0x08]); // AAC-LC, 24000? compute properly below
      // sfIndex for 48000 = 3 → bits 00011; objectType 2 (LC); channelConfig 1
      // 5 bits obj(2)=00010, 4 bits sf(3)=0011, 4 bits ch(1)=0001 → 00010 0011 0001 x → 0x12 0x10 for LC/48k/mono:
      // Actually: obj=2 → 00010; sf=3 → 0011; ch=1 → 0001 → 00010 0011 0001 = 0x11 0x90 (with 0 pad) → bytes 0x11 0x90? 00010001 10010000 = 0x11 0x90 yes.
      const ascLC48kMono = Buffer.from([0x11, 0x90]);
      this.pkt.sendConfig(ascLC48kMono); // note: sent as VIDEO CONFIG type in v1; audio config rides in started.audio + first frame path
      this.audio.on('frame', (fr) => { if (this.streaming) this.pkt.sendAudio(fr); });
      this.audio.on('exit', (code) => console.log(`[fake-phone] ffmpeg audio exited ${code}`));
    }

    this.streaming = true;
    // periodic status + config resend
    this.statusTimer = setInterval(() => {
      const st = { cmd: 'status', fps: fps, bitrate: bitrate, battery: 86, temp: 31, lossPct: 0 };
      for (const c of this.clients) c.write(JSON.stringify(st) + '\n');
      if (cachedConfig) this.pkt.sendConfig(cachedConfig);
    }, 1000);

    sock.write(JSON.stringify({
      cmd: 'started',
      video: { w, h, fps, codec: 'h264' },
      audio: a.enabled === false ? { enabled: false } : { enabled: true, sampleRate: a.sampleRate || 48000, channels: 1, codec: 'aac' },
    }) + '\n');
  }

  forceKeyframe() { /* libopenh264 in this harness has no in-band IDR request; real phone uses MediaCodec REQUEST_KEY_FRAME */ }

  stopStream() {
    if (!this.streaming) return;
    this.streaming = false;
    clearInterval(this.statusTimer);
    try { this.video && this.video.proc.kill(); } catch {}
    try { this.audio && this.audio.proc.kill(); } catch {}
    try { this.mediaSock && this.mediaSock.close(); } catch {}
    console.log('[fake-phone] stream stopped');
    for (const c of this.clients) c.write(JSON.stringify({ cmd: 'stopped' }) + '\n');
  }
}

// ---------- self test ----------
function selfTest() {
  console.log('[selftest] header pack/unpack');
  const h = packHeader(TYPE_VIDEO, FLAG_KEYFRAME | FLAG_EOF, 12345, 999);
  const u = unpackHeader(h);
  assertEq(u.version, 1); assertEq(u.type, TYPE_VIDEO);
  assertEq(u.flags, FLAG_KEYFRAME | FLAG_EOF); assertEq(u.seq, 12345); assertEq(u.timestamp, 999);

  console.log('[selftest] annex-b splitter');
  const nal1 = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e]);
  const nal2 = Buffer.from([0, 0, 1, 0x68, 0xce, 0x38, 0x80]);
  const nal3 = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33]);
  const stream = Buffer.concat([nal1, nal2, nal3]);
  const nals = splitAnnexB(stream);
  assertEq(nals.length, 3);
  assertEq(nalType(nals[0]), 7); assertEq(nalType(nals[1]), 8); assertEq(nalType(nals[2]), 5);

  console.log('[selftest] packetizer fragmentation');
  const sent = [];
  const fakeSock = { send: (buf) => sent.push(Buffer.from(buf)) };
  const pk = new Packetizer(fakeSock, MEDIA_PORT);
  pk.destIp = '127.0.0.1';
  const bigAU = Buffer.alloc(5000, 0xaa);
  pk.sendVideoAU(bigAU, true);
  assertEq(sent.length, Math.ceil(5000 / MTU));
  const last = unpackHeader(sent[sent.length - 1]);
  assertEq(last.flags & FLAG_EOF, FLAG_EOF);
  const first = unpackHeader(sent[0]);
  assertEq(first.flags & FLAG_KEYFRAME, FLAG_KEYFRAME);
  // reassemble
  const re = Buffer.concat(sent.map((p) => p.subarray(HDR_SIZE)));
  assertEq(re.length, 5000); assertEq(re[0], 0xaa);

  console.log('[selftest] ADTS parse');
  // build fake ADTS frame: aac_frame_length=14 (7 hdr + 7 payload)
  // fl = ((byte3&3)<<11)|(byte4<<3)|((byte5&0xe0)>>5); for 14: byte3low2=0, byte4=1, byte5top3=6
  const adts = Buffer.alloc(14);
  adts[0] = 0xff; adts[1] = 0xf1; adts[2] = 0x50; adts[3] = 0x40; adts[4] = 0x01; adts[5] = 0xdf; adts[6] = 0xfc;
  const fl = ((adts[3] & 0x03) << 11) | (adts[4] << 3) | ((adts[5] & 0xe0) >> 5);
  assertEq(fl, 14);

  console.log('[selftest] all passed');
}
function assertEq(a, b) { if (a !== b) { console.error(`ASSERT FAIL: ${a} !== ${b}`); process.exit(1); } }

// ---------- main ----------
const opts = parseArgs(process.argv);
if (opts.selftest) { selfTest(); process.exit(0); }
if (!opts.desktop) {
  console.error('usage: node fake-phone.js --desktop <receiver-ip> [--pin 000000] [--w 1280 --h 720 --fps 30 --bitrate 4M]');
  process.exit(1);
}
const phone = new FakePhone(opts);
phone.startControl();
console.log(`[fake-phone] id=${phone.id} name=${opts.name} pin=${opts.pin} -> will stream to ${opts.desktop}:${MEDIA_PORT}`);
console.log('[fake-phone] waiting for desktop to connect on TCP 4747 ...');
