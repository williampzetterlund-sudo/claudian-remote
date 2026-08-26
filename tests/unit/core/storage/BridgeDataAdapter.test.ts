import { BridgeDataAdapter } from '@/core/storage/BridgeDataAdapter';
import { IGNIS_BRIDGE_URL_STORAGE_KEY } from '@/providers/claude/runtime/remoteSpawn';

const VAULT_ROOT = '/home/host/vault';

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

interface RecordedRequest {
  url: URL;
  init?: RequestInit;
}

describe('BridgeDataAdapter', () => {
  const globalWithFetch = globalThis as unknown as Record<string, unknown>;
  const originalFetch = globalWithFetch.fetch;
  let requests: RecordedRequest[];
  let responder: (url: URL, init?: RequestInit) => Response;

  beforeEach(() => {
    requests = [];
    responder = () => new Response('{}', { status: 200 });
    // Bryggkonfigen hämtas via /config första gången en host-sökväg behövs.
    globalWithFetch.fetch = jest.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/config')) {
        return new Response(JSON.stringify({ vaultRoot: VAULT_ROOT, home: '/home/host' }), { status: 200 });
      }
      requests.push({ url, init });
      return responder(url, init);
    });
    localStorage.setItem(IGNIS_BRIDGE_URL_STORAGE_KEY, 'wss://bridge.test/claudian-bridge');
    (globalThis as unknown as Record<string, unknown>).__ignis = undefined;
  });

  afterEach(() => {
    globalWithFetch.fetch = originalFetch;
    localStorage.clear();
  });

  it('prefixes vault-relative paths with the host vault root', async () => {
    const adapter = new BridgeDataAdapter();
    responder = () => new Response('innehåll', { status: 200 });
    const content = await adapter.read('.claudian/sessions/a.json');
    expect(content).toBe('innehåll');
    expect(requests[0].url.searchParams.get('path'))
      .toBe(`${VAULT_ROOT}/.claudian/sessions/a.json`);
    expect(requests[0].url.pathname.endsWith('/fs/read')).toBe(true);
  });

  it('maps readdir entries to vault-relative full paths', async () => {
    const adapter = new BridgeDataAdapter();
    responder = () => new Response(JSON.stringify({
      entries: [
        { name: 'a.json', type: 'file' },
        { name: 'undermapp', type: 'dir' },
      ],
    }), { status: 200 });
    const listing = await adapter.list('.claudian/sessions');
    expect(listing.files).toEqual(['.claudian/sessions/a.json']);
    expect(listing.folders).toEqual(['.claudian/sessions/undermapp']);
  });

  it('throws ENOENT-coded errors for 404 reads and returns null stat', async () => {
    const adapter = new BridgeDataAdapter();
    responder = () => new Response('{"error":"not found"}', { status: 404 });
    await expect(adapter.read('.claudian/missing.json')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await adapter.stat('.claudian/missing.json')).toBeNull();
    expect(await adapter.exists('.claudian/missing.json')).toBe(false);
  });

  it('POSTs writes with the content as body', async () => {
    const adapter = new BridgeDataAdapter();
    responder = () => new Response('{"ok":true}', { status: 200 });
    await adapter.write('.claudian/sessions/a.json', '{"id":"a"}');
    expect(requests[0].url.pathname.endsWith('/fs/write')).toBe(true);
    expect(requests[0].init?.method).toBe('POST');
    expect(requests[0].init?.body).toBe('{"id":"a"}');
  });

  it('propagates EPERM for writes rejected by the scope guard', async () => {
    const adapter = new BridgeDataAdapter();
    responder = () => new Response('{"error":"path outside writable scope"}', { status: 403 });
    await expect(adapter.write('note.md', 'x')).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('sends rename destination as a host path', async () => {
    const adapter = new BridgeDataAdapter();
    responder = () => new Response('{"ok":true}', { status: 200 });
    await adapter.rename('.claudian/sessions/a.json', '.claudian/sessions/b.json');
    expect(requests[0].url.searchParams.get('to')).toBe(`${VAULT_ROOT}/.claudian/sessions/b.json`);
  });

  it('maps stat payloads to Obsidian Stat objects', async () => {
    const adapter = new BridgeDataAdapter();
    responder = () => new Response(JSON.stringify({
      size: 42, mtimeMs: 1000.6, isFile: true, isDirectory: false,
    }), { status: 200 });
    expect(await adapter.stat('.claudian/sessions/a.json')).toEqual({
      type: 'file', ctime: 1001, mtime: 1001, size: 42,
    });
  });
});
