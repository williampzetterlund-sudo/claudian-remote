// Node `events` shim for the Ignis (browser) build. The Ignis host shim lacks
// module-level `once`/`setMaxListeners`, which the Claude Agent SDK imports.
'use strict';

class EventEmitter {
  constructor() {
    this._events = new Map();
    this._maxListeners = undefined;
  }

  _entries(event) {
    let entries = this._events.get(event);
    if (!entries) {
      entries = [];
      this._events.set(event, entries);
    }
    return entries;
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  on(event, listener) {
    this._entries(event).push({ listener, once: false });
    this.emit('newListener', event, listener);
    return this;
  }

  once(event, listener) {
    this._entries(event).push({ listener, once: true });
    this.emit('newListener', event, listener);
    return this;
  }

  prependListener(event, listener) {
    this._entries(event).unshift({ listener, once: false });
    return this;
  }

  prependOnceListener(event, listener) {
    this._entries(event).unshift({ listener, once: true });
    return this;
  }

  off(event, listener) {
    return this.removeListener(event, listener);
  }

  removeListener(event, listener) {
    const entries = this._events.get(event);
    if (!entries) return this;
    const index = entries.findIndex(
      (entry) => entry.listener === listener || entry.listener._original === listener,
    );
    if (index >= 0) entries.splice(index, 1);
    return this;
  }

  removeAllListeners(event) {
    if (event === undefined) {
      this._events.clear();
    } else {
      this._events.delete(event);
    }
    return this;
  }

  emit(event, ...args) {
    const entries = this._events.get(event);
    if (!entries || entries.length === 0) {
      if (event === 'error') {
        const error = args[0];
        throw error instanceof Error ? error : new Error(`Unhandled error: ${String(error)}`);
      }
      return false;
    }
    for (const entry of [...entries]) {
      if (entry.once) this.removeListener(event, entry.listener);
      entry.listener.apply(this, args);
    }
    return true;
  }

  listeners(event) {
    return (this._events.get(event) || []).map((entry) => entry.listener);
  }

  rawListeners(event) {
    return this.listeners(event);
  }

  listenerCount(event) {
    return (this._events.get(event) || []).length;
  }

  eventNames() {
    return [...this._events.keys()];
  }

  setMaxListeners(_n) {
    this._maxListeners = _n;
    return this;
  }

  getMaxListeners() {
    return this._maxListeners ?? EventEmitter.defaultMaxListeners;
  }
}

EventEmitter.defaultMaxListeners = 10;
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.listenerCount = (emitter, event) => emitter.listenerCount(event);

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener(event, onEvent);
        emitter.removeListener('error', onError);
      } else if (typeof emitter.removeEventListener === 'function') {
        emitter.removeEventListener(event, onEvent);
      }
    };
    if (typeof emitter.once === 'function') {
      emitter.once(event, onEvent);
      if (event !== 'error' && typeof emitter.once === 'function') {
        emitter.once('error', onError);
      }
    } else if (typeof emitter.addEventListener === 'function') {
      emitter.addEventListener(event, onEvent, { once: true });
    }
  });
}

// Applied to AbortSignals by the SDK; irrelevant warning machinery in browsers.
function setMaxListeners(_n, ..._targets) {}

function getEventListeners(emitter, event) {
  return typeof emitter.listeners === 'function' ? emitter.listeners(event) : [];
}

EventEmitter.once = once;
EventEmitter.setMaxListeners = setMaxListeners;
EventEmitter.getEventListeners = getEventListeners;
EventEmitter.default = EventEmitter;

module.exports = EventEmitter;
