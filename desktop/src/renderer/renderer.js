'use strict';
/* Camic renderer: device list, connect flow, WebCodecs H.264 preview, stats. */

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

// ---- WebCodecs preview decoder ----
let decoder = null;
let decoderReady = false;      // have avcC/description
let avcC = null;               // AVCDecoderConfigurationRecord (Uint8Array)
let codecStr = null;
let configFrame = null;        // cached SPS/PPS AU to build config on reset
let lastFrameTs = 0;
let presentQueue = [];
let rendering = false;
let decEpoch = 0;                // bumped on teardown; invalidates in-flight frames
let newestTs = 0;                // newest media timestamp given to the decoder (ms)
const STALE_MS = 300;            // frames further behind than this are old video
const CLOCK_RESYNC_MS = 1000;    // bigger backward jump = phone restarted its clock

function ensureDecoder(sps, pps) {
  // Never leave an old decoder alive: its output callback stays registered and
  // would keep painting PREVIOUS frames into the canvas alongside the new
  // stream (which reads as ghosting / ~2x-speed playback).
  closeDecoder();
  avcC = window.H264.buildAvcC(sps, pps);
  codecStr = window.H264.codecStringFromSps(sps);
  const epoch = decEpoch;
  decoder = new VideoDecoder({
    output: (frame) => {
      // Frames emitted by a decoder we already tore down must never be drawn:
      // they belong to the previous session/config.
      if (epoch !== decEpoch) { try { frame.close(); } catch {} return; }
      onFrame(frame);
    },
    error: (e) => log('error', 'decoder: ' + e.message),
  });
  // WebCodecs wants the AVCDecoderConfigurationRecord as `description`, and then
  // length-prefixed (AVCC) access units as input. Coded size comes from the
  // stream; do NOT pass sps bytes as codedWidth.
  decoder.configure({
    codec: codecStr,
    description: avcC,
    optimizeForLatency: true,
  });
  decoderReady = true;
  log('info', 'decoder configured ' + codecStr);
}

function closeDecoder() {
  if (decoder) { try { decoder.close(); } catch {} decoder = null; }
  decoderReady = false;
  // Drop frames left over from the previous session so they can never be
  // drawn on top of the current live video.
  for (const f of presentQueue) { try { f.close(); } catch {} }
  presentQueue = [];
  lastFrameTs = 0;
  newestTs = 0;
}

function resetDecoder() {
  closeDecoder();
  avcC = null;
  codecStr = null;
  configFrame = null;
}

function onFrame(frame) {
  // Never replay video the stream has already moved past. While the window is
  // hidden (or after a stall) a backlog can flush all at once; those frames
  // carry old media timestamps, so discard them instead of fast-forwarding
  // through yesterday's frames on the way back to live.
  const tsMs = frame.timestamp / 1000;
  if (newestTs > 0 && tsMs > 0 && newestTs - tsMs > STALE_MS) {
    frame.close();
    return;
  }
  presentQueue.push(frame);
  pumpPresent();
}

async function pumpPresent() {
  if (rendering) return;
  rendering = true;
  while (presentQueue.length) {
    // Show only the CURRENT frame: discard everything older than the newest
    // one, so a burst (or frames left over from a previous session) can never
    // be replayed — that is what made the preview look like 2x-speed playback.
    while (presentQueue.length > 1) { const drop = presentQueue.shift(); drop.close(); }
    const frame = presentQueue.shift();
    if (!frame) break;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
    }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    lastFrameTs = performance.now();
    $('preview-empty').style.display = 'none';
  }
  rendering = false;
}

// ---- feed AUs from main ----
window.camic.on('video-au', ({ buf, isKey, ts }) => {
  // Media-clock high-water mark. The phone stamps packets with ms elapsed
  // since it opened its sender, so the value RESTARTS on every reconnect — a
  // large backward jump is a new clock, not a backlog, so resync instead of
  // treating every following frame as stale.
  if (ts > newestTs) newestTs = ts;
  else if (newestTs - ts > CLOCK_RESYNC_MS) newestTs = ts;
  const data = new Uint8Array(buf);
  if (isKey || !decoderReady) {
    const { sps, pps } = window.H264.extractSpsPps(data);
    if (sps && pps) {
      if (!decoderReady || changedConfig(sps, pps)) { resetDecoder(); ensureDecoder(sps, pps); }
    }
  }
  if (!decoderReady || !decoder || decoder.state === 'unconfigured') return;
  // Convert Annex-B AU → AVCC (length-prefixed), dropping config NALs (they are
  // in the description). WebCodecs requires AVCC input when description is set.
  const avcc = window.H264.annexBToAvcc(data, /*dropConfig*/ true);
  if (!avcc.length) return;
  const chunk = new EncodedVideoChunk({
    type: isKey ? 'key' : 'delta',
    timestamp: ts * 1000, // µs
    data: avcc,
  });
  try { decoder.decode(chunk); } catch (e) { /* drop on decoder backpressure */ }
});

function changedConfig(sps, pps) {
  if (!avcC) return true;
  const next = window.H264.buildAvcC(sps, pps);
  if (next.length !== avcC.length) return true;
  for (let i = 0; i < next.length; i++) if (next[i] !== avcC[i]) return true;
  return false;
}

// ---- device list ----
const devices = new Map();
function renderDevices() {
  const ul = $('device-list');
  if (devices.size === 0) { ul.innerHTML = '<li class="empty">No phones found. Open Camic on your phone.</li>'; return; }
  ul.innerHTML = '';
  for (const dev of devices.values()) {
    const li = document.createElement('li');
    li.className = 'device';
    li.innerHTML = `<div class="dev-name">${escapeHtml(dev.name || 'Phone')}</div><div class="dev-addr">${escapeHtml(dev.host)}:${dev.port}</div>`;
    const btn = document.createElement('button');
    btn.className = 'primary'; btn.textContent = 'Connect';
    btn.onclick = () => promptAndConnect(dev);
    li.appendChild(btn);
    ul.appendChild(li);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- PIN modal (window.prompt is unsupported in Electron) ----
let _pinResolve = null;
function askPin(devName) {
  return new Promise((resolve) => {
    _pinResolve = resolve;
    $('pin-modal-desc').textContent = `Enter the 6-digit PIN shown on "${devName || 'your phone'}".`;
    const input = $('pin-input');
    input.value = '';
    $('pin-modal').classList.remove('hidden');
    setTimeout(() => input.focus(), 30);
  });
}
function closePin(value) {
  $('pin-modal').classList.add('hidden');
  if (_pinResolve) { _pinResolve(value); _pinResolve = null; }
}
$('pin-ok').onclick = () => { const v = $('pin-input').value.trim(); if (v) closePin(v); };
$('pin-cancel').onclick = () => closePin(null);
$('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const v = $('pin-input').value.trim(); if (v) closePin(v); }
  if (e.key === 'Escape') closePin(null);
});

async function promptAndConnect(dev) {
  const pin = await askPin(dev.name);
  if (pin === null) return;
  log('info', `connecting to ${dev.name || dev.host}…`);
  setButtonsBusy(true); setStatus('connecting', `Connecting to ${dev.name || 'phone'}…`);
  await window.camic.connect({ host: dev.host, port: dev.port, pin });
}

window.camic.on('device', (dev) => { devices.set(dev.id, dev); renderDevices(); });
window.camic.on('device-remove', (id) => { devices.delete(id); renderDevices(); });

// ---- lifecycle events ----
window.camic.on('helloAck', (info) => {
  log('info', `paired with ${info.name} (${info.id})`);
  setConnected(true);
  setButtonsBusy(false);
  setStatus('connected', `Paired · ${info.name || 'phone'}`);
});
window.camic.on('started', (info) => {
  log('info', `streaming ${info.video.w}×${info.video.h}@${info.video.fps}`);
  $('badge').classList.remove('hidden'); $('b-disconnect').disabled = false;
  setButtonsBusy(false);
  setStatus('connected', `${info.video.w}×${info.video.h} · ${info.video.fps} fps`);
});
window.camic.on('stopped', () => {
  log('info', 'stream stopped'); $('badge').classList.add('hidden');
  setStatus('connected', 'Connected (not streaming)');
});
window.camic.on('closed', () => {
  log('warn', 'connection closed');
  setConnected(false);
  setButtonsBusy(false);
  setStatus('idle', 'Not connected');
});
window.camic.on('phone-status', (s) => { $('st-p').textContent = `${s.battery ?? '—'}% ${s.temp ?? ''}°`; });
window.camic.on('video-stats', (s) => {
  $('st-v').textContent = `${s.fps.toFixed(1)} fps`;
  $('st-b').textContent = `${(s.bitrate / 1e6).toFixed(2)} Mbps`;
  $('st-l').textContent = `${s.lossPct.toFixed(1)}%`;
});
window.camic.on('audio-stats', () => {});
window.camic.on('log', (l) => {
  log(l.level, l.msg);
  // surface a failed handshake (bad PIN / unreachable phone) on the status pill
  if (l.level === 'error' && $('conn-state').classList.contains('connecting')) {
    setButtonsBusy(false);
    setStatus('error', 'Connection failed');
  }
});

// connection status pill: idle | connecting | connected | error
function setStatus(kind, text) {
  const el = $('conn-state');
  el.className = 'conn-state ' + kind;
  el.querySelector('span').textContent = text;
}

// avoid double-clicking Connect while a handshake is in flight
function setButtonsBusy(busy) {
  $('m-connect').disabled = busy;
  $('rescan').disabled = busy;
}

function showPreviewEmpty(on) {
  $('preview-empty').style.display = on ? '' : 'none';
  if (on) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function setConnected(on) {
  $('b-disconnect').disabled = !on;
  if (!on) {
    $('badge').classList.add('hidden');
    resetDecoder();
    showPreviewEmpty(true);   // drop the stale last frame
    setButtonsBusy(false);
  }
}

// latency estimate: time since last decoded frame presented
setInterval(() => {
  if (!decoderReady || !lastFrameTs) { $('st-lat').textContent = '—'; return; }
  const age = performance.now() - lastFrameTs;
  $('st-lat').textContent = age < 500 ? 'live' : `${(age / 1000).toFixed(1)}s stale`;
}, 500);

// ping RTT
let pingSent = 0;

// ---- controls ----
$('rescan').onclick = async () => {
  log('info', 'rescanning…');
  devices.clear(); renderDevices();
  const list = await window.camic.rescan();
  list.forEach((d) => devices.set(d.id, d)); renderDevices();
};
$('m-connect').onclick = async () => {
  const host = $('m-ip').value.trim(); const pin = $('m-pin').value.trim() || '000000';
  if (!host) { log('warn', 'enter phone IP'); return; }
  setButtonsBusy(true); setStatus('connecting', 'Connecting…');
  await window.camic.connect({ host, port: 4747, pin });
};
$('b-disconnect').onclick = async () => {
  await window.camic.disconnect();
  setConnected(false);
  setStatus('idle', 'Not connected');
};
$('b-switch').onclick = () => window.camic.switchCamera();
let torchOn = false;
$('b-torch').onclick = () => { torchOn = !torchOn; window.camic.setTorch(torchOn); };
$('s-res').onchange = applySettings;
$('s-fps').onchange = applySettings;
$('s-audio').onchange = applySettings;
$('s-jitter').onchange = applySettings;
async function applySettings() {
  const [w, h] = $('s-res').value.split('x').map(Number);
  const fps = Number($('s-fps').value);
  const audio = $('s-audio').checked;
  await window.camic.setSettings({ w, h, fps, audio });
  log('info', `settings → ${w}×${h}@${fps} audio=${audio} (take effect on next connect)`);
}

// ---- log ----
function log(level, msg) {
  const body = $('log-body');
  const line = document.createElement('div');
  line.className = 'log-line ' + level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 200) body.removeChild(body.firstChild);
}

// init
(async () => { const list = await window.camic.discoverList(); list.forEach((d) => devices.set(d.id, d)); renderDevices(); })();
