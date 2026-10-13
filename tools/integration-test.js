'use strict';
/**
 * Headless integration test: drives the desktop receive path against fake-phone
 * with no GUI. Verifies control handshake, video AU reception (keyframes +
 * config), and audio ADTS frames. Exercises the real protocol modules.
 *
 * Run:  node tools/integration-test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const { ControlClient } = require('../desktop/src/main/controlClient');
const { StreamReceiver } = require('../desktop/src/main/streamReceiver');

const FAKE_PHONE = path.join(__dirname, 'fake-phone', 'fake-phone.js');
const PIN = '123456';
const LOCAL_IP = firstLocalIPv4();

function firstLocalIPv4() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('  ok:', msg); }

async function main() {
  console.log('local ip:', LOCAL_IP);

  // 1. start fake-phone
  const fp = spawn('node', [FAKE_PHONE, '--desktop', LOCAL_IP, '--pin', PIN, '--w', '640', '--h', '480', '--fps', '15', '--bitrate', '1M'], { stdio: ['ignore', 'inherit', 'inherit'] });
  await sleep(800); // let control server bind

  // 2. control handshake
  const control = new ControlClient();
  const helloAck = await new Promise((resolve, reject) => {
    control.on('helloAck', resolve);
    control.on('error', reject);
    control.connect({ host: LOCAL_IP, port: 4747, pin: PIN, client: 'test/1.0' });
    setTimeout(() => reject(new Error('helloAck timeout')), 5000);
  });
  assert(helloAck && helloAck.name, 'helloAck received, name=' + helloAck.name);
  assert(helloAck.cameras && helloAck.cameras.length >= 1, 'cameras listed');

  // 3. start stream
  const started = await new Promise((resolve, reject) => {
    control.on('started', resolve);
    control.on('error', reject);
    control.start({ video: { w: 640, h: 480, fps: 15, bitrate: 1_000_000 }, audio: { enabled: true, sampleRate: 48000, channels: 1, bitrate: 64000 } });
    setTimeout(() => reject(new Error('started timeout')), 5000);
  });
  assert(started.video && started.video.codec === 'h264', 'started, codec=' + started.video.codec);

  // 4. media reception
  const stream = new StreamReceiver({ port: 4748 });
  let videoAus = 0, keyframes = 0, configs = 0, audioFrames = 0, gotAu = false, gotAudio = false;
  let firstAu = null;
  stream.on('config', () => configs++);
  stream.on('au', (au, isKey) => { videoAus++; if (isKey) keyframes++; if (!firstAu) firstAu = au; gotAu = true; });
  stream.on('audio', () => { audioFrames++; gotAudio = true; });
  stream.start();
  await sleep(4000); // collect ~4s of media
  stream.stop();

  console.log(`  video AUs=${videoAus} keyframes=${keyframes} configs=${configs} audio=${audioFrames}`);
  assert(videoAus > 10, 'received video AUs (' + videoAus + ')');
  assert(keyframes >= 1, 'received at least one keyframe (' + keyframes + ')');
  assert(audioFrames > 10, 'received audio frames (' + audioFrames + ')');

  // 5. AU starts with a start code (Annex-B)
  if (firstAu) {
    const isAnnexB = firstAu[0] === 0 && firstAu[1] === 0 && (firstAu[2] === 1 || (firstAu[2] === 0 && firstAu[3] === 1));
    assert(isAnnexB, 'AU begins with Annex-B start code');
  }

  control.disconnect();
  fp.kill();
  console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(process.exitCode || 0);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
