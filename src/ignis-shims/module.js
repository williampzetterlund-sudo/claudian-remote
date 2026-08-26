// Node `module` shim for the Ignis (browser) build. The SDK calls
// createRequire(__filename) at import time; route lookups to the Ignis
// window.require registry.
'use strict';

function createRequire(_filename) {
  const requireShim = (id) => {
    if (typeof window !== 'undefined' && typeof window.require === 'function') {
      return window.require(id);
    }
    throw new Error(`Cannot require '${id}' in the Ignis build`);
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
