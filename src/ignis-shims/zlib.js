// Node `zlib` shim for the Ignis (browser) build. Nothing in the Ignis code
// paths should compress; every entry point fails loudly instead of corrupting.
'use strict';

function unsupported(name) {
  return function zlibUnsupported() {
    throw new Error(`zlib.${name}() is not available in the Ignis build`);
  };
}

const names = [
  'gzip', 'gzipSync', 'gunzip', 'gunzipSync',
  'deflate', 'deflateSync', 'inflate', 'inflateSync',
  'deflateRaw', 'deflateRawSync', 'inflateRaw', 'inflateRawSync',
  'brotliCompress', 'brotliCompressSync', 'brotliDecompress', 'brotliDecompressSync',
  'unzip', 'unzipSync',
  'createGzip', 'createGunzip', 'createDeflate', 'createInflate',
  'createBrotliCompress', 'createBrotliDecompress', 'createUnzip',
];

const shim = { constants: {} };
for (const name of names) {
  shim[name] = unsupported(name);
}

module.exports = shim;
module.exports.default = shim;
