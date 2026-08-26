// Node `module` shim for browser builds. The SDK calls
// createRequire(__filename) at import time; serve the bundled shims first and
// fall back to the Ignis window.require registry (absent on Obsidian mobile).
'use strict';

// Lazy thunks: requiring eagerly here would create cycles at bundle init.
const builtinShims = {
  path: () => require('./path.js'),
  crypto: () => require('./crypto.js'),
  util: () => require('./util.js'),
  os: () => require('./os.js'),
  fs: () => require('./fs.js'),
  'fs/promises': () => require('./fs-promises.js'),
  events: () => require('./events.js'),
  stream: () => require('./stream.js'),
  readline: () => require('./readline.js'),
  string_decoder: () => require('./string_decoder.js'),
  url: () => require('./url.js'),
  buffer: () => require('./buffer.js'),
  zlib: () => require('./zlib.js'),
  async_hooks: () => require('./async_hooks.js'),
  child_process: () => require('./stubs/child_process.js'),
  net: () => require('./stubs/net.js'),
  tls: () => require('./stubs/tls.js'),
  http: () => require('./stubs/http.js'),
  https: () => require('./stubs/https.js'),
  dgram: () => require('./stubs/dgram.js'),
  sqlite: () => require('./stubs/sqlite.js'),
};

function resolveBuiltinShim(id) {
  const bare = id.startsWith('node:') ? id.slice(5) : id;
  const thunk = builtinShims[bare];
  return thunk ? thunk() : undefined;
}

function createRequire(_filename) {
  const requireShim = (id) => {
    const shim = resolveBuiltinShim(id);
    if (shim !== undefined) return shim;
    if (typeof window !== 'undefined' && typeof window.require === 'function') {
      return window.require(id);
    }
    throw new Error(`Cannot require '${id}' in the browser build`);
  };
  requireShim.resolve = Object.assign((id) => id, { paths: () => [] });
  requireShim.cache = {};
  requireShim.main = undefined;
  return requireShim;
}

class Module {
  constructor(id) {
    this.id = id;
    this.exports = {};
  }
}
Module.createRequire = createRequire;
Module.builtinModules = [];

module.exports = {
  Module,
  createRequire,
  builtinModules: [],
  isBuiltin: () => false,
};
module.exports.default = module.exports;
