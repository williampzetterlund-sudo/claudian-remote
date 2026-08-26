// Node `path` shim (posix) for browser builds. Under Ignis the host registry
// provides a real `path`; Obsidian on iOS/Android provides nothing, so the
// bundle carries its own implementation. Posix-only by design: every path the
// plugin touches in remote mode is a host-side Linux path.
'use strict';

function cwd() {
  try {
    if (typeof window !== 'undefined' && window.process?.cwd) return window.process.cwd();
  } catch {
    // Fall through to root.
  }
  return '/';
}

function assertString(p, name) {
  if (typeof p !== 'string') {
    throw new TypeError(`The "${name ?? 'path'}" argument must be of type string. Received ${typeof p}`);
  }
}

function normalizeParts(parts, allowAboveRoot) {
  const result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      } else if (allowAboveRoot) {
        result.push('..');
      }
    } else {
      result.push(part);
    }
  }
  return result;
}

function isAbsolute(p) {
  assertString(p);
  return p.startsWith('/');
}

function normalize(p) {
  assertString(p);
  if (p.length === 0) return '.';
  const absolute = p.startsWith('/');
  const trailingSlash = p.length > 1 && p.endsWith('/');
  const parts = normalizeParts(p.split('/'), !absolute);
  let result = parts.join('/');
  if (!result && !absolute) result = '.';
  if (result && trailingSlash) result += '/';
  return absolute ? `/${result}` : result;
}

function join(...args) {
  const parts = [];
  for (const arg of args) {
    assertString(arg);
    if (arg) parts.push(arg);
  }
  if (parts.length === 0) return '.';
  return normalize(parts.join('/'));
}

function resolve(...args) {
  let resolved = '';
  let absolute = false;
  for (let i = args.length - 1; i >= -1 && !absolute; i -= 1) {
    const segment = i >= 0 ? args[i] : cwd();
    assertString(segment);
    if (!segment) continue;
    resolved = resolved ? `${segment}/${resolved}` : segment;
    absolute = segment.startsWith('/');
  }
  const parts = normalizeParts(resolved.split('/'), !absolute);
  const joined = parts.join('/');
  if (absolute) return `/${joined}`;
  return joined || '.';
}

function dirname(p) {
  assertString(p);
  if (p.length === 0) return '.';
  const absolute = p.startsWith('/');
  let end = p.length;
  while (end > 1 && p[end - 1] === '/') end -= 1;
  const index = p.lastIndexOf('/', end - 1);
  if (index < 0) return absolute ? '/' : '.';
  if (index === 0) return '/';
  return p.slice(0, index);
}

function basename(p, suffix) {
  assertString(p);
  let end = p.length;
  while (end > 0 && p[end - 1] === '/') end -= 1;
  const start = p.lastIndexOf('/', end - 1) + 1;
  let base = p.slice(start, end);
  if (typeof suffix === 'string' && suffix.length > 0 && suffix.length < base.length && base.endsWith(suffix)) {
    base = base.slice(0, base.length - suffix.length);
  }
  return base;
}

function extname(p) {
  const base = basename(p);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
}

function relative(from, to) {
  assertString(from, 'from');
  assertString(to, 'to');
  if (from === to) return '';
  const fromParts = resolve(from).split('/').filter(Boolean);
  const toParts = resolve(to).split('/').filter(Boolean);
  let shared = 0;
  const max = Math.min(fromParts.length, toParts.length);
  while (shared < max && fromParts[shared] === toParts[shared]) shared += 1;
  const up = fromParts.slice(shared).map(() => '..');
  return [...up, ...toParts.slice(shared)].join('/');
}

function parse(p) {
  assertString(p);
  const root = p.startsWith('/') ? '/' : '';
  const base = basename(p);
  const ext = extname(p);
  const dir = dirname(p);
  return {
    root,
    dir: dir === '.' && !p.includes('/') ? '' : dir,
    base,
    ext,
    name: ext ? base.slice(0, base.length - ext.length) : base,
  };
}

function format(pathObject) {
  if (pathObject === null || typeof pathObject !== 'object') {
    throw new TypeError('The "pathObject" argument must be of type object.');
  }
  const dir = pathObject.dir || pathObject.root || '';
  const base = pathObject.base || `${pathObject.name || ''}${pathObject.ext || ''}`;
  if (!dir) return base;
  return dir === pathObject.root ? `${dir}${base}` : `${dir}/${base}`;
}

const pathShim = {
  sep: '/',
  delimiter: ':',
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
  format,
  toNamespacedPath: (p) => p,
};
// The plugin only ever handles host-side Linux paths in remote mode; expose
// posix semantics under both names so `path.win32.x` callers keep working.
pathShim.posix = pathShim;
pathShim.win32 = pathShim;

module.exports = pathShim;
module.exports.default = pathShim;
