import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialAdapters } from '../../../src/services/secrets/adapters/index.js';
import { VaultCredentialStore } from '../../../src/services/secrets/adapters/vault/store.js';
import { MemoryCredentialStore } from '../../../src/services/secrets/memory/store.js';
import { createCredentialBroker } from '../../../src/services/secrets/broker.js';
import type { CredentialAdapters, CredentialStore, StoredCredential } from '../../../src/services/secrets/base.js';

const PREFIX = 'secret/data/splicedock/minted';
const entry = (value: string): StoredCredential => ({ value, provider: 'p', expiresAt: Date.now() + 60_000 });

/** In-memory stand-in for the Vault KV v2 HTTP API: data and metadata views of one key space. */
function fakeVault(): { calls: string[]; restore: () => void } {
  const kv = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/v1\//, '');
    calls.push(`${method} ${path}`);
    const dataKey = path.replace('/metadata/', '/data/');
    if (method === 'POST') {
      kv.set(dataKey, (JSON.parse(String(init?.body)) as { data: Record<string, unknown> }).data);
      return new Response('{}', { status: 200 });
    }
    if (method === 'GET') {
      const data = kv.get(dataKey);
      return data ? Response.json({ data: { data } }) : new Response(null, { status: 404 });
    }
    if (method === 'DELETE') {
      kv.delete(dataKey);
      return new Response(null, { status: 204 });
    }
    // LIST: direct children of the folder, folders with a trailing slash.
    const folder = `${dataKey}/`;
    const keys = new Set<string>();
    for (const key of kv.keys()) {
      if (!key.startsWith(folder)) continue;
      const rest = key.slice(folder.length);
      keys.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
    }
    return keys.size > 0 ? Response.json({ data: { keys: [...keys] } }) : new Response(null, { status: 404 });
  });
  return { calls, restore: () => spy.mockRestore() };
}

const stores: Array<[string, () => CredentialStore]> = [
  ['memory', () => new MemoryCredentialStore()],
  ['vault', () => new VaultCredentialStore(PREFIX)],
];

describe.each(stores)('CredentialStore contract: %s', (_name, make) => {
  let vault: ReturnType<typeof fakeVault>;
  beforeEach(() => {
    process.env['VAULT_ADDR'] = 'http://vault.test:8200';
    process.env['VAULT_TOKEN'] = 'test-token';
    vault = fakeVault();
  });
  afterEach(() => {
    vault.restore();
    delete process.env['VAULT_ADDR'];
    delete process.env['VAULT_TOKEN'];
  });

  it('round-trips an entry and reports a missing one as undefined', async () => {
    const store = make();
    expect(await store.get('worker/gh/_/p')).toBeUndefined();
    await store.put('worker/gh/_/p', entry('tok'));
    expect((await store.get('worker/gh/_/p'))?.value).toBe('tok');
  });

  it('deletes one entry', async () => {
    const store = make();
    await store.put('worker/gh/_/p', entry('tok'));
    await store.delete('worker/gh/_/p');
    expect(await store.get('worker/gh/_/p')).toBeUndefined();
  });

  it('deletes a whole prefix without touching a sibling whose name shares the prefix', async () => {
    const store = make();
    await store.put('worker/gh/_/p', entry('a'));
    await store.put('worker/codex/agent/p', entry('b'));
    await store.put('worker2/gh/_/p', entry('c'));
    expect(await store.deletePrefix('worker')).toBe(2);
    expect(await store.get('worker/gh/_/p')).toBeUndefined();
    expect((await store.get('worker2/gh/_/p'))?.value).toBe('c');
  });
});

describe('VaultCredentialStore paths', () => {
  afterEach(() => {
    delete process.env['VAULT_ADDR'];
    delete process.env['VAULT_TOKEN'];
  });

  it('resolves relative keys under its KV v2 prefix, metadata path for deletes', async () => {
    process.env['VAULT_ADDR'] = 'http://vault.test:8200';
    process.env['VAULT_TOKEN'] = 'test-token';
    const vault = fakeVault();
    try {
      const store = new VaultCredentialStore(PREFIX);
      await store.put('worker/gh/_/p', entry('tok'));
      await store.get('worker/gh/_/p');
      await store.delete('worker/gh/_/p');
      expect(vault.calls).toEqual([
        `POST ${PREFIX}/worker/gh/_/p`,
        `GET ${PREFIX}/worker/gh/_/p`,
        'DELETE secret/metadata/splicedock/minted/worker/gh/_/p',
      ]);
    } finally {
      vault.restore();
    }
  });

  it('fails closed when Vault is not configured', async () => {
    await expect(new VaultCredentialStore(PREFIX).get('k')).rejects.toThrow('vault_unavailable');
  });
});

describe('credential adapters', () => {
  it('select the store from credential_storage', () => {
    expect(credentialAdapters.store({ type: 'vault', prefix: PREFIX })).toBeInstanceOf(VaultCredentialStore);
    expect(credentialAdapters.store({ type: 'memory', prefix: PREFIX })).toBeInstanceOf(MemoryCredentialStore);
  });
});

describe('broker with an injected store', () => {
  it('persists under relative keys and purges by profile without knowing the backend', async () => {
    const store = new MemoryCredentialStore();
    const put = vi.spyOn(store, 'put');
    const purge = vi.spyOn(store, 'deletePrefix');
    let mints = 0;
    const adapters: CredentialAdapters = {
      provider: () => ({ mint: async () => ({ secret: `tok-${++mints}` }) }),
      store: () => store,
    };
    const broker = createCredentialBroker({
      providers: { test: { type: 'command', command: 'true', args: [], timeout_ms: 1000, ttl_seconds: 60, output: { format: 'text', secret_field: 'token' } } },
      storage: { type: 'vault', prefix: PREFIX },
    }, adapters);

    expect(await broker.resolve('test', { profile: 'worker', agent: null, backend: 'gh', authenticated: true, tokenId: 'tid' })).toBe('tok-1');
    expect(put).toHaveBeenCalledWith('worker/gh/~/test', expect.objectContaining({ value: 'tok-1' }));

    await broker.revokeProfile('worker');
    expect(purge).toHaveBeenCalledWith('worker');
    expect(await store.get('worker/gh/~/test')).toBeUndefined();
  });
});
