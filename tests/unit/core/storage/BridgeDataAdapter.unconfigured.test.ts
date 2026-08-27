import { BridgeDataAdapter } from '@/core/storage/BridgeDataAdapter';

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

/**
 * Utan konfigurerad brygga (ingen URL i localStorage) körs adaptern under
 * plugin-onload på en färsk mobil enhet. Den FÅR inte kasta: det dödar hela
 * pluginladdningen — inklusive kommandot som konfigurerar bryggan.
 */
describe('BridgeDataAdapter without a configured bridge', () => {
  const globalWithFetch = globalThis as unknown as Record<string, unknown>;
  const originalFetch = globalWithFetch.fetch;
  let fetchCalls: number;

  beforeEach(() => {
    localStorage.clear();
    fetchCalls = 0;
    globalWithFetch.fetch = jest.fn(async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    });
  });

  afterEach(() => {
    globalWithFetch.fetch = originalFetch;
    localStorage.clear();
  });

  it('reports files as missing instead of throwing config errors', async () => {
    const adapter = new BridgeDataAdapter();
    expect(await adapter.exists('.claudian/claudian-settings.json')).toBe(false);
    expect(await adapter.stat('.claudian/claudian-settings.json')).toBeNull();
    expect(await adapter.list('.claudian/sessions')).toEqual({ files: [], folders: [] });
  });

  it('throws ENOENT for reads — the normal missing-file signal callers handle', async () => {
    const adapter = new BridgeDataAdapter();
    await expect(adapter.read('.claudian/claudian-settings.json'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves writes as silent no-ops so plugin onload survives', async () => {
    const adapter = new BridgeDataAdapter();
    await expect(adapter.write('.claudian/sessions/a.json', '{}')).resolves.toBeUndefined();
    await expect(adapter.mkdir('.claudian/sessions')).resolves.toBeUndefined();
    await expect(adapter.remove('.claudian/sessions/a.json')).resolves.toBeUndefined();
    await expect(adapter.rename('.claudian/a.json', '.claudian/b.json')).resolves.toBeUndefined();
  });

  it('never touches the network while unconfigured', async () => {
    const adapter = new BridgeDataAdapter();
    await adapter.exists('.claudian/x');
    await adapter.list('.claudian');
    await adapter.write('.claudian/x', 'data');
    expect(fetchCalls).toBe(0);
  });
});
