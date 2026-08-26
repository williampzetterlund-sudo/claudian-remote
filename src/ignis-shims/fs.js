// Node `fs` shim for the Ignis (browser) build. Delegates to the Ignis host
// fs shim (vault-scoped, WebSocket-backed) and fills the gaps the SDK needs:
// createReadStream/createWriteStream and a few promise APIs.
'use strict';

const { Readable, Writable } = require('./stream.js');

const hostFs = typeof window !== 'undefined' && typeof window.require === 'function'
  ? window.require('fs')
  : {};

function enosys(operation, path) {
  const error = new Error(`ENOSYS: operation not supported in Ignis build, ${operation} '${path ?? ''}'`);
  error.code = 'ENOSYS';
  return error;
}

function enoent(operation, path) {
  const error = new Error(`ENOENT: no such file or directory, ${operation} '${path ?? ''}'`);
  error.code = 'ENOENT';
  return error;
}

// --- Bridge-backed remote reads -------------------------------------------
// The Claude CLI writes transcripts on the HOST (~/.claude/projects); the
// Ignis host fs only serves the vault. Paths under the bridge's declared
// read roots are proxied read-only over the bridge HTTP API so history
// replay works in the browser.

const { Buffer: ShimBuffer } = require('./buffer.js');

function bridgeFsConfig() {
  const config = typeof window !== 'undefined' ? window.__claudianBridgeConfig : undefined;
  if (!config || typeof config.makeFsUrl !== 'function') return null;
  const roots = Array.isArray(config.remoteReadRoots) ? config.remoteReadRoots : [];
  return roots.length > 0 ? { makeFsUrl: config.makeFsUrl, roots } : null;
}

function remoteConfigFor(path) {
  const config = bridgeFsConfig();
  if (!config || typeof path !== 'string') return null;
  for (const root of config.roots) {
    if (path === root || path.startsWith(`${root}/`)) return config;
  }
  return null;
}

async function remoteFetch(config, op, path) {
  const response = await fetch(config.makeFsUrl(op, path));
  if (response.status === 404) throw enoent(op, path);
  if (!response.ok) {
    throw new Error(`bridge fs ${op} failed (${response.status}) for '${path}'`);
  }
  return response;
}

async function remoteReadBytes(config, path) {
  const response = await remoteFetch(config, 'read', path);
  return ShimBuffer.from(await response.arrayBuffer());
}

function makeRemoteStat(raw) {
  return {
    size: raw.size,
    mtimeMs: raw.mtimeMs,
    mtime: new Date(raw.mtimeMs),
    isFile: () => !!raw.isFile,
    isDirectory: () => !!raw.isDirectory,
    isSymbolicLink: () => false,
  };
}

function remoteStatSyncRaw(config, path) {
  // Sync fs API over sync XHR: only used for existsSync-style guards on
  // transcript paths, which are rare and tiny.
  const xhr = new XMLHttpRequest();
  xhr.open('GET', config.makeFsUrl('stat', path), false);
  xhr.send();
  if (xhr.status === 404) return null;
  if (xhr.status !== 200) throw new Error(`bridge fs stat failed (${xhr.status}) for '${path}'`);
  return JSON.parse(xhr.responseText);
}

const hostPromises = hostFs.promises || {};

const promises = {
  ...hostPromises,
  readFile: async (path, options) => {
    const remote = remoteConfigFor(path);
    if (!remote) return hostPromises.readFile(path, options);
    const bytes = await remoteReadBytes(remote, path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  },
  readdir: async (path, options) => {
    const remote = remoteConfigFor(path);
    if (!remote) return hostPromises.readdir(path, options);
    const { entries } = await (await remoteFetch(remote, 'readdir', path)).json();
    if (options?.withFileTypes) {
      return entries.map((entry) => ({
        name: entry.name,
        isFile: () => entry.type === 'file',
        isDirectory: () => entry.type === 'dir',
        isSymbolicLink: () => false,
      }));
    }
    return entries.map((entry) => entry.name);
  },
  access: async (path, mode) => {
    const remote = remoteConfigFor(path);
    if (!remote) return hostPromises.access(path, mode);
    await remoteFetch(remote, 'stat', path);
  },
  stat: async (path, options) => {
    const remote = remoteConfigFor(path);
    if (!remote) return hostPromises.stat(path, options);
    return makeRemoteStat(await (await remoteFetch(remote, 'stat', path)).json());
  },
  lstat: async (path, options) => {
    const remote = remoteConfigFor(path);
    if (!remote) return (hostPromises.lstat ?? hostPromises.stat)(path, options);
    return makeRemoteStat(await (await remoteFetch(remote, 'stat', path)).json());
  },
  open: async (path, flags) => {
    const remote = remoteConfigFor(path);
    if (!remote) return hostPromises.open(path, flags);
    const bytes = await remoteReadBytes(remote, path);
    return {
      stat: async () => ({ size: bytes.length }),
      read: async (buffer, offset, length, position) => {
        const start = position ?? 0;
        const slice = bytes.subarray(start, start + length);
        buffer.set(slice, offset ?? 0);
        return { bytesRead: slice.length, buffer };
      },
      close: async () => {},
    };
  },
  readlink: hostPromises.readlink
    || (async (path) => {
      throw enosys('readlink', path);
    }),
  symlink: hostPromises.symlink
    || (async (target, path) => {
      throw enosys('symlink', path);
    }),
  link: hostPromises.link
    || (async (existing, path) => {
      throw enosys('link', path);
    }),
  mkdtemp: hostPromises.mkdtemp
    || (async (prefix) => {
      const path = `${prefix}${Math.random().toString(36).slice(2, 10)}`;
      await promises.mkdir(path, { recursive: true });
      return path;
    }),
  watch: hostPromises.watch
    || (async function* watch() {}),
};

function createReadStream(path, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const stream = new Readable();
  (async () => {
    try {
      const contents = await promises.readFile(path);
      if (encoding) {
        stream.push(
          typeof contents === 'string'
            ? contents
            : new TextDecoder().decode(contents),
        );
      } else {
        stream.push(contents);
      }
      stream.push(null);
    } catch (error) {
      stream.destroy(error);
    }
  })();
  return stream;
}

function createWriteStream(path, _options) {
  const chunks = [];
  const stream = new Writable();
  stream._write = (chunk, _encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    callback();
  };
  stream._final = (callback) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    promises.writeFile(path, merged).then(
      () => callback(),
      (error) => {
        stream.emit('error', error);
        callback();
      },
    );
  };
  return stream;
}

module.exports = {
  ...hostFs,
  promises,
  createReadStream,
  createWriteStream,
  constants: hostFs.constants || { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  existsSync: (path) => {
    const remote = remoteConfigFor(path);
    if (remote) {
      try {
        return remoteStatSyncRaw(remote, path) !== null;
      } catch {
        return false;
      }
    }
    return hostFs.existsSync ? hostFs.existsSync(path) : false;
  },
  statSync: (path, options) => {
    const remote = remoteConfigFor(path);
    if (remote) {
      const raw = remoteStatSyncRaw(remote, path);
      if (raw === null) throw enoent('stat', path);
      return makeRemoteStat(raw);
    }
    return hostFs.statSync(path, options);
  },
  realpathSync: hostFs.realpathSync || ((path) => path),
  watchFile: hostFs.watchFile || (() => {}),
  unwatchFile: hostFs.unwatchFile || (() => {}),
  readlinkSync: hostFs.readlinkSync
    || ((path) => {
      throw enosys('readlink', path);
    }),
  symlinkSync: hostFs.symlinkSync
    || ((target, path) => {
      throw enosys('symlink', path);
    }),
  mkdtempSync: hostFs.mkdtempSync
    || ((prefix) => {
      const path = `${prefix}${Math.random().toString(36).slice(2, 10)}`;
      if (typeof hostFs.mkdirSync === 'function') hostFs.mkdirSync(path, { recursive: true });
      return path;
    }),
};
module.exports.default = module.exports;
