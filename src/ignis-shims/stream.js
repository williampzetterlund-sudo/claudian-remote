// Node `stream` shim for the Ignis (browser) build. Event-driven minimal
// Readable/Writable good enough for the SDK's line-oriented stdio usage.
'use strict';

const EventEmitter = require('./events.js');

class Stream extends EventEmitter {
  pipe(destination) {
    this.on('data', (chunk) => {
      if (typeof destination.write === 'function') destination.write(chunk);
    });
    this.on('end', () => {
      if (typeof destination.end === 'function') destination.end();
    });
    return destination;
  }
}

class Readable extends Stream {
  constructor(_options) {
    super();
    this.readable = true;
    this._buffered = [];
    this._ended = false;
    this._flowing = false;
  }

  static from(iterable) {
    const readable = new Readable();
    (async () => {
      try {
        for await (const chunk of iterable) {
          readable.push(chunk);
        }
        readable.push(null);
      } catch (error) {
        readable.destroy(error);
      }
    })();
    return readable;
  }

  on(event, listener) {
    super.on(event, listener);
    if (event === 'data') this._startFlowing();
    return this;
  }

  once(event, listener) {
    super.once(event, listener);
    if (event === 'data') this._startFlowing();
    return this;
  }

  _startFlowing() {
    if (this._flowing) return;
    this._flowing = true;
    queueMicrotask(() => this._flush());
  }

  _flush() {
    while (this._buffered.length > 0 && this.listenerCount('data') > 0) {
      this.emit('data', this._buffered.shift());
    }
    if (this._ended && this._buffered.length === 0 && this.readable) {
      this.readable = false;
      this.emit('end');
      this.emit('close');
    }
  }

  push(chunk) {
    if (chunk === null) {
      this._ended = true;
    } else {
      this._buffered.push(chunk);
    }
    if (this._flowing) queueMicrotask(() => this._flush());
    return true;
  }

  read() {
    return this._buffered.length > 0 ? this._buffered.shift() : null;
  }

  pause() {
    return this;
  }

  resume() {
    this._startFlowing();
    return this;
  }

  setEncoding(_encoding) {
    return this;
  }

  destroy(error) {
    this.readable = false;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }

  [Symbol.asyncIterator]() {
    const queue = [];
    let done = false;
    let failure = null;
    let wake = null;
    this.on('data', (chunk) => {
      queue.push(chunk);
      if (wake) wake();
    });
    this.on('end', () => {
      done = true;
      if (wake) wake();
    });
    this.on('error', (error) => {
      failure = error;
      if (wake) wake();
    });
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
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

class Writable extends Stream {
  constructor(options) {
    super();
    this.writable = true;
    this.writableEnded = false;
    this._options = options || {};
  }

  write(chunk, encodingOrCallback, maybeCallback) {
    const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
    const writeImpl = this._write || this._options.write;
    if (typeof writeImpl === 'function') {
      writeImpl.call(this, chunk, 'utf8', callback || (() => {}));
    } else {
      this.emit('data', chunk);
      if (callback) queueMicrotask(callback);
    }
    return true;
  }

  end(chunk, encodingOrCallback, maybeCallback) {
    const callback = typeof chunk === 'function'
      ? chunk
      : typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
    if (chunk !== undefined && typeof chunk !== 'function') {
      this.write(chunk);
    }
    this.writableEnded = true;
    this.writable = false;
    const finalImpl = this._final || this._options.final;
    const finish = () => {
      this.emit('finish');
      this.emit('close');
      if (callback) callback();
    };
    if (typeof finalImpl === 'function') {
      finalImpl.call(this, finish);
    } else {
      queueMicrotask(finish);
    }
    return this;
  }

  destroy(error) {
    this.writable = false;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }
}

class Duplex extends Readable {
  constructor(options) {
    super(options);
    this.writable = true;
    this.writableEnded = false;
  }

  write(chunk, encodingOrCallback, maybeCallback) {
    const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
    this._handleWrite(chunk);
    if (callback) queueMicrotask(callback);
    return true;
  }

  _handleWrite(_chunk) {}

  end(chunk) {
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk);
    this.writableEnded = true;
    this.writable = false;
    this.push(null);
    queueMicrotask(() => {
      this.emit('finish');
    });
    return this;
  }
}

class Transform extends Duplex {
  _handleWrite(chunk) {
    if (typeof this._transform === 'function') {
      this._transform(chunk, 'utf8', (error, output) => {
        if (error) {
          this.emit('error', error);
        } else if (output !== undefined && output !== null) {
          this.push(output);
        }
      });
    } else {
      this.push(chunk);
    }
  }
}

class PassThrough extends Transform {}

function finished(stream, callback) {
  let settled = false;
  const settle = (error) => {
    if (settled) return;
    settled = true;
    callback(error);
  };
  stream.on('end', () => settle());
  stream.on('finish', () => settle());
  stream.on('close', () => settle());
  stream.on('error', (error) => settle(error));
  return () => {};
}

function pipeline(...args) {
  const callback = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
  let current = args[0];
  for (let index = 1; index < args.length; index += 1) {
    current = current.pipe(args[index]);
  }
  finished(current, callback);
  return current;
}

module.exports = {
  Stream,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  finished,
  pipeline,
  default: Stream,
};
module.exports.default = module.exports;
