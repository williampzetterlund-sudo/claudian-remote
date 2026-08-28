import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { Platform } from 'obsidian';

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

/**
 * True when the CLI must run on the bridge host instead of being spawned
 * locally: under Ignis (browser), on Obsidian mobile (Capacitor has no
 * child_process), or when the user explicitly configured a bridge URL
 * (desktop opt-in).
 */
export function isRemoteRuntime(): boolean {
  if (isIgnisRuntime()) return true;
  if (Platform.isMobileApp) return true;
  return hasBridgeOverride();
}

/** True when a bridge URL is explicitly configured on this device. */
export function hasBridgeOverride(): boolean {
  return !!readLocalStorage(IGNIS_BRIDGE_URL_STORAGE_KEY);
}

/**
 * True when spawning through the bridge can plausibly work: Ignis derives a
 * same-origin default, every other remote runtime needs an explicit URL.
 */
export function isBridgeConfigured(): boolean {
  return isIgnisRuntime() || hasBridgeOverride();
}

export class BridgeNotConfiguredError extends Error {
  constructor() {
    super(
      'Claudian bridge: no bridge URL is configured on this device. '
      + 'Open Settings → Claudian → Remote bridge and enter the bridge URL and token.',
    );
    this.name = 'BridgeNotConfiguredError';
  }
}

/** Safe localStorage reads/writes shared with the settings UI. */
export function readBridgeSetting(key: string): string | null {
  return readLocalStorage(key);
}

export function writeBridgeSetting(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable; the setting simply does not persist.
  }
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

/**
 * Session ids with a live CLI process on the bridge. Empty outside configured
 * remote runtimes or when the bridge is unreachable — callers treat that as
 * "nothing to follow", never as an error.
 */
export async function fetchLiveBridgeSessionIds(): Promise<Set<string>> {
  try {
    if (!isRemoteRuntime() || !isBridgeConfigured()) return new Set();
    const response = await fetch(resolveBridgeHttpUrl('/sessions'));
    if (!response.ok) return new Set();
    const raw = (await response.json()) as {
      sessions?: Array<{ sessionId?: string | null }>;
    };
    return new Set(
      (raw.sessions ?? [])
        .map((session) => session.sessionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
  } catch {
    return new Set();
  }
}

/**
 * Resolves the bridge config, waiting for the in-flight fetch (or starting
 * one) when needed. Returns null outside configured remote runtimes.
 */
export async function getBridgeConfigAsync(): Promise<IgnisBridgeConfig | null> {
  if (cachedBridgeConfig) return cachedBridgeConfig;
  if (!isRemoteRuntime() || !isBridgeConfigured()) return null;
  if (!bridgeConfigRequest) ensureIgnisBridgeConfig();
  if (bridgeConfigRequest) await bridgeConfigRequest;
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
  if (!isRemoteRuntime() || !isBridgeConfigured()) return;
  if (cachedBridgeConfig || bridgeConfigRequest) return;
  bridgeConfigRequest = (async () => {
    try {
      await refreshBridgeConfig();
    } catch {
      // Bridge unreachable; spawning will surface its own error later.
    } finally {
      bridgeConfigRequest = null;
    }
  })();
}

/**
 * Fetches /config unconditionally (bypassing the cache) and installs the
 * result. Used by the settings "test connection" button after the user edits
 * the URL or token, and internally by ensureIgnisBridgeConfig.
 */
export async function refreshBridgeConfig(): Promise<IgnisBridgeConfig> {
  const response = await fetch(resolveBridgeHttpUrl('/config'));
  if (!response.ok) {
    throw new Error(`bridge /config responded with HTTP ${response.status}`);
  }
  const config = (await response.json()) as IgnisBridgeConfig;
  cachedBridgeConfig = config;
  if (typeof window !== 'undefined') {
    (window as IgnisWindow).__claudianBridgeConfig = { ...config, makeFsUrl };
  }
  return config;
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
// at module load in every remote runtime with a resolvable bridge (no-op on
// plain desktop and on mobile before the bridge URL has been configured).
if (typeof window !== 'undefined') {
  try {
    ensureIgnisBridgeConfig();
  } catch {
    // Never let an early probe break plugin load.
  }
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
  | { type: 'attach'; sessionId: string; sinceSeq: number }
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

/**
 * Mobile webviews (Obsidian iOS) drop the WebSocket every time the app is
 * backgrounded, while the CLI process stays alive on the bridge. The facade
 * reconnects with an `attach` frame carrying the highest output seq it has
 * seen; the bridge replays what was missed. Attempts back off exponentially
 * (timers freeze while backgrounded, so attempts only burn in the foreground)
 * and a visibilitychange listener short-circuits the backoff on return.
 */
export const IGNIS_BRIDGE_MAX_RECONNECT_ATTEMPTS = 20;
export const IGNIS_BRIDGE_RECONNECT_BASE_DELAY_MS = 500;
export const IGNIS_BRIDGE_RECONNECT_MAX_DELAY_MS = 15_000;
export const IGNIS_BRIDGE_PONG_TIMEOUT_MS = 8_000;

interface BridgeServerMessage {
  type?: string;
  pid?: number;
  data?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
  seq?: number;
  sessionId?: string;
  attached?: boolean;
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
  private sessionId: string | null = null;
  private lastSeq = 0;
  private currentConnectMode: 'start' | 'attach' = 'start';
  private reconnectAttempts = 0;
  private reconnectTimer: number | undefined;
  private pongTimer: number | undefined;
  private visibilityHandler: (() => void) | null = null;

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

    this.socket = this.connect('start');

    // Mobil-backgrounding fryser JS och kan lämna socketen halvdöd. När appen
    // blir synlig igen: hoppa över kvarvarande backoff, eller hälsokolla en
    // till synes öppen socket med ping + pong-deadline.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'visible') this.onForeground();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

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

  private connect(mode: 'start' | 'attach'): WebSocket {
    this.currentConnectMode = mode;
    const socket = new WebSocket(resolveBridgeUrl());
    socket.onopen = () => {
      if (mode === 'attach') {
        socket.send(JSON.stringify({
          type: 'attach',
          sessionId: this.sessionId ?? '',
          sinceSeq: this.lastSeq,
        } satisfies BridgeClientMessage));
      } else {
        socket.send(JSON.stringify({
          type: 'start',
          args: [...this.options.args],
          cwd: this.options.cwd,
          env: this.options.env,
        } satisfies BridgeClientMessage));
      }
      this.started = true;
      // The viewport identifies which remote device a bridge-journal entry
      // came from (phone vs. desktop); the browser side has no other channel.
      const viewport = typeof window !== 'undefined'
        ? `${window.innerWidth}x${window.innerHeight}`
        : 'unknown';
      socket.send(JSON.stringify({
        type: 'clientlog',
        message: `${mode === 'attach' ? `reattached (attempt ${this.reconnectAttempts})` : 'spawned'} viewport=${viewport}`,
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
      this.handleSocketClose();
    };
    return socket;
  }

  private handleSocketClose(): void {
    if (this.keepaliveTimer !== undefined) {
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    this.clearPongTimer();
    if (this.exited) return;
    // A live server-side session survives the connection: reconnect instead
    // of tearing down. Without a sessionId (one-shot query, or init never
    // arrived) there is nothing to reattach to — fail like before.
    if (!this.wasKilled && this.sessionId) {
      this.diagnostic('socket lost with live session; scheduling reattach');
      this.scheduleReconnect();
      return;
    }
    this.finalizeLostConnection();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.exited) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > IGNIS_BRIDGE_MAX_RECONNECT_ATTEMPTS) {
      this.finalizeLostConnection(
        `Claudian bridge: gave up reconnecting after ${IGNIS_BRIDGE_MAX_RECONNECT_ATTEMPTS} attempts`,
      );
      return;
    }
    const delay = Math.min(
      IGNIS_BRIDGE_RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      IGNIS_BRIDGE_RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.exited) return;
      this.socket = this.connect('attach');
    }, delay);
  }

  private onForeground(): void {
    if (this.exited || this.wasKilled) return;
    if (this.reconnectTimer !== undefined) {
      // The user is back — skip the remaining backoff.
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.socket = this.connect('attach');
      return;
    }
    if (this.socket.readyState === 1) {
      // The socket may be half-dead after a suspend: ping with a deadline;
      // a missing pong forces close → handleSocketClose → reattach.
      try {
        this.socket.send(JSON.stringify({ type: 'ping' } satisfies BridgeClientMessage));
      } catch {
        return;
      }
      this.clearPongTimer();
      this.pongTimer = window.setTimeout(() => {
        this.pongTimer = undefined;
        this.diagnostic('no pong after foreground; forcing socket close');
        try {
          this.socket.close();
        } catch {
          // Already closed.
        }
      }, IGNIS_BRIDGE_PONG_TIMEOUT_MS);
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== undefined) {
      window.clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private cleanupListeners(): void {
    if (this.keepaliveTimer !== undefined) {
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearPongTimer();
    if (this.visibilityHandler && typeof document !== 'undefined'
      && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private finalizeLostConnection(detail?: string): void {
    if (this.exited) return;
    this.exited = true;
    this.currentSignalCode = 'SIGTERM';
    this.cleanupListeners();
    this.emit('error', new Error(
      (detail ?? 'Claudian bridge: connection closed before the process exited')
      + (this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-2000)}` : ''),
    ));
    this.stdout.finish();
    this.emit('exit', null, 'SIGTERM');
  }

  /**
   * Drops duplicate output after a reattach: the bridge replays frames with
   * seq > sinceSeq, but a frame can race the attach handshake. Old bridges
   * send no seq — then nothing is filtered.
   */
  private isDuplicateFrame(message: BridgeServerMessage): boolean {
    if (typeof message.seq !== 'number') return false;
    if (message.seq <= this.lastSeq) return true;
    this.lastSeq = message.seq;
    return false;
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
        if (typeof message.sessionId === 'string' && message.sessionId) {
          this.sessionId = message.sessionId;
        }
        // On a warm start-attach (SDK-level --resume) the seq baseline stops
        // a later reattach from replaying output sent before this client
        // existed. On reattach the baseline is this client's own lastSeq.
        if (this.currentConnectMode === 'start' && typeof message.seq === 'number') {
          this.lastSeq = message.seq;
        }
        this.reconnectAttempts = 0;
        break;
      case 'session':
        if (typeof message.sessionId === 'string' && message.sessionId) {
          this.sessionId = message.sessionId;
        }
        break;
      case 'pong':
        this.clearPongTimer();
        break;
      case 'attach_failed':
        // The process is gone on the bridge (reaped or crashed). Fail like a
        // lost connection: Claudian's next message recovers via --resume.
        this.diagnostic(`attach failed: ${message.message ?? 'unknown'}`);
        this.finalizeLostConnection(
          `Claudian bridge: ${message.message ?? 'process no longer available'}`,
        );
        break;
      case 'stdout':
        if (this.isDuplicateFrame(message)) break;
        this.stdout.pushText(
          this.stdoutDecoder.decode(decodeBase64(message.data ?? ''), { stream: true }),
        );
        break;
      case 'stderr': {
        if (this.isDuplicateFrame(message)) break;
        const text = this.stderrDecoder.decode(decodeBase64(message.data ?? ''), { stream: true });
        this.stderrTail = (this.stderrTail + text).slice(-8000);
        break;
      }
      case 'exit': {
        if (this.exited) break;
        this.exited = true;
        this.currentExitCode = typeof message.code === 'number' ? message.code : null;
        this.currentSignalCode = message.signal ?? null;
        this.cleanupListeners();
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
