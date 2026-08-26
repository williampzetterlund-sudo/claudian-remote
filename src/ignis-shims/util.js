// Node `util` shim for browser builds. Measured surface in the bundle:
// promisify, format, TextDecoder/TextEncoder re-exports, default import.
'use strict';

function promisify(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "original" argument must be of type function');
  }
  const wrapped = function promisified(...args) {
    return new Promise((resolvePromise, rejectPromise) => {
      fn.call(this, ...args, (error, value) => {
        if (error) rejectPromise(error);
        else resolvePromise(value);
      });
    });
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return wrapped;
}

function inspect(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function format(template, ...args) {
  if (typeof template !== 'string') {
    return [template, ...args].map(inspect).join(' ');
  }
  let index = 0;
  let result = template.replace(/%[sdifjoO%]/g, (specifier) => {
    if (specifier === '%%') return '%';
    if (index >= args.length) return specifier;
    const value = args[index];
    index += 1;
    switch (specifier) {
      case '%s': return typeof value === 'string' ? value : inspect(value);
      case '%d':
      case '%i': return String(typeof value === 'number' ? Math.trunc(value) : Number(value));
      case '%f': return String(Number(value));
      case '%j': {
        try {
          return JSON.stringify(value);
        } catch {
          return '[Circular]';
        }
      }
      default: return inspect(value);
    }
  });
  for (; index < args.length; index += 1) {
    result += ` ${inspect(args[index])}`;
  }
  return result;
}

function inherits(constructor, superConstructor) {
  Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
  Object.defineProperty(constructor, 'super_', { value: superConstructor, configurable: true });
}

function callbackify(fn) {
  return function callbackified(...args) {
    const callback = args.pop();
    fn.call(this, ...args).then(
      (value) => callback(null, value),
      (error) => callback(error ?? new Error('rejected without a reason')),
    );
  };
}

const utilShim = {
  promisify,
  callbackify,
  format,
  inspect,
  inherits,
  deprecate: (fn) => fn,
  debuglog: () => () => {},
  types: {
    isUint8Array: (value) => value instanceof Uint8Array,
    isArrayBuffer: (value) => value instanceof ArrayBuffer,
    isDate: (value) => value instanceof Date,
    isNativeError: (value) => value instanceof Error,
    isPromise: (value) => value instanceof Promise,
  },
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
};

module.exports = utilShim;
module.exports.default = utilShim;
