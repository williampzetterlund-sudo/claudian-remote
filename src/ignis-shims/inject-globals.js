// esbuild `inject` file for the Ignis (browser) build. Replaces free global
// references (Buffer, process, global, setImmediate) across the bundle with
// working browser implementations; the Ignis host globals are too partial.
import bufferModule from './buffer.js';
import processShim from './process.js';

export const Buffer = bufferModule.Buffer;
export const process = processShim;
export const global = globalThis;
export const setImmediate = globalThis.setImmediate
  ?? ((callback, ...args) => setTimeout(callback, 0, ...args));
export const clearImmediate = globalThis.clearImmediate ?? ((handle) => clearTimeout(handle));
// SharedArrayBuffer needs cross-origin isolation; the SDK constructs one at
// module init for a sync-sleep helper. ArrayBuffer satisfies the constructor;
// an actual Atomics.wait on it would throw, which is the honest failure mode.
export const SharedArrayBuffer = globalThis.SharedArrayBuffer ?? ArrayBuffer;

// iOS Safari (< 18.2) lacks Symbol.dispose/asyncDispose. The SDK defines
// dispose methods with the raw well-known symbol but its `using` helper falls
// back to Symbol.for('Symbol.dispose') — without the polyfill the keys
// diverge and every query dies with "TypeError: Object not disposable".
// Polyfilling with the exact Symbol.for value makes both sides converge.
if (!Symbol.dispose) {
  Object.defineProperty(Symbol, 'dispose', {
    value: Symbol.for('Symbol.dispose'),
    writable: false,
    enumerable: false,
    configurable: true,
  });
}
if (!Symbol.asyncDispose) {
  Object.defineProperty(Symbol, 'asyncDispose', {
    value: Symbol.for('Symbol.asyncDispose'),
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

// Every abort() records a truncated stack in a ring buffer that the bridge
// spawn relays into the host journal. The browser side of a remote device has
// no reachable console, so this is the only way to attribute an abort.
const NativeAbortController = globalThis.AbortController;
const abortLog = [];
globalThis.__claudianAbortLog = abortLog;
export class AbortController extends NativeAbortController {
  abort(reason) {
    try {
      // Chrome stacks start with an "Error: ..." line, Safari stacks do not.
      const rawFrames = (new Error('abort').stack || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const frames = rawFrames[0]?.startsWith('Error') ? rawFrames.slice(1) : rawFrames;
      const reasonText = reason === undefined ? '' : ` reason=${String(reason)}`;
      abortLog.push(
        `${new Date().toISOString().slice(11, 23)}${reasonText} ${frames.slice(0, 8).join(' <- ')}`,
      );
      if (abortLog.length > 20) abortLog.shift();
    } catch {
      // Diagnostics must never break the abort itself.
    }
    super.abort(reason);
  }
}
