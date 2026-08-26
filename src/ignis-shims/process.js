// Node `process` shim for the Ignis (browser) build. Injected as the global
// `process` and aliased for `require('process')`. Shares the env object with
// the Ignis host shim when present so environment edits stay visible.
'use strict';

const hostProcess = typeof window !== 'undefined' && window.process ? window.process : {};
const env = hostProcess.env && typeof hostProcess.env === 'object' ? hostProcess.env : {};

const startTime = Date.now();

function noopChainable() {
  return processShim;
}

function hrtime(previous) {
  const elapsedMs = Date.now() - startTime;
  const seconds = Math.floor(elapsedMs / 1000);
  const nanoseconds = Math.round((elapsedMs % 1000) * 1e6);
  if (previous) {
    let deltaSeconds = seconds - previous[0];
    let deltaNanoseconds = nanoseconds - previous[1];
    if (deltaNanoseconds < 0) {
      deltaSeconds -= 1;
      deltaNanoseconds += 1e9;
    }
    return [deltaSeconds, deltaNanoseconds];
  }
  return [seconds, nanoseconds];
}
hrtime.bigint = () => BigInt(Math.round((Date.now() - startTime) * 1e6));

const fakeWritable = () => ({
  write: () => true,
  end: () => {},
  on: noopChainable,
  once: noopChainable,
  off: noopChainable,
  removeListener: noopChainable,
  isTTY: false,
  columns: 80,
  rows: 24,
});

const processShim = {
  env,
  platform: 'linux',
  arch: 'x64',
  version: 'v18.18.0',
  versions: {
    node: '18.18.0',
    v8: '11.0.0',
    modules: '108',
    electron: hostProcess.versions?.electron ?? '28.2.3',
    chrome: hostProcess.versions?.chrome ?? '120.0.0.0',
  },
  argv: ['node'],
  argv0: 'node',
  execArgv: [],
  execPath: '/usr/local/bin/node',
  pid: 1,
  ppid: 0,
  title: 'ignis',
  type: 'renderer',
  resourcesPath: '/',
  cwd: () => '/',
  chdir: () => {},
  umask: () => 0o22,
  getuid: () => 1000,
  geteuid: () => 1000,
  getgid: () => 1000,
  getegid: () => 1000,
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  hrtime,
  uptime: () => (Date.now() - startTime) / 1000,
  memoryUsage: Object.assign(
    () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    { rss: () => 0 },
  ),
  cpuUsage: () => ({ user: 0, system: 0 }),
  exitCode: undefined,
  exit: () => {},
  kill: () => true,
  abort: () => {},
  stdout: fakeWritable(),
  stderr: fakeWritable(),
  stdin: {
    on: noopChainable,
    once: noopChainable,
    off: noopChainable,
    removeListener: noopChainable,
    resume: noopChainable,
    pause: noopChainable,
    setRawMode: noopChainable,
    read: () => null,
    isTTY: false,
  },
  on: noopChainable,
  once: noopChainable,
  off: noopChainable,
  addListener: noopChainable,
  removeListener: noopChainable,
  removeAllListeners: noopChainable,
  prependListener: noopChainable,
  prependOnceListener: noopChainable,
  setMaxListeners: noopChainable,
  getMaxListeners: () => 10,
  emit: () => false,
  listeners: () => [],
  listenerCount: () => 0,
  eventNames: () => [],
  emitWarning: () => {},
  allowedNodeEnvironmentFlags: new Set(),
  features: {},
  release: { name: 'node' },
  config: {},
  report: undefined,
  binding: () => {
    throw new Error('process.binding is not supported in the Ignis build');
  },
  dlopen: () => {
    throw new Error('process.dlopen is not supported in the Ignis build');
  },
};

module.exports = processShim;
module.exports.default = processShim;
