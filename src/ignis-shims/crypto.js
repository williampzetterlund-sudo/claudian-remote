// Node `crypto` shim for browser builds. Measured surface in the bundle:
// randomUUID, randomBytes, and createHash('sha256'|'sha1') with
// digest('hex'|'base64url'|raw). WebCrypto's digest is async-only, so the
// hashes are implemented synchronously in JS; inputs are small (env
// fingerprints, config-dir suffixes), performance is irrelevant.
'use strict';

const { Buffer: ShimBuffer } = require('./buffer.js');

const webcrypto = globalThis.crypto;

// --- randomness -----------------------------------------------------------

function randomBytes(size, callback) {
  const raw = new Uint8Array(size);
  // getRandomValues caps a single request at 65536 bytes.
  for (let offset = 0; offset < size; offset += 65536) {
    webcrypto.getRandomValues(raw.subarray(offset, Math.min(offset + 65536, size)));
  }
  const bytes = ShimBuffer.from(raw);
  if (typeof callback === 'function') {
    callback(null, bytes);
    return undefined;
  }
  return bytes;
}

function randomUUID() {
  if (typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
  // Manual RFC 4122 v4 for webviews without crypto.randomUUID.
  const bytes = new Uint8Array(16);
  webcrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- sync hashing ---------------------------------------------------------

function toBytes(data, encoding) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') {
    if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') {
      return new TextEncoder().encode(data);
    }
    if (encoding === 'hex') {
      const bytes = new Uint8Array(data.length / 2);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(data.substr(i * 2, 2), 16);
      return bytes;
    }
    throw new Error(`crypto shim: unsupported input encoding '${encoding}'`);
  }
  throw new TypeError('crypto shim: update() expects a string or Uint8Array');
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function padMessage(bytes) {
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  return padded;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const padded = padMessage(bytes);
  const view = new DataView(padded.buffer);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i], false);
  return out;
}

function sha1(bytes) {
  const padded = padMessage(bytes);
  const view = new DataView(padded.buffer);
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) {
      const value = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (value << 1) | (value >>> 31);
    }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 5; i += 1) outView.setUint32(i * 4, h[i], false);
  return out;
}

const HASHERS = { sha256, sha1 };

class Hash {
  constructor(algorithm) {
    const normalized = String(algorithm).toLowerCase().replace('-', '');
    this.hasher = HASHERS[normalized];
    if (!this.hasher) {
      throw new Error(`crypto shim: unsupported hash algorithm '${algorithm}'`);
    }
    this.chunks = [];
  }

  update(data, encoding) {
    this.chunks.push(toBytes(data, encoding));
    return this;
  }

  digest(encoding) {
    const raw = this.hasher(concatBytes(this.chunks));
    if (encoding === undefined || encoding === 'buffer') return ShimBuffer.from(raw);
    if (encoding === 'hex') {
      return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (encoding === 'base64' || encoding === 'base64url') {
      let binary = '';
      for (const byte of raw) binary += String.fromCharCode(byte);
      const base64 = btoa(binary);
      return encoding === 'base64'
        ? base64
        : base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    throw new Error(`crypto shim: unsupported digest encoding '${encoding}'`);
  }
}

function createHash(algorithm) {
  return new Hash(algorithm);
}

function unavailable(name) {
  return () => {
    throw new Error(`crypto.${name} is not available in the browser build`);
  };
}

const cryptoShim = {
  randomBytes,
  randomUUID,
  createHash,
  getRandomValues: (array) => webcrypto.getRandomValues(array),
  webcrypto,
  createHmac: unavailable('createHmac'),
  createCipheriv: unavailable('createCipheriv'),
  createDecipheriv: unavailable('createDecipheriv'),
  createSign: unavailable('createSign'),
  createVerify: unavailable('createVerify'),
  pbkdf2: unavailable('pbkdf2'),
  pbkdf2Sync: unavailable('pbkdf2Sync'),
};

module.exports = cryptoShim;
module.exports.default = cryptoShim;
