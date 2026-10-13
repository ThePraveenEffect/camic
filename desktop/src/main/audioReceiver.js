'use strict';
const { EventEmitter } = require('events');
const { HDR_SIZE, TYPE_AUDIO, FLAG_CONFIG, FLAG_EOF, unpackHeader, adtsHeader } = require('./protocol');

/**
 * Processes the audio half of the UDP stream. Wraps each raw AAC-LC AU in an
 * ADTS header (so ffmpeg's aac decoder can consume the stream without needing
 * the AudioSpecificConfig out-of-band) and emits ADTS frames.
 *
 * Emits:
 *   'frame'  (adtsFrame:Buffer)
 *   'config' (asc:Buffer)
 *   'stats'  ({bitrate})
 */
class AudioReceiver extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sampleRate = opts.sampleRate || 48000;
    this.channels = opts.channels || 1;
    this.expectedSeq = null;
    this.pending = new Map();
    this.bytes = 0;
    this.frames = 0;
    this.lastEmit = Date.now();
    this._statTimer = null;
  }
  startStats() { this._statTimer = setInterval(() => this.emitStats(), 1000); }
  stopStats() { clearInterval(this._statTimer); }

  configure({ sampleRate, channels }) {
    if (sampleRate) this.sampleRate = sampleRate;
    if (channels) this.channels = channels;
  }

  handlePacket(msg) {
    const h = unpackHeader(msg);
    if (!h || h.version !== 1 || h.type !== TYPE_AUDIO) return;
    const payload = msg.subarray(HDR_SIZE);
    this.bytes += msg.length;
    if (h.flags & FLAG_CONFIG) { this.emit('config', Buffer.from(payload)); return; }
    if (this.expectedSeq === null) this.expectedSeq = h.seq;
    this.pending.set(h.seq, payload);
    this.drain();
  }

  drain() {
    if (this.expectedSeq === null) return;
    let guard = 0;
    while (guard++ < 8192) {
      let payload = this.pending.get(this.expectedSeq);
      if (payload === undefined) {
        if (this.pending.size > 0) {
          const lowest = this.lowestPendingSeq();
          const fwd = (lowest - this.expectedSeq) >>> 0;
          if (fwd > 0 && fwd < 64) { this.expectedSeq = lowest; continue; }
        }
        break;
      }
      this.pending.delete(this.expectedSeq);
      this.expectedSeq = (this.expectedSeq + 1) >>> 0;
      const hdr = adtsHeader(this.sampleRate, this.channels, payload.length + 7);
      this.frames++;
      this.emit('frame', Buffer.concat([hdr, payload]));
    }
  }

  lowestPendingSeq() {
    let best = null, bestGap = Infinity;
    for (const seq of this.pending.keys()) {
      const gap = (seq - this.expectedSeq) >>> 0;
      if (gap < bestGap) { bestGap = gap; best = seq; }
    }
    return best === null ? this.expectedSeq : best;
  }

  reset() { this.expectedSeq = null; this.pending.clear(); }

  emitStats() {
    const now = Date.now();
    const dt = (now - this.lastEmit) / 1000;
    this.lastEmit = now;
    const bitrate = dt > 0 ? (this.bytes * 8) / dt : 0;
    this.emit('stats', { bitrate });
    this.bytes = 0;
  }
}

module.exports = { AudioReceiver };
