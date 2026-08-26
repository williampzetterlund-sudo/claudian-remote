import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

import { encodeVaultPathForSDK } from '@/providers/claude/history/sdkSessionPaths';
import { createCustomSpawnFunction } from '@/providers/claude/runtime/customSpawn';
import {
  createRemoteSpawnFunction,
  getIgnisHostPath,
  IGNIS_BRIDGE_MAX_RECONNECT_ATTEMPTS,
  IGNIS_BRIDGE_RECONNECT_MAX_DELAY_MS,
  IGNIS_BRIDGE_URL_STORAGE_KEY,
  isIgnisRuntime,
  resolveBridgeHttpUrl,
  resolveBridgeUrl,
} from '@/providers/claude/runtime/remoteSpawn';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

type BridgeMessage = Record<string, unknown>;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: BridgeMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  dropConnection(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'abnormal closure' });
  }

  sentMessages(): BridgeMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as BridgeMessage);
  }

  protocolMessages(): BridgeMessage[] {
    return this.sentMessages().filter((message) => message.type !== 'clientlog');
  }
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const BRIDGE_URL = 'ws://bridge.test:9';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

if (!('localStorage' in globalThis)) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
}

describe('remoteSpawn', () => {
  const globalWithWindow = globalThis as unknown as Record<string, unknown>;
  const originalWebSocket = globalWithWindow.WebSocket;

  const spawnOptions = (): SpawnOptions => ({
    command: '/ignis-bridge/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/vaults/WZE',
    env: { FOO: 'bar' },
    signal: new AbortController().signal,
  });

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalWithWindow.WebSocket = FakeWebSocket;
    globalWithWindow.__ignis = {};
    localStorage.setItem(IGNIS_BRIDGE_URL_STORAGE_KEY, BRIDGE_URL);
  });

  afterEach(() => {
    // Close every fake socket so keepalive intervals are cleared and jest
    // can exit without dangling timers.
    for (const socket of FakeWebSocket.instances) {
      if (socket.readyState !== 3) socket.dropConnection();
    }
    delete globalWithWindow.__ignis;
    globalWithWindow.WebSocket = originalWebSocket;
    localStorage.clear();
    (spawn as jest.Mock).mockReset();
  });

  describe('isIgnisRuntime', () => {
    it('is true only when window.__ignis exists', () => {
      expect(isIgnisRuntime()).toBe(true);
      delete globalWithWindow.__ignis;
      expect(isIgnisRuntime()).toBe(false);
    });
  });

  describe('resolveBridgeUrl', () => {
    it('prefers the localStorage override', () => {
      expect(resolveBridgeUrl()).toBe(BRIDGE_URL);
    });

    it('falls back to loopback when no location and no override exist', () => {
      localStorage.clear();
      expect(resolveBridgeUrl()).toBe('ws://127.0.0.1:8095');
    });
  });

  describe('resolveBridgeHttpUrl', () => {
    it('maps the ws base to http and appends the route', () => {
      expect(resolveBridgeHttpUrl('/config')).toBe('http://bridge.test:9/config');
    });

    it('maps a wss override to https', () => {
      localStorage.setItem(IGNIS_BRIDGE_URL_STORAGE_KEY, 'wss://ignis.example/claudian-bridge');
      expect(resolveBridgeHttpUrl('/fs/stat')).toBe('https://ignis.example/claudian-bridge/fs/stat');
    });
  });

  describe('getIgnisHostPath and SDK vault encoding', () => {
    const setVaultRoot = (vaultRoot: string | undefined): void => {
      globalWithWindow.__claudianBridgeConfig = vaultRoot ? { vaultRoot } : undefined;
    };

    afterEach(() => {
      delete globalWithWindow.__claudianBridgeConfig;
    });

    it('maps the browser vault root "/" to the host vault root', () => {
      setVaultRoot('/home/user/ignis/vaults/WZE');
      expect(getIgnisHostPath('/')).toBe('/home/user/ignis/vaults/WZE');
      expect(getIgnisHostPath('/notes/a.md')).toBe('/home/user/ignis/vaults/WZE/notes/a.md');
      expect(getIgnisHostPath('/home/user/ignis/vaults/WZE/x')).toBe('/home/user/ignis/vaults/WZE/x');
    });

    it('is the identity without a bridge config or outside Ignis', () => {
      setVaultRoot(undefined);
      expect(getIgnisHostPath('/')).toBe('/');
      setVaultRoot('/home/user/ignis/vaults/WZE');
      delete globalWithWindow.__ignis;
      expect(getIgnisHostPath('/')).toBe('/');
    });

    it('encodes the vault path with the host mapping applied', () => {
      setVaultRoot('/home/user/ignis/vaults/WZE');
      expect(encodeVaultPathForSDK('/')).toBe('-home-user-ignis-vaults-WZE');
    });
  });

  describe('createRemoteSpawnFunction', () => {
    it('connects to the bridge and sends start with args, cwd, and env', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      expect(FakeWebSocket.instances).toHaveLength(1);
      const socket = FakeWebSocket.instances[0];
      expect(socket.url).toBe(BRIDGE_URL);

      socket.open();
      expect(socket.protocolMessages()[0]).toEqual({
        type: 'start',
        args: ['--output-format', 'stream-json'],
        cwd: '/vaults/WZE',
        env: { FOO: 'bar' },
      });
      expect(process.exitCode).toBeNull();
      expect(process.killed).toBe(false);
    });

    it('queues stdin written before the socket opens and flushes it in order', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];

      expect(process.stdin.write('{"first":true}\n')).toBe(true);
      process.stdin.end();
      expect(socket.sent).toHaveLength(0);

      socket.open();
      const messages = socket.protocolMessages();
      expect(messages.map((message) => message.type)).toEqual([
        'start',
        'stdin',
        'stdin_end',
      ]);
      expect(base64ToUtf8(messages[1].data as string)).toBe('{"first":true}\n');
    });

    it('sends stdin immediately once the socket is open', () => {
      createRemoteSpawnFunction()(spawnOptions()).stdin.write('x');
      const socket = FakeWebSocket.instances[0];
      socket.open();

      const process = createRemoteSpawnFunction()(spawnOptions());
      const second = FakeWebSocket.instances[1];
      second.open();
      process.stdin.write('{"now":1}\n');
      const messages = second.protocolMessages();
      expect(messages[1].type).toBe('stdin');
      expect(base64ToUtf8(messages[1].data as string)).toBe('{"now":1}\n');
    });

    it('decodes stdout base64 as streamed UTF-8, handling split multi-byte chars', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];
      socket.open();

      const received: string[] = [];
      process.stdout.on('data', (chunk: string) => received.push(chunk));

      const bytes = new TextEncoder().encode('rad å\n');
      const splitAt = 4; // splits the two-byte "å" across frames
      const toBinary = (part: Uint8Array): string =>
        Array.from(part, (byte) => String.fromCharCode(byte)).join('');
      socket.receive({ type: 'stdout', data: btoa(toBinary(bytes.slice(0, splitAt))) });
      socket.receive({ type: 'stdout', data: btoa(toBinary(bytes.slice(splitAt))) });

      expect(received.join('')).toBe('rad å\n');
    });

    it('emits exit with code and signal and updates exitCode', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];
      socket.open();

      const exits: Array<[number | null, string | null]> = [];
      process.on('exit', (code, signal) => exits.push([code, signal]));
      socket.receive({ type: 'started', pid: 4711 });
      socket.receive({ type: 'exit', code: 0, signal: null });

      expect(exits).toEqual([[0, null]]);
      expect(process.exitCode).toBe(0);
    });

    it('emits error for bridge error messages', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];
      socket.open();

      const errors: Error[] = [];
      process.on('error', (error) => errors.push(error));
      socket.receive({ type: 'error', message: 'spawn misslyckades: boom' });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('spawn misslyckades: boom');
    });

    it('emits error and synthetic exit when the socket closes before exit', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];
      socket.open();

      const errors: Error[] = [];
      const exits: Array<[number | null, string | null]> = [];
      process.on('error', (error) => errors.push(error));
      process.on('exit', (code, signal) => exits.push([code, signal]));

      socket.dropConnection();

      expect(errors).toHaveLength(1);
      expect(exits).toEqual([[null, 'SIGTERM']]);
    });

    it('does not emit a synthetic exit when the socket closes after exit', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];
      socket.open();

      const exits: Array<[number | null, string | null]> = [];
      process.on('exit', (code, signal) => exits.push([code, signal]));
      socket.receive({ type: 'exit', code: 1, signal: null });
      socket.dropConnection();

      expect(exits).toEqual([[1, null]]);
    });

    it('sends kill frames and marks the process killed', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];
      socket.open();

      expect(process.kill('SIGKILL')).toBe(true);
      expect(process.killed).toBe(true);
      expect(socket.sentMessages()).toContainEqual({ type: 'kill', signal: 'SIGKILL' });
    });

    it('kills with SIGTERM when the abort signal fires', () => {
      const controller = new AbortController();
      createRemoteSpawnFunction()({ ...spawnOptions(), signal: controller.signal });
      const socket = FakeWebSocket.instances[0];
      socket.open();

      controller.abort();

      expect(socket.sentMessages()).toContainEqual({ type: 'kill', signal: 'SIGTERM' });
      expect(socket.sentMessages()).toContainEqual({
        type: 'clientlog',
        message: 'abort-signal fired',
      });
    });

    it('sends keepalive pings while the socket is open and stops after close', () => {
      jest.useFakeTimers();
      try {
        createRemoteSpawnFunction()(spawnOptions());
        const socket = FakeWebSocket.instances[0];
        socket.open();

        jest.advanceTimersByTime(31_000);
        expect(socket.sentMessages()).toContainEqual({ type: 'ping' });

        socket.receive({ type: 'pong' });
        socket.receive({ type: 'exit', code: 0, signal: null });
        const sentBeforeIdle = socket.sent.length;
        jest.advanceTimersByTime(120_000);
        expect(socket.sent.length).toBe(sentBeforeIdle);
      } finally {
        jest.useRealTimers();
      }
    });

    it('supports once and off for exit listeners', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const socket = FakeWebSocket.instances[0];
      socket.open();

      const onceExits: Array<number | null> = [];
      const removed: Array<number | null> = [];
      const removedListener = (code: number | null): void => {
        removed.push(code);
      };
      process.once('exit', (code) => onceExits.push(code));
      process.on('exit', removedListener);
      process.off('exit', removedListener);

      socket.receive({ type: 'exit', code: 0, signal: null });
      socket.receive({ type: 'exit', code: 0, signal: null });

      expect(onceExits).toEqual([0]);
      expect(removed).toEqual([]);
    });
  });

  describe('reconnect with attach and replay', () => {
    it('reattaches with sessionId and sinceSeq after an abnormal close', () => {
      jest.useFakeTimers();
      try {
        createRemoteSpawnFunction()(spawnOptions());
        const first = FakeWebSocket.instances[0];
        first.open();
        first.receive({ type: 'session', sessionId: 'sess-1' });
        first.receive({ type: 'stdout', seq: 1, data: utf8ToBase64('a\n') });
        first.receive({ type: 'stdout', seq: 2, data: utf8ToBase64('b\n') });

        first.dropConnection();
        expect(FakeWebSocket.instances).toHaveLength(1);
        jest.advanceTimersByTime(500);
        expect(FakeWebSocket.instances).toHaveLength(2);

        const second = FakeWebSocket.instances[1];
        second.open();
        expect(second.protocolMessages()[0]).toEqual({
          type: 'attach',
          sessionId: 'sess-1',
          sinceSeq: 2,
        });
        second.receive({ type: 'exit', code: 0, signal: null });
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not emit error or synthetic exit while a reattach is pending', () => {
      jest.useFakeTimers();
      try {
        const process = createRemoteSpawnFunction()(spawnOptions());
        const errors: Error[] = [];
        const exits: Array<number | null> = [];
        process.on('error', (error: Error) => errors.push(error));
        process.on('exit', (code: number | null) => exits.push(code));

        const first = FakeWebSocket.instances[0];
        first.open();
        first.receive({ type: 'session', sessionId: 'sess-2' });
        first.dropConnection();

        expect(errors).toEqual([]);
        expect(exits).toEqual([]);

        jest.advanceTimersByTime(500);
        FakeWebSocket.instances[1].open();
        FakeWebSocket.instances[1].receive({ type: 'exit', code: 0, signal: null });
        expect(exits).toEqual([0]);
        expect(errors).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('drops replayed frames it has already seen, keeps new ones', () => {
      jest.useFakeTimers();
      try {
        const process = createRemoteSpawnFunction()(spawnOptions());
        const chunks: string[] = [];
        (process.stdout as unknown as { on(event: string, cb: (data: string) => void): void })
          .on('data', (data: string) => chunks.push(data));

        const first = FakeWebSocket.instances[0];
        first.open();
        first.receive({ type: 'session', sessionId: 'sess-3' });
        first.receive({ type: 'stdout', seq: 1, data: utf8ToBase64('ett\n') });
        first.dropConnection();

        jest.advanceTimersByTime(500);
        const second = FakeWebSocket.instances[1];
        second.open();
        // Bryggan replayar från sinceSeq, men en frame kan hinna dubbleras.
        second.receive({ type: 'stdout', seq: 1, data: utf8ToBase64('ett\n') });
        second.receive({ type: 'stdout', seq: 2, data: utf8ToBase64('två\n') });

        expect(chunks.join('')).toBe('ett\ntvå\n');
        second.receive({ type: 'exit', code: 0, signal: null });
      } finally {
        jest.useRealTimers();
      }
    });

    it('baselines sinceSeq from a warm start-attach so old output is not replayed', () => {
      jest.useFakeTimers();
      try {
        createRemoteSpawnFunction()(spawnOptions());
        const first = FakeWebSocket.instances[0];
        first.open();
        first.receive({ type: 'started', pid: 7, attached: true, sessionId: 'sess-4', seq: 42 });
        first.dropConnection();

        jest.advanceTimersByTime(500);
        const second = FakeWebSocket.instances[1];
        second.open();
        expect(second.protocolMessages()[0]).toEqual({
          type: 'attach',
          sessionId: 'sess-4',
          sinceSeq: 42,
        });
        second.receive({ type: 'exit', code: 0, signal: null });
      } finally {
        jest.useRealTimers();
      }
    });

    it('tears down with error and synthetic exit when attach fails', () => {
      jest.useFakeTimers();
      try {
        const process = createRemoteSpawnFunction()(spawnOptions());
        const errors: Error[] = [];
        const exits: Array<[number | null, string | null]> = [];
        process.on('error', (error: Error) => errors.push(error));
        process.on('exit', (code: number | null, signal: string | null) => exits.push([code, signal]));

        const first = FakeWebSocket.instances[0];
        first.open();
        first.receive({ type: 'session', sessionId: 'sess-5' });
        first.dropConnection();

        jest.advanceTimersByTime(500);
        const second = FakeWebSocket.instances[1];
        second.open();
        second.receive({ type: 'attach_failed', message: 'ingen levande process' });

        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('ingen levande process');
        expect(exits).toEqual([[null, 'SIGTERM']]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('gives up after the max number of reconnect attempts', () => {
      jest.useFakeTimers();
      try {
        const process = createRemoteSpawnFunction()(spawnOptions());
        const errors: Error[] = [];
        process.on('error', (error: Error) => errors.push(error));
        process.on('exit', () => {});

        const first = FakeWebSocket.instances[0];
        first.open();
        first.receive({ type: 'session', sessionId: 'sess-6' });
        first.dropConnection();

        for (let attempt = 0; attempt < IGNIS_BRIDGE_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
          jest.advanceTimersByTime(IGNIS_BRIDGE_RECONNECT_MAX_DELAY_MS);
          const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
          if (latest.readyState !== 3) latest.dropConnection();
        }
        jest.advanceTimersByTime(IGNIS_BRIDGE_RECONNECT_MAX_DELAY_MS);

        expect(FakeWebSocket.instances).toHaveLength(1 + IGNIS_BRIDGE_MAX_RECONNECT_ATTEMPTS);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('gave up reconnecting');
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps the old teardown for sessions the bridge never identified', () => {
      const process = createRemoteSpawnFunction()(spawnOptions());
      const errors: Error[] = [];
      process.on('error', (error: Error) => errors.push(error));
      process.on('exit', () => {});

      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.dropConnection();

      expect(errors).toHaveLength(1);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });

  describe('createCustomSpawnFunction under Ignis', () => {
    it('delegates to the remote spawn instead of child_process', () => {
      const spawnFunction = createCustomSpawnFunction('/usr/bin');
      const process = spawnFunction(spawnOptions());

      expect(spawn).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(process.stdin).toBeDefined();
      expect(process.stdout).toBeDefined();
    });
  });
});

describe('remoteSpawn stdin round-trip encoding', () => {
  it('base64 helpers in the test agree with themselves', () => {
    expect(base64ToUtf8(utf8ToBase64('åäö €'))).toBe('åäö €');
  });
});
