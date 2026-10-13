'use strict';
// Shared protocol constants for Camic v1 (mirrors protocol/PROTOCOL.md).

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

const MDNS_TYPE = '_camic._tcp';

function unpackHeader(buf) {
  if (buf.length < HDR_SIZE) return null;
  return {
    version: buf.readUInt8(0),
    type: buf.readUInt8(1),
    flags: buf.readUInt8(2),
    seq: buf.readUInt32BE(4),
    timestamp: buf.readUInt32BE(8),
  };
}

// ADTS helpers for AAC (used by audio receiver to wrap raw AUs for ffmpeg).
const ADTS_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function adtsHeader(sampleRate, channels, aacFrameLen /* includes 7-byte header */) {
  const sfi = ADTS_SR.indexOf(sampleRate);
  const idx = sfi === -1 ? 3 : sfi; // default 48000
  const profile = 1; // AAC-LC (MPEG-4 object type 2 → profile bits = 1)
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf1; // MPEG-4, layer 0, protection absent
  h[2] = ((profile & 3) << 6) | ((idx & 0x0f) << 2) | ((channels >> 2) & 1);
  h[3] = ((channels & 3) << 6) | ((aacFrameLen >> 11) & 3);
  h[4] = (aacFrameLen >> 3) & 0xff;
  h[5] = ((aacFrameLen & 7) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

module.exports = {
  PROTO_VER, CONTROL_PORT, MEDIA_PORT, MTU, HDR_SIZE,
  TYPE_VIDEO, TYPE_AUDIO, FLAG_KEYFRAME, FLAG_EOF, FLAG_CONFIG,
  MDNS_TYPE, unpackHeader, adtsHeader,
};
