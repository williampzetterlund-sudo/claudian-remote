// Node `async_hooks` shim for the Ignis (browser) build. Synchronous
// AsyncLocalStorage approximation: context does not survive real async hops,
// which matches what a browser can offer and is enough for the SDK's usage.
'use strict';

class AsyncLocalStorage {
  constructor() {
    this._store = undefined;
  }

  getStore() {
    return this._store;
  }

  run(store, callback, ...args) {
    const previous = this._store;
    this._store = store;
    try {
      return callback(...args);
    } finally {
      this._store = previous;
    }
  }

  exit(callback, ...args) {
    const previous = this._store;
    this._store = undefined;
    try {
      return callback(...args);
    } finally {
      this._store = previous;
    }
  }

  enterWith(store) {
    this._store = store;
  }

  disable() {
    this._store = undefined;
  }
}

class AsyncResource {
  constructor(type) {
    this.type = type;
  }

  runInAsyncScope(callback, thisArg, ...args) {
    return callback.apply(thisArg, args);
  }

  emitDestroy() {
    return this;
  }

  static bind(callback) {
    return callback;
  }
}

module.exports = {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId: () => 0,
  triggerAsyncId: () => 0,
  createHook: () => ({ enable: () => {}, disable: () => {} }),
};
module.exports.default = module.exports;
