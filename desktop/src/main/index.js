'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
// White/black window on Fedora Wayland: Electron 33 defaults to X11 (XWayland)
// which fails to composite on some sessions. Native Wayland via ozone fixes it;
// on pure X11 sessions this flag is a no-op.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
const path = require('path');
const os = require('os');
const { Discovery } = require('./discovery');
const { ControlClient } = require('./controlClient');
const { StreamReceiver } = require('./streamReceiver');
const { createVirtualDevice } = require('./devices/virtualDevice');
const { PairStore } = require('./pairStore');
const { MEDIA_PORT } = require('./protocol');

let win = null;
let discovery = null;
let control = null;
let stream = null;
let vdev = null;
let pairStore = null;
const state = {
  connected: false,
  streaming: false,
  device: null,
  // Default to 1080p: at 720p small details (text on a card, a component) are
  // physically unresolvable even with perfect focus.
  settings: { w: 1920, h: 1080, fps: 30, bitrate: 6_000_000, audio: true, jitter: 2, videoDev: null },
};

function sendToRenderer(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 700, minWidth: 720, minHeight: 520,
    title: 'Camic',
    icon: path.join(__dirname, '../renderer/logo.png'),
    backgroundColor: '#0f1115',
    // Keep decoding/painting while the window is hidden. With throttling on
    // (the default), WebCodecs output stalls in the background and the whole
    // backlog flushes when you come back — which plays old frames at >1x
    // before catching up to live.
    webPreferences: { preload: path.join(__dirname, '../renderer/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.setMenuBarVisibility(false);
  win.on('closed', () => { win = null; });
}

function setupDiscovery() {
  if (discovery) { try { discovery.stop(); } catch {} }
  discovery = new Discovery();
  discovery.on('device', (dev) => sendToRenderer('device', dev));
  discovery.on('remove', (id) => sendToRenderer('device-remove', id));
  discovery.start();
}

function connectToDevice(dev, pin) {
  console.log(`[main] connect → ${dev.host}:${dev.port} pin=${pin}`);
  control = new ControlClient();
  // Reuse the persistent virtual device (created at startup) so OBS keeps the
  // same node names; only rebuild if it was never created.
  if (!vdev) {
    vdev = createVirtualDevice({ videoDev: state.settings.videoDev, size: { w: state.settings.w, h: state.settings.h, fps: state.settings.fps } });
    vdev.on('error', (err) => { console.error('[vdev] error:', err.message); sendToRenderer('log', { level: 'error', msg: err.message }); });
    vdev.on('videoReady', (d) => { console.log('[vdev] camera →', d); sendToRenderer('log', { level: 'info', msg: 'virtual camera → ' + d }); });
    vdev.on('audioReady', (s) => { console.log('[vdev] mic →', s); sendToRenderer('log', { level: 'info', msg: 'virtual mic → ' + s }); });
  }

  control.on('helloAck', (info) => {
    console.log('[main] helloAck paired id=%s name=%s', info.id, info.name);
    state.device = info;
    pairStore.trust(info.id, { name: info.name });
    pairStore.setLast({ host: dev.host, port: dev.port, id: info.id });
    sendToRenderer('helloAck', info);
    // auto-start stream with current settings
    const s = state.settings;
    control.start({
      video: { w: s.w, h: s.h, fps: s.fps, bitrate: s.bitrate },
      audio: s.audio ? { enabled: true, sampleRate: 48000, channels: 1, bitrate: 64000 } : { enabled: false },
    });
  });
  control.on('started', (info) => {
    console.log('[main] started', JSON.stringify(info));
    state.streaming = true;
    sendToRenderer('started', info);
    startStreamPipeline(info);
    // periodic keyframe + ping
    control._kfTimer = setInterval(() => { try { control.keyframe(); } catch {} }, 2000);
    control._pingTimer = setInterval(() => { try { control.ping(); } catch {} }, 2000);
  });
  control.on('stopped', () => { console.log('[main] stopped'); state.streaming = false; sendToRenderer('stopped'); stopStreamPipeline(); });
  control.on('status', (s) => sendToRenderer('phone-status', s));
  control.on('pong', (s) => sendToRenderer('pong', s));
  control.on('error', (err) => { console.error('[main] control error:', err.message); sendToRenderer('log', { level: 'error', msg: err.message }); });
  control.on('closed', (why) => { console.log('[main] connection closed:', why || ''); state.connected = false; state.streaming = false; stopStreamPipeline(); sendToRenderer('closed'); });

  control.connect({ host: dev.host, port: dev.port, pin });
  state.connected = true;
  state.device = { host: dev.host, name: dev.name };
}

function startStreamPipeline(startedInfo) {
  stream = new StreamReceiver({ port: MEDIA_PORT });
  stream.on('listening', (port) => { console.log('[main] listening for media on UDP :%d', port); sendToRenderer('log', { level: 'info', msg: `listening for media on UDP :${port}` }); });
  stream.on('au', (au, isKey, ts) => {
    vdev.writeVideo(au);
    sendToRenderer('video-au', { buf: au, isKey, ts });
  });
  // Standalone SPS/PPS config packet (if the phone sends one): feed it to the
  // decoder immediately so it can start before the first keyframe arrives.
  stream.on('config', (spspps) => { vdev.writeVideo(Buffer.from(spspps)); });
  // Bytes went missing mid-frame: that frame is dropped, but the rest of the
  // GOP still references it. Pull a keyframe immediately instead of waiting out
  // the 2s timer, so the camera picture resynchronises at once.
  stream.on('truncated', () => { if (state.streaming) { try { control && control.keyframe(); } catch {} } });
  stream.on('audio', (frame) => { vdev.writeAudio(frame); });
  // Loss feedback loop: report measured packet loss to the phone ~1 Hz so the
  // encoder can pull its bitrate below what the Wi-Fi link actually sustains.
  // Without this the phone blasts a fixed CBR rate and quality is locked bad.
  stream.on('videoStats', (s) => {
    if (s.fps > 0) console.log('[video] %d fps, %d Mbps, loss %d%%', s.fps.toFixed(1), (s.bitrate / 1e6).toFixed(2), s.lossPct.toFixed(1));
    if (s.truncated > 0) console.log('[video] dropped %d incomplete frame(s) rather than feed corrupt bytes to the camera', s.truncated);
    if (state.streaming && control) { try { control.netq(s.lossPct || 0); } catch {} }
    sendToRenderer('video-stats', s);
  });
  stream.on('audioStats', (s) => { if (s.frames > 0) console.log('[audio] frames=%d rate=%d', s.frames, s.sampleRate || ''); sendToRenderer('audio-stats', s); });
  stream.on('error', (err) => { console.error('[main] stream error:', err.message); sendToRenderer('log', { level: 'error', msg: 'stream: ' + err.message }); });
  if (startedInfo.video) vdev.startVideo();
  if (startedInfo.audio && startedInfo.audio.enabled) { stream.configureAudio(startedInfo.audio); vdev.startAudio(); }
  stream.start();
}

function stopStreamPipeline() {
  clearInterval(control && control._kfTimer); clearInterval(control && control._pingTimer);
  if (stream) { stream.stop(); stream = null; }
  // Stop only the live streams. Keep the persistent v4l2 writer + idle test
  // pattern alive so OBS never sees the device disappear or freeze. The writer
  // is only torn down on full app shutdown (vdev.stop()).
  if (vdev) { vdev.stopVideo(); vdev.stopAudio(); }
}

// ---- IPC from renderer ----
ipcMain.handle('discover-list', () => (discovery ? discovery.list() : []));
ipcMain.handle('rescan', () => {
  setupDiscovery();
  return discovery.list();
});
ipcMain.handle('connect', (e, { host, port, pin }) => {
  connectToDevice({ host, port }, pin || '000000');
  return true;
});
ipcMain.handle('disconnect', () => { if (control) control.disconnect(); stopStreamPipeline(); state.connected = false; state.streaming = false; return true; });
ipcMain.handle('stop-stream', () => { if (control) control.stop(); return true; });
ipcMain.handle('switch-camera', () => { if (control) control.switchCamera(); return true; });
ipcMain.handle('refocus', () => { if (control) control.refocus(); return true; });
ipcMain.handle('set-torch', (e, on) => { if (control) control.setTorch(on); return true; });
ipcMain.handle('get-settings', () => state.settings);
ipcMain.handle('set-settings', (e, s) => { Object.assign(state.settings, s); return state.settings; });
ipcMain.handle('trusted-list', () => pairStore.trustedList());

app.whenReady().then(() => {
  pairStore = new PairStore();
  createWindow();
  setupDiscovery();
  // Create the virtual devices up-front so OBS/browsers always see
  // "Camic Camera" + "Camic Mic" even before a phone connects.
  try {
    vdev = createVirtualDevice({ videoDev: state.settings.videoDev, size: { w: state.settings.w, h: state.settings.h, fps: state.settings.fps } });
    vdev.on('error', (err) => sendToRenderer('log', { level: 'error', msg: err.message }));
    vdev.on('videoReady', (d) => sendToRenderer('log', { level: 'info', msg: 'virtual camera → ' + d }));
    vdev.on('audioReady', (s) => sendToRenderer('log', { level: 'info', msg: 'virtual mic → ' + s }));
    if (typeof vdev.ensureAvailable === 'function') vdev.ensureAvailable();
  } catch (e) { console.error('[vdev] init failed:', e.message); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (discovery) discovery.stop();
  if (control) control.disconnect();
  stopStreamPipeline();
  if (process.platform !== 'darwin') app.quit();
});
