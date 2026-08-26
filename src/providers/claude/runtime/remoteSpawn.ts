import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/**
 * Browser-side SpawnedProcess implementation for the Ignis runtime.
 *
 * Ignis runs Obsidian in the browser, so the Claude CLI cannot be spawned
 * locally. Instead, a WebSocket bridge on the host spawns the CLI and relays
 * stdio. This module is intentionally free of Node imports: it must run in a
 * plain browser context where only the Ignis shims exist.
 *
 * Bridge protocol (client -> server):
 *   {type:'start', args, cwd, env} {type:'stdin', data:base64}
 *   {type:'stdin_end'} {type:'kill', signal}
 * (server -> client):
 *   {type:'started', pid} {type:'stdout'|'stderr', data:base64}
 *   {type:'exit', code, signal} {type:'error', message}
 */

export const IGNIS_BRIDGE_URL_STORAGE_KEY = 'claudian_bridge_url';
export const IGNIS_BRIDGE_TOKEN_STORAGE_KEY = 'claudian_bridge_token';
export const IGNIS_BRIDGE_DEFAULT_PORT = 8095;
export const IGNIS_BRIDGE_PROXY_PATH = '/claudian-bridge';

/** Sentinel CLI path: the bridge always runs its own configured binary. */
export const IGNIS_BRIDGE_CLI_PATH = '/ignis-bridge/claude';

// Injected by esbuild.ignis.mjs `define`; absent in desktop builds.
declare const CLAUDIAN_BRIDGE_TOKEN: string | undefined;

interface IgnisWindow {
  __ignis?: unknown;
  __claudianAbortLog?: string[];
  __claudianBridgeConfig?: IgnisBridgeWindowConfig;
  location?: { protocol?: string; hostname?: string; host?: string };
}

/** Read-only facts served by the bridge's /config endpoint. */
export interface IgnisBridgeConfig {
  /** Host-side home directory of the bridge user (transcripts live under it). */
  home?: string;
  /** Host-side path of the vault root that the browser sees as "/". */
  vaultRoot?: string;
  /** Host-side directory trees readable through the bridge fs API. */
  remoteReadRoots?: string[];
}

/** Shared with the Ignis shims (plain JS) via window; they cannot import TS. */
export interface IgnisBridgeWindowConfig extends IgnisBridgeConfig {
  makeFsUrl?: (op: 'stat' | 'readdir' | 'read', targetPath: string) => string;
}

/** Ring buffer written by the Ignis build's instrumented AbortController. */
function readRecentAbortLog(): string {
  if (typeof window === 'undefined') return 'none';
  const entries = (window as IgnisWindow).__claudianAbortLog;
  if (!entries || entries.length === 0) return 'none';
  return entries.slice(-3).join(' || ');
}

export function isIgnisRuntime(): boolean {
  return typeof window !== 'undefined' && !!(window as IgnisWindow).__ignis;
}

function readLocalStorage(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function readBridgeToken(): string {
  const stored = readLocalStorage(IGNIS_BRIDGE_TOKEN_STORAGE_KEY);
  if (stored) return stored;
  try {
    return typeof CLAUDIAN_BRIDGE_TOKEN === 'string' ? CLAUDIAN_BRIDGE_TOKEN : '';
  } catch {
    return '';
  }
}

function withToken(url: string): string {
  const token = readBridgeToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * Resolution order: explicit localStorage override; same-origin wss proxy path
 * when the page is https (mixed content forbids plain ws there); plain ws to
 * the bridge port otherwise; loopback when no location exists.
 */
function resolveBridgeBase(): string {
  const override = readLocalStorage(IGNIS_BRIDGE_URL_STORAGE_KEY);
  if (override) return override;

  const location = typeof window !== 'undefined'
    ? (window as IgnisWindow).location
    : undefined;
  if (location?.hostname) {
    if (location.protocol === 'https:') {
      return `wss://${location.host}${IGNIS_BRIDGE_PROXY_PATH}`;
    }
    return `ws://${location.hostname}:${IGNIS_BRIDGE_DEFAULT_PORT}`;
  }
  return `ws://127.0.0.1:${IGNIS_BRIDGE_DEFAULT_PORT}`;
}

export function resolveBridgeUrl(): string {
  return withToken(resolveBridgeBase());
}

/** Bridge HTTP endpoint (config / fs reads): the ws(s) base with http(s) scheme. */
export function resolveBridgeHttpUrl(route: string): string {
  const base = resolveBridgeBase()
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/$/, '');
  return withToken(`${base}${route}`);
}

let cachedBridgeConfig: IgnisBridgeConfig | null = null;
let bridgeConfigRequest: Promise<void> | null = null;

export function getIgnisBridgeConfig(): IgnisBridgeConfig | null {
  return cachedBridgeConfig;
}

function makeFsUrl(op: 'stat' | 'readdir' | 'read', targetPath: string): string {
  const url = resolveBridgeHttpUrl(`/fs/${op}`);
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}path=${encodeURIComponent(targetPath)}`;
}

/**
 * Fetches host-side facts (home dir, vault root, readable transcript roots)
 * once per page load. The Ignis fs/os shims read the result via
 * window.__claudianBridgeConfig; failure only degrades history replay.
 */
export function ensureIgnisBridgeConfig(): void {
  if (!isIgnisRuntime() || cachedBridgeConfig || bridgeConfigRequest) return;
  bridgeConfigRequest = (async () => {
    try {
      const response = await fetch(resolveBridgeHttpUrl('/config'));
      if (!response.ok) return;
      const config = (await response.json()) as IgnisBridgeConfig;
      cachedBridgeConfig = config;
      (window as IgnisWindow).__claudianBridgeConfig = { ...config, makeFsUrl };
    } catch {
      // Bridge unreachable; spawning will surface its own error later.
    } finally {
      bridgeConfigRequest = null;
    }
  })();
}

/**
 * Maps a browser-side absolute path (vault root is "/") to the corresponding
 * host-side path, mirroring the bridge's cwd mapping. Identity outside Ignis
 * or before the bridge config has loaded.
 */
export function getIgnisHostPath(browserPath: string): string {
  if (!isIgnisRuntime()) return browserPath;
  const root = cachedBridgeConfig?.vaultRoot
    ?? (window as IgnisWindow).__claudianBridgeConfig?.vaultRoot;
  if (!root || !browserPath.startsWith('/')) return browserPath;
  if (browserPath === root || browserPath.startsWith(`${root}/`)) return browserPath;
  return browserPath === '/' ? root : `${root}${browserPath}`;
}

// History replay needs the host mapping as early as possible; fire the fetch
// at module load when running under Ignis (no-op everywhere else).
if (typeof window !== 'undefined' && (window as IgnisWindow).__ignis) {
  ensureIgnisBridgeConfig();
}

type ListenerMap = Map<string, Array<{ listener: (...args: unknown[]) => void; once: boolean }>>;

/** Minimal EventEmitter core shared by the process facade and its streams. */
class MiniEmitter {
  private readonly listeners: ListenerMap = new Map();

  on(event: string, listener: (...args: never[]) => void): this {
    return this.addEntry(event, listener as (...args: unknown[]) => void, false);
  }

  once(event: string, listener: (...args: never[]) => void): this {
    return this.addEntry(event, listener as (...args: unknown[]) => void, true);
  }

  off(event: string, listener: (...args: never[]) => void): this {
    const entries = this.listeners.get(event);
    if (!entries) return this;
    const index = entries.findIndex((entry) => entry.listener === listener);
    if (index >= 0) entries.splice(index, 1);
    return this;
  }

  addListener(event: string, listener: (...args: never[]) => void): this {
    return this.on(event, listener);
  }

  removeListener(event: string, listener: (...args: never[]) => void): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) return false;
    for (const entry of [...entries]) {
      if (entry.once) this.off(event, entry.listener);
      entry.listener(...args);
    }
    return true;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  private addEntry(
    event: string,
    listener: (...args: unknown[]) => void,
    once: boolean,
  ): this {
    const entries = this.listeners.get(event) ?? [];
    entries.push({ listener, once });
    this.listeners.set(event, entries);
    return this;
  }
}

function encodeBase64(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Readable-like stdout facade: emits decoded UTF-8 string chunks. */
class RemoteReadable extends MiniEmitter {
  readable = true;

  pause(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  setEncoding(): this {
    return this;
  }

  destroy(): this {
    this.readable = false;
    return this;
  }

  pushText(text: string): void {
    if (text) this.emit('data', text);
  }

  finish(): void {
    if (!this.readable) return;
    this.readable = false;
    this.emit('end');
    this.emit('close');
  }
}

type BridgeClientMessage =
  | { type: 'start'; args: string[]; cwd?: string; env?: Record<string, string | undefined> }
  | { type: 'stdin'; data: string }
  | { type: 'stdin_end' }
  | { type: 'kill'; signal: string }
  | { type: 'clientlog'; message: string }
  | { type: 'ping' };

/**
 * Cloudflare's edge closes WebSockets that stay silent for ~100 seconds,
 * which kills the warm CLI process between chat turns. Application-level
 * pings keep the tunnel path alive; browsers cannot send protocol pings.
 */
export const IGNIS_BRIDGE_KEEPALIVE_INTERVAL_MS = 30_000;

interface BridgeServerMessage {
  type?: string;
  pid?: number;
  data?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
}

class RemoteSpawnedProcess extends MiniEmitter {
  readonly stdin: {
    writable: boolean;
    writableEnded: boolean;
    write(data: string | Uint8Array): boolean;
    end(): void;
    destroy(): void;
    on(event: string, listener: (...args: never[]) => void): unknown;
    once(event: string, listener: (...args: never[]) => void): unknown;
    off(event: string, listener: (...args: never[]) => void): unknown;
    removeListener(event: string, listener: (...args: never[]) => void): unknown;
  };

  readonly stdout: RemoteReadable;

  pid: number | undefined;
  stderrTail = '';

  private socket: WebSocket;
  private keepaliveTimer: number | undefined;
  private started = false;
  private exited = false;
  private wasKilled = false;
  private currentExitCode: number | null = null;
  private currentSignalCode: string | null = null;
  private readonly pendingFrames: BridgeClientMessage[] = [];
  private readonly stdinEmitter = new MiniEmitter();
  private stdinEnded = false;
  private readonly stdoutDecoder = new TextDecoder('utf-8');
  private readonly stderrDecoder = new TextDecoder('utf-8');

  constructor(private readonly options: SpawnOptions) {
    super();
    this.stdout = new RemoteReadable();

    const stdinEmitter = this.stdinEmitter;
    const isStdinWritable = (): boolean => !this.stdinEnded && !this.exited;
    const isStdinEnded = (): boolean => this.stdinEnded;
    const writeStdin = (data: string | Uint8Array): boolean => {
      if (this.stdinEnded) return false;
      this.sendOrQueue({ type: 'stdin', data: encodeBase64(data) });
      return true;
    };
    const endStdin = (): void => {
      if (this.stdinEnded) return;
      this.stdinEnded = true;
      this.diagnostic(`stdin.end called; recent aborts: ${readRecentAbortLog()}`);
      this.sendOrQueue({ type: 'stdin_end' });
    };
    const destroyStdin = (): void => {
      this.stdinEnded = true;
    };
    this.stdin = {
      get writable(): boolean {
        return isStdinWritable();
      },
      get writableEnded(): boolean {
        return isStdinEnded();
      },
      write: writeStdin,
      end: endStdin,
      destroy: destroyStdin,
      on: (event, listener) => stdinEmitter.on(event, listener),
      once: (event, listener) => stdinEmitter.once(event, listener),
      off: (event, listener) => stdinEmitter.off(event, listener),
      removeListener: (event, listener) => stdinEmitter.off(event, listener),
    };

    this.socket = this.connect();

    const signal = options.signal;
    if (signal) {
      const killOnAbort = (): void => {
        this.diagnostic('abort-signal fired');
        this.kill('SIGTERM');
      };
      if (signal.aborted) {
        killOnAbort();
      } else {
        signal.addEventListener('abort', killOnAbort, { once: true });
      }
    }
  }

  /**
   * Lifecycle breadcrumbs relayed to the bridge journal. The browser side has
   * no reachable console, so this is the only way to see who initiated a
   * teardown (client abort vs. CLI exit) when a remote device misbehaves.
   */
  private diagnostic(message: string): void {
    this.sendOrQueue({ type: 'clientlog', message });
  }

  get killed(): boolean {
    return this.wasKilled;
  }

  get exitCode(): number | null {
    return this.currentExitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.currentSignalCode as NodeJS.Signals | null;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.diagnostic(`kill ${signal}`);
    this.wasKilled = true;
    this.sendOrQueue({ type: 'kill', signal });
    return true;
  }

  private connect(): WebSocket {
    const socket = new WebSocket(resolveBridgeUrl());
    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'start',
        args: [...this.options.args],
        cwd: this.options.cwd,
        env: this.options.env,
      } satisfies BridgeClientMessage));
      this.started = true;
      // The viewport identifies which remote device a bridge-journal entry
      // came from (phone vs. desktop); the browser side has no other channel.
      const viewport = typeof window !== 'undefined'
        ? `${window.innerWidth}x${window.innerHeight}`
        : 'unknown';
      socket.send(JSON.stringify({
        type: 'clientlog',
        message: `spawned viewport=${viewport}`,
      } satisfies BridgeClientMessage));
      for (const frame of this.pendingFrames.splice(0)) {
        socket.send(JSON.stringify(frame));
      }
      this.keepaliveTimer = window.setInterval(() => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'ping' } satisfies BridgeClientMessage));
        }
      }, IGNIS_BRIDGE_KEEPALIVE_INTERVAL_MS);
    };
    socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };
    socket.onerror = () => {
      // Details arrive via onclose; browsers expose nothing useful here.
    };
    socket.onclose = () => {
      if (this.keepaliveTimer !== undefined) {
        window.clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = undefined;
      }
      if (this.exited) return;
      this.exited = true;
      this.currentSignalCode = 'SIGTERM';
      this.emit('error', new Error(
        'Claudian bridge: connection closed before the process exited'
        + (this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-2000)}` : ''),
      ));
      this.stdout.finish();
      this.emit('exit', null, 'SIGTERM');
    };
    return socket;
  }

  private sendOrQueue(frame: BridgeClientMessage): void {
    if (this.started && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(frame));
    } else if (!this.exited) {
      this.pendingFrames.push(frame);
    }
  }

  private handleMessage(raw: unknown): void {
    let message: BridgeServerMessage;
    try {
      message = JSON.parse(String(raw)) as BridgeServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'started':
        this.pid = message.pid;
        break;
      case 'stdout':
        this.stdout.pushText(
          this.stdoutDecoder.decode(decodeBase64(message.data ?? ''), { stream: true }),
        );
        break;
      case 'stderr': {
        const text = this.stderrDecoder.decode(decodeBase64(message.data ?? ''), { stream: true });
        this.stderrTail = (this.stderrTail + text).slice(-8000);
        break;
      }
      case 'exit': {
        if (this.exited) break;
        this.exited = true;
        this.currentExitCode = typeof message.code === 'number' ? message.code : null;
        this.currentSignalCode = message.signal ?? null;
        this.stdout.pushText(this.stdoutDecoder.decode());
        this.stdout.finish();
        this.emit('exit', this.currentExitCode, this.currentSignalCode);
        try {
          this.socket.close();
        } catch {
          // Already closed.
        }
        break;
      }
      case 'error':
        this.emit('error', new Error(`Claudian bridge: ${message.message ?? 'unknown error'}`));
        break;
      default:
        break;
    }
  }
}

export function createRemoteSpawnFunction(): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess =>
    new RemoteSpawnedProcess(options) as unknown as SpawnedProcess;
}
