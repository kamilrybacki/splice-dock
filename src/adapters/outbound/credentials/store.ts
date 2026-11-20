import { discoverVaultAddr, discoverVaultToken } from '../../../application/auth/resolver.js';
import { logger } from '../../../common/logger.js';
import type { CredentialStore, StoredCredential } from '../../../ports/credentials.js';

const VAULT_TIMEOUT_MS = 3_000;
const MAX_LIST_DEPTH = 4;

export { MemoryCredentialStore } from '../../../application/credentials/memory-store.js';

/**
 * Vault KV v2 store. `prefix` is a KV v2 *data* path
 * (e.g. `secret/data/splicedock/minted`); list and delete swap `data`
 * for `metadata`, which is where KV v2 keeps keys and versions.
 *
 * Never logs values or Vault tokens. Every failure surfaces as an exception so
 * the broker can decide whether to degrade to memory or fail closed.
 */
export class VaultCredentialStore implements CredentialStore {
  constructor(private readonly prefix: string) {}

  async get(path: string): Promise<StoredCredential | undefined> {
    const body = await this.request('GET', path);
    if (body === undefined) return undefined;
    const data = (body as { data?: { data?: Record<string, unknown> } }).data?.data;
    if (!data || typeof data['value'] !== 'string' || data['value'] === '') return undefined;
    return {
      value: data['value'],
      expiresAt: typeof data['expires_at'] === 'number' ? data['expires_at'] : undefined,
      ttlMs: typeof data['ttl_ms'] === 'number' ? data['ttl_ms'] : undefined,
      provider: typeof data['provider'] === 'string' ? data['provider'] : '',
      metadata: parseMetadata(data['metadata']),
    };
  }

  async put(path: string, value: StoredCredential): Promise<void> {
    await this.request('POST', path, {
      data: {
        value: value.value,
        ...(value.expiresAt !== undefined && { expires_at: value.expiresAt }),
        ...(value.ttlMs !== undefined && { ttl_ms: value.ttlMs }),
        provider: value.provider,
        ...(value.metadata !== undefined && { metadata: JSON.stringify(value.metadata) }),
      },
    });
  }

  async delete(path: string): Promise<void> {
    await this.request('DELETE', this.metadataPath(path));
  }

  async deletePrefix(prefix: string): Promise<number> {
    return this.deleteTree(this.metadataPath(prefix), 0);
  }

  private async deleteTree(folder: string, depth: number): Promise<number> {
    if (depth > MAX_LIST_DEPTH) return 0;
    const keys = await this.list(folder);
    let removed = 0;
    for (const key of keys) {
      const child = `${folder}/${key}`;
      if (key.endsWith('/')) {
        removed += await this.deleteTree(child.slice(0, -1), depth + 1);
      } else {
        await this.request('DELETE', child);
        removed += 1;
      }
    }
    return removed;
  }

  private async list(folder: string): Promise<string[]> {
    const body = await this.request('LIST', folder);
    const keys = (body as { data?: { keys?: unknown } } | undefined)?.data?.keys;
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
  }

  private metadataPath(path: string): string {
    // First `/data/` belongs to the KV v2 URL layout of the mount, not the path.
    return path.replace('/data/', '/metadata/');
  }

  private async request(method: 'GET' | 'POST' | 'LIST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const addr = discoverVaultAddr();
    if (!addr) throw new Error('vault_unavailable');
    const token = await discoverVaultToken(addr);
    if (!token) throw new Error('vault_unavailable');
    const response = await fetch(`${addr}/v1/${path}`, {
      method,
      headers: { 'X-Vault-Token': token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      logger.warn('credential store request failed', { status: response.status });
      throw new Error(`vault_http_${response.status}`);
    }
    if (method === 'DELETE') return undefined;
    return response.json();
  }
}

function parseMetadata(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
