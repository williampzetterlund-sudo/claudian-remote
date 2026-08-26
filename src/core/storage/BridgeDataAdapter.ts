import type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from 'obsidian';

import {
  getBridgeConfigAsync,
  resolveBridgeHttpUrl,
} from '../../providers/claude/runtime/remoteSpawn';

/**
 * DataAdapter that reads and writes the HOST's vault copy through the bridge
 * HTTP fs API. Used in non-Ignis remote runtimes (Obsidian mobile, desktop
 * bridge opt-in) where `.claudian/` — session metadata, client settings — must
 * be shared with the host instead of living in the device's local vault copy:
 * hidden files do not travel through vault sync, and the CLI-side state lives
 * on the host anyway.
 *
 * Writes are additionally scoped server-side to the `.claudian/` subtree.
 */
export class BridgeDataAdapter implements DataAdapter {
  private vaultRootCache: string | null = null;

  getName(): string {
    return 'claudian-bridge';
  }

  /** VaultFileAdapter casts to a desktop adapter for this; report host paths. */
  getBasePath(): string {
    return this.vaultRootCache ?? '';
  }

  private async hostPath(normalizedPath: string): Promise<string> {
    if (!this.vaultRootCache) {
      const config = await getBridgeConfigAsync();
      if (!config?.vaultRoot) {
        throw withCode(new Error('BridgeDataAdapter: bridge config unavailable'), 'ENOENT');
      }
      this.vaultRootCache = config.vaultRoot;
    }
    if (!normalizedPath || normalizedPath === '/' || normalizedPath === '.') {
      return this.vaultRootCache;
    }
    return `${this.vaultRootCache}/${normalizedPath}`;
  }

  private async request(
    route: string,
    params: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response> {
    const base = resolveBridgeHttpUrl(route);
    const separator = base.includes('?') ? '&' : '?';
    const query = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    return fetch(`${base}${separator}${query}`, init);
  }

  private async readRequest(route: string, targetPath: string): Promise<Response> {
    const response = await this.request(route, { path: await this.hostPath(targetPath) });
    if (response.status === 404) {
      throw withCode(new Error(`ENOENT: no such file or directory, '${targetPath}'`), 'ENOENT');
    }
    if (!response.ok) {
      throw withCode(
        new Error(`bridge fs ${route} failed (${response.status}) for '${targetPath}'`),
        response.status === 403 ? 'EPERM' : 'EIO',
      );
    }
    return response;
  }

  private async writeRequest(
    route: string,
    targetPath: string,
    body?: ArrayBuffer | string,
    extraParams: Record<string, string> = {},
  ): Promise<void> {
    const response = await this.request(
      route,
      { path: await this.hostPath(targetPath), ...extraParams },
      {
        method: 'POST',
        // text/plain keeps the request CORS-simple (no preflight needed).
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body,
      },
    );
    if (response.status === 404) {
      throw withCode(new Error(`ENOENT: no such file or directory, '${targetPath}'`), 'ENOENT');
    }
    if (!response.ok) {
      throw withCode(
        new Error(`bridge fs ${route} failed (${response.status}) for '${targetPath}'`),
        response.status === 403 ? 'EPERM' : 'EIO',
      );
    }
  }

  async exists(normalizedPath: string): Promise<boolean> {
    const response = await this.request(
      '/fs/stat',
      { path: await this.hostPath(normalizedPath) },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      throw withCode(new Error(`bridge fs stat failed (${response.status})`), 'EIO');
    }
    return true;
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    const response = await this.request(
      '/fs/stat',
      { path: await this.hostPath(normalizedPath) },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw withCode(new Error(`bridge fs stat failed (${response.status})`), 'EIO');
    }
    const raw = (await response.json()) as {
      size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean;
    };
    return {
      type: raw.isDirectory ? 'folder' : 'file',
      ctime: Math.round(raw.mtimeMs),
      mtime: Math.round(raw.mtimeMs),
      size: raw.size,
    };
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    const response = await this.readRequest('/fs/readdir', normalizedPath);
    const raw = (await response.json()) as { entries: Array<{ name: string; type: string }> };
    const prefix = normalizedPath && normalizedPath !== '/' && normalizedPath !== '.'
      ? `${normalizedPath}/`
      : '';
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of raw.entries) {
      if (entry.type === 'file') files.push(`${prefix}${entry.name}`);
      else if (entry.type === 'dir') folders.push(`${prefix}${entry.name}`);
    }
    return { files, folders };
  }

  async read(normalizedPath: string): Promise<string> {
    const response = await this.readRequest('/fs/read', normalizedPath);
    return response.text();
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const response = await this.readRequest('/fs/read', normalizedPath);
    return response.arrayBuffer();
  }

  async write(
    normalizedPath: string,
    data: string,
    _options?: DataWriteOptions,
  ): Promise<void> {
    await this.writeRequest('/fs/write', normalizedPath, data);
  }

  async writeBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    _options?: DataWriteOptions,
  ): Promise<void> {
    await this.writeRequest('/fs/write', normalizedPath, data);
  }

  async append(
    normalizedPath: string,
    data: string,
    _options?: DataWriteOptions,
  ): Promise<void> {
    await this.writeRequest('/fs/append', normalizedPath, data);
  }

  async appendBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    _options?: DataWriteOptions,
  ): Promise<void> {
    await this.writeRequest('/fs/append', normalizedPath, data);
  }

  async process(
    normalizedPath: string,
    fn: (data: string) => string,
    options?: DataWriteOptions,
  ): Promise<string> {
    const current = await this.read(normalizedPath);
    const next = fn(current);
    if (next !== current) {
      await this.write(normalizedPath, next, options);
    }
    return next;
  }

  getResourcePath(normalizedPath: string): string {
    throw new Error(`BridgeDataAdapter: getResourcePath is not supported ('${normalizedPath}')`);
  }

  async mkdir(normalizedPath: string): Promise<void> {
    await this.writeRequest('/fs/mkdir', normalizedPath);
  }

  async trashSystem(normalizedPath: string): Promise<boolean> {
    await this.remove(normalizedPath);
    return true;
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    await this.remove(normalizedPath);
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    await this.writeRequest('/fs/rmdir', normalizedPath, undefined, {
      recursive: recursive ? '1' : '0',
    });
  }

  async remove(normalizedPath: string): Promise<void> {
    await this.writeRequest('/fs/remove', normalizedPath);
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    await this.writeRequest('/fs/rename', normalizedPath, undefined, {
      to: await this.hostPath(normalizedNewPath),
    });
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const data = await this.readBinary(normalizedPath);
    await this.writeBinary(normalizedNewPath, data);
  }
}

function withCode(error: Error, code: string): Error {
  (error as Error & { code: string }).code = code;
  return error;
}
