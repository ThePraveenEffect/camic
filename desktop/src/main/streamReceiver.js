'use strict';
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { MEDIA_PORT, TYPE_VIDEO, unpackHeader } = require('./protocol');
const { VideoReceiver } = require('./videoReceiver');
const { AudioReceiver } = require('./audioReceiver');

/**
 * Owns the single UDP socket on MEDIA_PORT and demuxes incoming datagrams to
 * the VideoReceiver / AudioReceiver by header type. Forwards their events.
 *
 * Emits: 'listening'(port), 'au'(au,isKey,ts), 'config'(spspps), 'audio'(adtsFrame),
 *        'videoStats'(s), 'audioStats'(s), 'error'(err)
 */
class StreamReceiver extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.video = new VideoReceiver(opts);
    this.audio = new AudioReceiver(opts);
    this.sock = null;
    this.port = opts.port || MEDIA_PORT;

    this.video.on('au', (au, isKey, ts) => this.emit('au', au, isKey, ts));
    this.video.on('config', (c) => this.emit('config', c));
    this.video.on('stats', (s) => this.emit('videoStats', s));
    this.video.on('truncated', () => this.emit('truncated'));
    this.audio.on('frame', (f) => this.emit('audio', f));
    this.audio.on('config', (c) => this.emit('audioConfig', c));
    this.audio.on('stats', (s) => this.emit('audioStats', s));
  }

  start() {
    this.video.reset(); this.audio.reset();
    this.video.startStats(); this.audio.startStats();
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg) => {
      if (this._firstLog !== true) {
        this._firstLog = true;
        const src = this.sock && this.lastAddr ? this.lastAddr : '?';
        console.log('[stream] first datagram: %d bytes from %s type=%d seq=%d', msg.length, src, msg.length > 1 ? msg.readUInt8(1) : -1, msg.length > 8 ? msg.readUInt32BE(4) : -1);
      }
      if (msg.length < 12) return;
      const type = msg.readUInt8(1);
      if (type === TYPE_VIDEO) this.video.handlePacket(msg);
      else this.audio.handlePacket(msg);
    });
    this.sock.on('error', (err) => this.emit('error', err));
    this.sock.bind(this.port, '0.0.0.0', () => this.emit('listening', this.sock.address().port));
  }

  stop() {
    this.video.stopStats(); this.audio.stopStats();
    this.video.reset(); this.audio.reset();
    if (this.sock) { try { this.sock.close(); } catch {} this.sock = null; }
  }

  configureAudio(cfg) { this.audio.configure(cfg); }
}

module.exports = { StreamReceiver };
