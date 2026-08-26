// Node `os` shim for the Ignis (browser) build.
'use strict';

function homedir() {
  // The bridge reports the host-side home so transcript paths resolve to the
  // directories the Claude CLI actually writes.
  const bridgeHome = typeof window !== 'undefined'
    ? window.__claudianBridgeConfig?.home
    : undefined;
  if (bridgeHome) return bridgeHome;
  const env = typeof window !== 'undefined' ? window.process?.env : undefined;
  return env?.HOME || '/home/ignis';
}

module.exports = {
  homedir,
  tmpdir: () => '/tmp',
  hostname: () => 'ignis',
  platform: () => 'linux',
  type: () => 'Linux',
  arch: () => 'x64',
  release: () => '6.0.0-ignis',
  version: () => '#1 Ignis',
  userInfo: () => ({
    username: 'ignis',
    uid: 1000,
    gid: 1000,
    shell: '/bin/sh',
    homedir: homedir(),
  }),
  cpus: () => [],
  totalmem: () => 0,
  freemem: () => 0,
  uptime: () => 0,
  loadavg: () => [0, 0, 0],
  networkInterfaces: () => ({}),
  availableParallelism: () => (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4),
  endianness: () => 'LE',
  EOL: '\n',
  constants: { signals: {}, errno: {}, priority: {} },
};
module.exports.default = module.exports;
