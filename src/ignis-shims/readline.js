// Node `readline` shim for the Ignis (browser) build. Supports the SDK's
// usage: createInterface({input}) + for-await over lines + close().
'use strict';

const EventEmitter = require('./events.js');

function toText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

class Interface extends EventEmitter {
  constructor(options) {
    super();
    this.input = options.input;
    this.closed = false;
    this._pending = '';

    this._onData = (chunk) => {
      this._pending += toText(chunk);
      let newlineIndex = this._pending.indexOf('\n');
      while (newlineIndex >= 0) {
        let line = this._pending.slice(0, newlineIndex);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this._pending = this._pending.slice(newlineIndex + 1);
        this.emit('line', line);
        newlineIndex = this._pending.indexOf('\n');
      }
    };
    this._onEnd = () => {
      this.close();
    };
    this._onError = (error) => {
      this.emit('error', error);
      this.close();
    };

    if (this.input && typeof this.input.on === 'function') {
      this.input.on('data', this._onData);
      this.input.on('end', this._onEnd);
      this.input.on('close', this._onEnd);
      this.input.on('error', this._onError);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._pending.length > 0) {
      const line = this._pending.endsWith('\r') ? this._pending.slice(0, -1) : this._pending;
      this._pending = '';
      this.emit('line', line);
    }
    if (this.input && typeof this.input.removeListener === 'function') {
      this.input.removeListener('data', this._onData);
      this.input.removeListener('end', this._onEnd);
      this.input.removeListener('close', this._onEnd);
      this.input.removeListener('error', this._onError);
    }
    this.emit('close');
  }

  pause() {
    return this;
  }

  resume() {
    return this;
  }

  [Symbol.asyncIterator]() {
    const queue = [];
    let done = this.closed;
    let failure = null;
    let wake = null;
    this.on('line', (line) => {
      queue.push(line);
      if (wake) wake();
    });
    this.on('close', () => {
      done = true;
      if (wake) wake();
    });
    this.on('error', (error) => {
      failure = error;
      if (wake) wake();
    });
    const self = this;
    return {
      async next() {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          if (failure) throw failure;
          if (done) return { value: undefined, done: true };
          await new Promise((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
      async return() {
        done = true;
        self.close();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

function createInterface(options) {
  return new Interface(options);
}

module.exports = {
  Interface,
  createInterface,
  clearLine: () => false,
  clearScreenDown: () => false,
  cursorTo: () => false,
  moveCursor: () => false,
};
module.exports.default = module.exports;
