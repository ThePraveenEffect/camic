'use strict';
const net = require('net');
const { EventEmitter } = require('events');
const { CONTROL_PORT, PROTO_VER } = require('./protocol');

/**
 * TCP control client: connects to the phone's control server, performs the
 * hello/PIN handshake, sends start/stop/keyframe/torch commands, and receives
 * helloAck/started/status/pong. Newline-delimited JSON.
 *
 * Emits: 'connected', 'helloAck'(info), 'started'(info), 'stopped', 'status'(s),
 *        'pong'(s), 'error'(err), 'closed'
 */
class ControlClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.buf = '';
    this.authed = false;
    this.pendingStart = null;
  }

  connect({ host, port = CONTROL_PORT, pin, client = 'linux/1.0.0', wantVideo = true, wantAudio = true }) {
    this.disconnect();
    this.authed = false;
    this.buf = '';
    this.sock = net.createConnection({ host, port }, () => {
      this.send({ cmd: 'hello', v: PROTO_VER, pin: String(pin), client, wantVideo, wantAudio });
    });
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => this.onData(d));
    this.sock.on('error', (err) => this.emit('error', err));
    this.sock.on('close', () => { this.authed = false; this.emit('closed'); });
  }

  onData(data) {
    this.buf += data;
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handle(msg);
    }
  }

  handle(msg) {
    switch (msg.cmd) {
      case 'helloAck':
        this.authed = true;
        this.emit('helloAck', msg);
        if (this.pendingStart) { const s = this.pendingStart; this.pendingStart = null; this.start(s); }
        break;
      case 'started': this.emit('started', msg); break;
      case 'stopped': this.emit('stopped', msg); break;
      case 'status': this.emit('status', msg); break;
      case 'pong': this.emit('pong', msg); break;
      case 'error': this.emit('error', new Error(msg.code + (msg.message ? ': ' + msg.message : ''))); break;
      default: break;
    }
  }

  send(obj) {
    if (this.sock && !this.sock.destroyed) this.sock.write(JSON.stringify(obj) + '\n');
  }

  start(cfg) {
    if (!this.authed) { this.pendingStart = cfg; return; }
    this.send({ cmd: 'start', video: cfg.video, audio: cfg.audio });
  }
  stop() { this.send({ cmd: 'stop' }); }
  keyframe() { this.send({ cmd: 'keyframe' }); }
  switchCamera() { this.send({ cmd: 'switchCamera' }); }
  refocus() { this.send({ cmd: 'refocus' }); }
  /** Feed measured packet loss back to the phone so the encoder keeps quality
   *  within what the Wi-Fi link actually sustains (loss → lower bitrate). */
  netq(lossPct) { this.send({ cmd: 'netq', loss: lossPct }); }
  setTorch(on) { this.send({ cmd: 'setTorch', on: !!on }); }
  ping(t = Date.now()) { this.send({ cmd: 'ping', t }); }

  disconnect() {
    if (this.sock) { try { this.sock.destroy(); } catch {} this.sock = null; }
    this.authed = false;
  }
}

module.exports = { ControlClient };
