'use strict';
// H.264 bitstream helpers for the WebCodecs preview path.
// The wire carries Annex-B; WebCodecs VideoDecoder ('avc1.*') with an
// AVCDecoderConfigurationRecord ("description"/avcC) wants AVCC chunks.
// NOTE: this runs in the renderer (browser context) — use only Uint8Array,
// never Node's Buffer.

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

function splitAnnexB(buf) {
  const scs = findStartCodes(buf);
  const nals = [];
  for (let k = 0; k < scs.length; k++) {
    const start = scs[k].pos + scs[k].scLen;
    const end = k + 1 < scs.length ? scs[k + 1].pos : buf.length;
    if (end > start) nals.push(buf.subarray(start, end)); // payload without start code
  }
  return nals;
}

function nalType(nalPayload) { return nalPayload.length ? nalPayload[0] & 0x1f : -1; }

/** Concatenate Uint8Array parts into one Uint8Array. */
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Extract SPS and PPS NAL payloads (no start codes) from an Annex-B AU. */
function extractSpsPps(au) {
  let sps = null, pps = null;
  for (const nal of splitAnnexB(au)) {
    const t = nalType(nal);
    if (t === 7 && !sps) sps = nal;
    else if (t === 8 && !pps) pps = nal;
  }
  return { sps, pps };
}

/** Build an AVCDecoderConfigurationRecord (avcC) from SPS/PPS NAL payloads. */
function buildAvcC(sps, pps) {
  const lenSizeMinusOne = 3; // 4-byte NAL lengths
  const header = new Uint8Array([
    1,                            // configurationVersion
    sps[1],                       // AVCProfileIndication
    sps[2],                       // profile_compatibility
    sps[3],                       // AVCLevelIndication
    0xfc | lenSizeMinusOne,       // lengthSizeMinusOne
    0xe0 | 1,                     // numOfSequenceParameterSets = 1
  ]);
  const spsLen = new Uint8Array([(sps.length >> 8) & 0xff, sps.length & 0xff]);
  const ppsCount = new Uint8Array([1]);
  const ppsLen = new Uint8Array([(pps.length >> 8) & 0xff, pps.length & 0xff]);
  return concat([header, spsLen, sps, ppsCount, ppsLen, pps]);
}

/** WebCodecs codec string from SPS, e.g. 'avc1.42001E'. */
function codecStringFromSps(sps) {
  const p = sps[1].toString(16).padStart(2, '0');
  const c = sps[2].toString(16).padStart(2, '0');
  const l = sps[3].toString(16).padStart(2, '0');
  return `avc1.${p}${c}${l}`.toLowerCase();
}

/**
 * Convert an Annex-B AU to AVCC (4-byte length-prefixed NALs, no start codes).
 * If dropConfig is true, SPS/PPS/AUD NALs are removed (they live in the avcC
 * description when the decoder is configured with one).
 */
function annexBToAvcc(au, dropConfig = false) {
  const nals = splitAnnexB(au);
  const parts = [];
  for (const nal of nals) {
    if (dropConfig) {
      const t = nalType(nal);
      if (t === 7 || t === 8 || t === 9) continue; // SPS / PPS / AUD
    }
    const len = new Uint8Array([(nal.length >>> 24) & 0xff, (nal.length >>> 16) & 0xff, (nal.length >>> 8) & 0xff, nal.length & 0xff]);
    parts.push(len, nal);
  }
  return concat(parts);
}

const api = { findStartCodes, splitAnnexB, nalType, extractSpsPps, buildAvcC, codecStringFromSps, annexBToAvcc, concat };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.H264 = api;
