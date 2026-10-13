'use strict';
const { EventEmitter } = require('events');
const { HDR_SIZE, TYPE_VIDEO, FLAG_KEYFRAME, FLAG_EOF, FLAG_CONFIG, unpackHeader } = require('./protocol');

/**
 * Processes the video half of the UDP stream. Does NOT own a socket —
 * StreamReceiver demuxes and calls handlePacket(). Reassembles fragmented
 * access units, applies in-order consumption with gap-skip, emits AUs.
 *
 * Emits:
 *   'au'        (au:Buffer, isKey:boolean, ts:number)
 *   'config'    (spspps:Buffer)
 *   'stats'     ({lossPct, fps, bitrate})
 */
class VideoReceiver extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.jitterFrames = opts.jitterFrames ?? 2;
    this.expectedSeq = null;
    this.pending = new Map(); // seq -> {h, payload}
    this.partialAU = [];
    this.partialKey = false;
    this.stats = { received: 0, lost: 0, bytes: 0, frames: 0, keyframes: 0, truncated: 0 };
    this.discardUntilEof = false;
    this.lastEmit = Date.now();
    this._statTimer = null;
  }

  startStats() { this._statTimer = setInterval(() => this.emitStats(), 1000); }
  stopStats() { clearInterval(this._statTimer); }

  setJitter(n) { this.jitterFrames = Math.max(1, Math.min(5, n | 0)); }

  handlePacket(msg) {
    const h = unpackHeader(msg);
    if (!h || h.version !== 1 || h.type !== TYPE_VIDEO) return;
    const payload = msg.subarray(HDR_SIZE);
    this.stats.received++;
    this.stats.bytes += msg.length;
    // Config packets consume a sequence number on the phone (`_seq[typeVideo]`
    // is bumped for them too), so they must be consumed in order like media
    // packets. Returning early made every config look like a lost packet.
    if (this.expectedSeq === null) this.expectedSeq = h.seq; // first media packet seeds the cursor
    this.pending.set(h.seq, { h, payload });
    this.drain();
  }

  /** Pull in-order AUs from pending, reassemble fragments, apply jitter, emit. */
  drain() {
    if (this.expectedSeq === null) return;
    let guard = 0;
    while (guard++ < 8192) {
      let pkt = this.pending.get(this.expectedSeq);
      if (!pkt) {
        // Gap: if higher seqs are waiting, and we've waited, skip ahead to the lowest pending.
        if (this.pending.size > 0) {
          const lowest = this.lowestPendingSeq();
          const fwd = (lowest - this.expectedSeq) >>> 0;
          // only skip if the gap is real (we won't get expectedSeq) — bounded window
          if (fwd > 0 && fwd < 64) {
            // count lost, resync to lowest
            this.stats.lost += fwd;
            this.expectedSeq = lowest;
            // Anything still pending behind the new cursor can never be consumed.
            for (const seq of this.pending.keys()) {
              const behind = (this.expectedSeq - seq) >>> 0;
              if (behind > 0 && behind < 0x80000000) this.pending.delete(seq);
            }
            if (this.partialAU.length > 0) {
              // The frame in progress just lost bytes in the middle. Emitting it
              // would hand the decoder an AU with a hole, which reads as garbage
              // ("cbp too large", "P sub_mb_type out of range"). Drop its head
              // and swallow the remainder up to its EOF so the next AU starts
              // on a clean boundary.
              this.stats.truncated++;
              this.discardUntilEof = true;
              this.partialAU = [];
              this.partialKey = false;
              this.emit('truncated');
            }
            continue;
          }
        }
        break; // nothing contiguous available
      }
      this.pending.delete(this.expectedSeq);
      this.expectedSeq = (this.expectedSeq + 1) >>> 0;
      if (pkt.h.flags & FLAG_CONFIG) {
        // SPS/PPS carries no frame data. Emit it, but never let it touch the AU
        // being assembled (config also carries FLAG_KEYFRAME, which must not
        // promote the following frame).
        this.emit('config', Buffer.from(pkt.payload));
        continue;
      }
      if (this.discardUntilEof) {
        if (pkt.h.flags & FLAG_EOF) {
          this.discardUntilEof = false;
          this.partialAU = [];
          this.partialKey = false;
        }
        continue;
      }
      this.partialAU.push(pkt.payload);
      if (pkt.h.flags & FLAG_KEYFRAME) this.partialKey = true;
      if (pkt.h.flags & FLAG_EOF) {
        const au = Buffer.concat(this.partialAU);
        const isKey = this.partialKey;
        this.partialAU = [];
        this.partialKey = false;
        this.stats.frames++;
        if (isKey) this.stats.keyframes++;
        this.emit('au', au, isKey, pkt.h.timestamp);
      }
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

  /** Reset stream state (call on start/keyframe resync). */
  reset() {
    this.expectedSeq = null;
    this.pending.clear();
    this.partialAU = [];
    this.partialKey = false;
    this.discardUntilEof = false;
  }

  emitStats() {
    const now = Date.now();
    const dt = (now - this.lastEmit) / 1000;
    this.lastEmit = now;
    const fps = dt > 0 ? this.stats.frames / dt : 0;
    const bitrate = dt > 0 ? (this.stats.bytes * 8) / dt : 0;
    const total = this.stats.received + this.stats.lost;
    const lossPct = total > 0 ? (this.stats.lost / total) * 100 : 0;
    this.emit('stats', { fps, bitrate, lossPct, truncated: this.stats.truncated, frames: this.stats.frames, keyframes: this.stats.keyframes });
    this.stats.frames = 0; this.stats.bytes = 0; this.stats.received = 0; this.stats.lost = 0; this.stats.truncated = 0;
  }
}

module.exports = { VideoReceiver };
