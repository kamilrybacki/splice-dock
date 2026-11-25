import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../../src/common/logger.js';
import { createCredentialBroker } from '../../../src/services/secrets/broker.js';
import {
  REVOKE_RETRY_BASE_MS,
  REVOKE_RETRY_MAX_ATTEMPTS,
  REVOKE_RETRY_MAX_MS,
} from '../../../src/services/secrets/revoke-retry.js';
import { MemoryCredentialStore } from '../../../src/services/secrets/memory/store.js';
import type {
  CredentialAdapters,
  CredentialBroker,
  CredentialStore,
  MintContext,
  MintedCredential,
  StoredCredential,
} from '../../../src/services/secrets/base.js';

const PROVIDER_CONFIG = {
  type: 'command',
  command: 'unused',
  args: [],
  timeout_ms: 1000,
  ttl_seconds: 3600,
  output: { format: 'text', secret_field: 'token' },
} as const;

const targetFor = (profile: string, backend = 'vault') => ({
  profile, agent: null, backend, authenticated: true, tokenId: 'tid-1',
});

/** The shared store with every call observable, standing in for Postgres/Vault. */
function spyStore(inner: CredentialStore = new MemoryCredentialStore()) {
  return {
    get: vi.fn((path: string): Promise<StoredCredential | undefined> => inner.get(path)),
    put: vi.fn((path: string, value: StoredCredential) => inner.put(path, value)),
    delete: vi.fn((path: string) => inner.delete(path)),
    deletePrefix: vi.fn((prefix: string) => inner.deletePrefix(prefix)),
    listPrefix: vi.fn((prefix: string) => inner.listPrefix(prefix)),
  };
}

interface Replica {
  broker: CredentialBroker;
  mint: ReturnType<typeof vi.fn<(ctx: MintContext) => Promise<MintedCredential>>>;
  revoke: ReturnType<typeof vi.fn<(ctx: MintContext, minted: StoredCredential) => Promise<void>>>;
}

/** One replica: its own broker (own L1, minted and backoff state) over a given shared store. */
function replica(store: CredentialStore, name: string, failingBackend = 'flaky'): Replica {
  let n = 0;
  const mint = vi.fn(async (ctx: MintContext): Promise<MintedCredential> => {
    if (ctx.backend === failingBackend) throw new Error('upstream down');
    n += 1;
    return { secret: `${name}-tok-${n}` };
  });
  const revoke = vi.fn(async () => undefined);
  const adapters: CredentialAdapters = {
    provider: () => ({ mint, revoke }),
    store: () => store,
  };
  const broker = createCredentialBroker(
    { providers: { test: PROVIDER_CONFIG }, storage: { type: 'memory', prefix: '' } },
    adapters,
  );
  return { broker, mint, revoke };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CredentialBroker.forgetProfile (this replica only)', () => {
  it('drops the L1 entry: the next resolve goes back to the shared store', async () => {
    const store = spyStore();
    const { broker, mint } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker'));
    store.get.mockClear();
    await broker.resolve('test', targetFor('worker'));
    expect(store.get).not.toHaveBeenCalled(); // served from L1

    await broker.forgetProfile('worker');

    await broker.resolve('test', targetFor('worker'));
    expect(store.get).toHaveBeenCalledTimes(1); // L1 is gone
    expect(mint).toHaveBeenCalledTimes(1); // the shared copy was untouched, so no re-mint
  });

  it('drops an L1 entry that was only read from the shared store (no mint record)', async () => {
    const store = spyStore();
    const origin = replica(store, 'origin');
    const receiver = replica(store, 'receiver');
    const first = await origin.broker.resolve('test', targetFor('worker'));
    expect(await receiver.broker.resolve('test', targetFor('worker'))).toBe(first);
    expect(receiver.mint).not.toHaveBeenCalled();

    // The deleting replica purged the shared store; the receiver still has the value in L1.
    await origin.broker.revokeProfile('worker');
    expect(await receiver.broker.resolve('test', targetFor('worker'))).toBe(first); // stale, until it learns

    await receiver.broker.forgetProfile('worker');

    const next = await receiver.broker.resolve('test', targetFor('worker'));
    expect(next).not.toBe(first);
    expect(receiver.mint).toHaveBeenCalledTimes(1);
  });

  it('clears mint backoff for the profile', async () => {
    const { broker, mint } = replica(spyStore(), 'r1');
    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_unavailable');
    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_mint_backoff');
    expect(mint).toHaveBeenCalledTimes(1);

    await broker.forgetProfile('worker');

    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_unavailable');
    expect(mint).toHaveBeenCalledTimes(2); // attempted again instead of failing fast
  });

  it('drops mint records, so a later revokeProfile does not revoke the same credential twice', async () => {
    const { broker, revoke } = replica(spyStore(), 'r1');
    await broker.resolve('test', targetFor('worker'));

    await broker.forgetProfile('worker');
    await broker.revokeProfile('worker');

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('leaves store-resident credentials to the replica serving the delete, and never touches the shared store', async () => {
    const store = spyStore();
    const origin = replica(store, 'origin');
    const receiver = replica(store, 'receiver');
    const fromOrigin = await origin.broker.resolve('test', targetFor('worker', 'vault'));
    // The receiver reads the origin's credential from the store (no mint of its own)
    // and mints a second one for another backend; both are in the shared store, so the
    // serving replica revokes them from its listing and the receiver must not revoke them too.
    expect(await receiver.broker.resolve('test', targetFor('worker', 'vault'))).toBe(fromOrigin);
    await receiver.broker.resolve('test', targetFor('worker', 'git'));
    await expect(receiver.broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow();
    await receiver.broker.resolve('test', targetFor('worker-2', 'vault'));
    store.get.mockClear();
    store.put.mockClear();

    await receiver.broker.forgetProfile('worker');

    expect(receiver.revoke).not.toHaveBeenCalled();
    expect(origin.revoke).not.toHaveBeenCalled();
    expect(store.deletePrefix).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(store.listPrefix).not.toHaveBeenCalled();
  });

  it('revokes a credential only this replica holds: its store write failed', async () => {
    const store = spyStore();
    store.put.mockRejectedValueOnce(new Error('store down'));
    const { broker, revoke } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker', 'git'));
    await broker.resolve('test', targetFor('worker', 'vault')); // stored normally

    await broker.forgetProfile('worker');

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]?.[0]).toMatchObject({ profile: 'worker', backend: 'git' });
    expect(revoke.mock.calls[0]?.[1]).toMatchObject({ value: 'r1-tok-1' });
  });

  it('revokes every credential it minted when the store is process-local', async () => {
    const { broker, revoke } = replica(new MemoryCredentialStore(), 'r1');
    await broker.resolve('test', targetFor('worker', 'vault'));
    await broker.resolve('test', targetFor('worker', 'git'));
    await broker.resolve('test', targetFor('worker-2', 'git'));

    await broker.forgetProfile('worker');

    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke.mock.calls.map(c => c[0].backend).sort()).toEqual(['git', 'vault']);
  });

  it('still clears local state and resolves when the provider revoke fails', async () => {
    const store = spyStore();
    store.put.mockRejectedValueOnce(new Error('store down')); // memory-only, so this replica revokes it
    const { broker, mint, revoke } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker'));
    revoke.mockRejectedValueOnce(new Error('provider down'));

    await expect(broker.forgetProfile('worker')).resolves.toBeUndefined();

    store.get.mockResolvedValue(undefined);
    await broker.resolve('test', targetFor('worker'));
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('leaves other profiles untouched, including a profile whose name extends the deleted one', async () => {
    const store = spyStore();
    const { broker, mint } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker'));
    await broker.resolve('test', targetFor('worker-2'));
    await expect(broker.resolve('test', targetFor('other', 'flaky'))).rejects.toThrow('credential_unavailable');
    store.get.mockClear();

    await broker.forgetProfile('worker');

    await broker.resolve('test', targetFor('worker-2'));
    expect(store.get).not.toHaveBeenCalled(); // still in L1
    await expect(broker.resolve('test', targetFor('other', 'flaky'))).rejects.toThrow('credential_mint_backoff');
    expect(mint).toHaveBeenCalledTimes(3); // two good mints and one failed; nothing re-minted
  });

  it('is a no-op for a profile it has never seen', async () => {
    const { broker, revoke } = replica(spyStore(), 'r1');
    await expect(broker.forgetProfile('ghost')).resolves.toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();
  });
});

/** A promise settled by hand, to hold a mint or a store write open across a delete. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe.each([
  ['forgetProfile', (b: CredentialBroker) => b.forgetProfile('worker')],
  ['revokeProfile', (b: CredentialBroker) => b.revokeProfile('worker')],
])('a mint in flight while %s runs', (_name, cleanup) => {
  function slowMintReplica(store: CredentialStore) {
    const gate = deferred<MintedCredential>();
    const revoke = vi.fn(async () => undefined);
    const mint = vi.fn(async (): Promise<MintedCredential> => gate.promise);
    const broker = createCredentialBroker(
      { providers: { test: PROVIDER_CONFIG }, storage: { type: 'memory', prefix: '' } },
      { provider: () => ({ mint, revoke }), store: () => store },
    );
    return { broker, gate, mint, revoke };
  }

  const settle = (p: Promise<string>) => p.then(() => 'resolved', (e: Error) => e.message);

  it('is not cached, not stored and is revoked; the caller gets credential_unavailable', async () => {
    const store = spyStore();
    const { broker, gate, mint, revoke } = slowMintReplica(store);
    const outcome = settle(broker.resolve('test', targetFor('worker')));
    await vi.advanceTimersByTimeAsync(0);
    expect(mint).toHaveBeenCalledTimes(1);

    await cleanup(broker);
    gate.resolve({ secret: 'late-secret' });

    expect(await outcome).toBe('credential_unavailable');
    expect(store.put).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]?.[1]).toMatchObject({ value: 'late-secret' });

    // Nothing was left in L1 or in the mint records: the next call mints again, and a
    // later cleanup by the serving replica (which lists the shared store) revokes only that one.
    mint.mockImplementation(async () => ({ secret: 'fresh' }));
    expect(await broker.resolve('test', targetFor('worker'))).toBe('fresh');
    revoke.mockClear();
    await broker.revokeProfile('worker');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]?.[1]).toMatchObject({ value: 'fresh' });
  });

  it('removes the shared-store entry when the write was already in flight', async () => {
    const inner = new MemoryCredentialStore();
    const store = spyStore(inner);
    const putGate = deferred<void>();
    store.put.mockImplementation(async (path, value) => {
      await putGate.promise;
      await inner.put(path, value);
    });
    const { broker, gate, revoke } = slowMintReplica(store);
    const outcome = settle(broker.resolve('test', targetFor('worker')));
    gate.resolve({ secret: 'late-secret' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.put).toHaveBeenCalledTimes(1); // minted, write pending

    await cleanup(broker);
    putGate.resolve();

    expect(await outcome).toBe('credential_unavailable');
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(await inner.get(store.delete.mock.calls[0]![0])).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('does not disturb a mint for another profile', async () => {
    const { broker, gate } = slowMintReplica(spyStore());
    const other = broker.resolve('test', targetFor('worker-2'));
    await vi.advanceTimersByTimeAsync(0);

    await cleanup(broker);
    gate.resolve({ secret: 'other-secret' });

    await expect(other).resolves.toBe('other-secret');
  });

  it('does not back off the profile when a stale mint fails', async () => {
    const { broker, mint, gate } = slowMintReplica(spyStore());
    const outcome = settle(broker.resolve('test', targetFor('worker')));
    await vi.advanceTimersByTimeAsync(0);

    await cleanup(broker);
    gate.reject(new Error('boom'));
    expect(await outcome).toBe('credential_unavailable');

    mint.mockImplementation(async () => ({ secret: 'fresh' }));
    expect(await broker.resolve('test', targetFor('worker'))).toBe('fresh'); // no credential_mint_backoff
  });
});

describe('CredentialBroker.revokeProfile (originating replica, unchanged)', () => {
  it('revokes at the provider once per credential, purges the shared store once, and clears local state', async () => {
    const store = spyStore();
    const { broker, mint, revoke } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker', 'vault'));
    await broker.resolve('test', targetFor('worker', 'git'));
    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_unavailable');

    await broker.revokeProfile('worker');

    expect(revoke).toHaveBeenCalledTimes(2);
    expect(store.deletePrefix).toHaveBeenCalledTimes(1);
    expect(store.deletePrefix).toHaveBeenCalledWith('worker');

    // L1, mint records and backoff are all gone: the next resolve mints afresh.
    const before = mint.mock.calls.length;
    await broker.resolve('test', targetFor('worker', 'vault'));
    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_unavailable');
    expect(mint.mock.calls.length).toBe(before + 2);
  });

  it('still purges local state when the shared purge fails', async () => {
    const store = spyStore();
    store.deletePrefix.mockRejectedValueOnce(new Error('store down'));
    const { broker, mint } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker'));

    await expect(broker.revokeProfile('worker')).resolves.toBeUndefined();

    store.get.mockResolvedValue(undefined);
    await broker.resolve('test', targetFor('worker'));
    expect(mint).toHaveBeenCalledTimes(2);
  });
});

describe('CredentialBroker.revokeProfile revokes what the shared store holds', () => {
  const warnings = () => vi.spyOn(logger, 'warn').mockImplementation(() => {});

  it('revokes a credential minted by a replica that has since restarted', async () => {
    const store = spyStore();
    const before = replica(store, 'before');
    const issued = await before.broker.resolve('test', targetFor('worker', 'vault'));
    // `before` is gone: a fresh broker over the same store has no mint record for it.
    const serving = replica(store, 'serving');

    await serving.broker.revokeProfile('worker');

    expect(serving.revoke).toHaveBeenCalledTimes(1);
    expect(serving.revoke.mock.calls[0]?.[0]).toEqual({
      profile: 'worker', agent: null, backend: 'vault', authenticated: false, tokenId: null,
      provider: 'test', config: PROVIDER_CONFIG,
    });
    expect(serving.revoke.mock.calls[0]?.[1]).toMatchObject({ value: issued, provider: 'test' });
    expect(await store.get('worker/vault/~/test')).toBeUndefined();
  });

  it('rebuilds the agent from the stored path', async () => {
    const store = spyStore();
    await replica(store, 'before').broker.resolve('test', { ...targetFor('worker', 'gh'), agent: 'ci' });
    const serving = replica(store, 'serving');

    await serving.broker.revokeProfile('worker');

    expect(serving.revoke.mock.calls[0]?.[0]).toMatchObject({ profile: 'worker', backend: 'gh', agent: 'ci' });
  });

  it('lists before it purges, and purges before it revokes', async () => {
    const store = spyStore();
    await replica(store, 'before').broker.resolve('test', targetFor('worker'));
    const serving = replica(store, 'serving');

    await serving.broker.revokeProfile('worker');

    expect(store.listPrefix).toHaveBeenCalledWith('worker');
    const [listed] = store.listPrefix.mock.invocationCallOrder;
    const [purged] = store.deletePrefix.mock.invocationCallOrder;
    const [revoked] = serving.revoke.mock.invocationCallOrder;
    expect(listed).toBeLessThan(purged!);
    expect(purged).toBeLessThan(revoked!);
  });

  it('revokes each credential once when the serving replica minted it and the store also lists it', async () => {
    const store = spyStore();
    const serving = replica(store, 'serving');
    await serving.broker.resolve('test', targetFor('worker', 'vault'));
    await replica(store, 'sibling').broker.resolve('test', targetFor('worker', 'git'));

    await serving.broker.revokeProfile('worker');

    expect(serving.revoke).toHaveBeenCalledTimes(2);
    expect(serving.revoke.mock.calls.map(c => c[1].value).sort()).toEqual(['serving-tok-1', 'sibling-tok-1']);
  });

  it('revokes a credential that only this replica holds even though the store has none of it', async () => {
    const store = spyStore();
    store.put.mockRejectedValueOnce(new Error('store down'));
    const serving = replica(store, 'serving');
    await serving.broker.resolve('test', targetFor('worker', 'git')); // memory-only
    await replica(store, 'before').broker.resolve('test', targetFor('worker', 'vault'));

    await serving.broker.revokeProfile('worker');

    expect(serving.revoke.mock.calls.map(c => c[1].value).sort()).toEqual(['before-tok-1', 'serving-tok-1']);
  });

  it('falls back to its own credentials, warns and still purges when the listing fails', async () => {
    const warn = warnings();
    const store = spyStore();
    const serving = replica(store, 'serving');
    await serving.broker.resolve('test', targetFor('worker', 'vault'));
    store.listPrefix.mockRejectedValueOnce(new Error('store down'));

    await expect(serving.broker.revokeProfile('worker')).resolves.toBeUndefined();

    expect(serving.revoke).toHaveBeenCalledTimes(1);
    expect(store.deletePrefix).toHaveBeenCalledWith('worker');
    expect(warn).toHaveBeenCalledWith('credential store listing failed', expect.objectContaining({ profile: 'worker' }));
  });

  it('skips, with a warning, an entry whose provider is not configured or whose path is malformed', async () => {
    const warn = warnings();
    const store = spyStore();
    const entry = (provider: string): StoredCredential => ({ value: 'v', provider, expiresAt: Date.now() + 60_000, ttlMs: 60_000 });
    await store.put('worker/vault/~/gone', entry('gone'));
    await store.put('worker/too/few', entry('test'));
    await store.put('worker/vault/~/test', entry('test'));
    const serving = replica(store, 'serving');

    await expect(serving.broker.revokeProfile('worker')).resolves.toBeUndefined();

    expect(serving.revoke).toHaveBeenCalledTimes(1);
    expect(serving.revoke.mock.calls[0]?.[0]).toMatchObject({ backend: 'vault', provider: 'test' });
    expect(warn).toHaveBeenCalledWith('skipped unrevocable credential store entry', expect.objectContaining({ profile: 'worker' }));
    expect(await store.get('worker/too/few')).toBeUndefined(); // still purged
  });

  it('never logs the credential value of a skipped entry', async () => {
    const warn = warnings();
    const store = spyStore();
    await store.put('worker/vault/~/gone', { value: 'super-secret', provider: 'gone', expiresAt: Date.now() + 60_000 });

    await replica(store, 'serving').broker.revokeProfile('worker');

    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret');
  });

  it('leaves another profile whose name extends the deleted one alone', async () => {
    const store = spyStore();
    await replica(store, 'before').broker.resolve('test', targetFor('worker-2'));
    const serving = replica(store, 'serving');

    await serving.broker.revokeProfile('worker');

    expect(serving.revoke).not.toHaveBeenCalled();
    expect(await store.get('worker-2/vault/~/test')).toBeDefined();
  });
});

describe('provider revoke retries', () => {
  /** A replica whose credential lives only in this process, so forgetProfile must revoke it. */
  async function localReplica() {
    const r = replica(new MemoryCredentialStore(), 'r1');
    await r.broker.resolve('test', targetFor('worker'));
    return r;
  }

  it('retries a failed revoke with exponential backoff until it succeeds', async () => {
    const r = await localReplica();
    r.revoke.mockRejectedValueOnce(new Error('provider down')).mockRejectedValueOnce(new Error('provider down'));

    await r.broker.forgetProfile('worker');
    expect(r.revoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REVOKE_RETRY_BASE_MS - 1);
    expect(r.revoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.revoke).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2 * REVOKE_RETRY_BASE_MS - 1);
    expect(r.revoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.revoke).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(REVOKE_RETRY_MAX_MS * 10);
    expect(r.revoke).toHaveBeenCalledTimes(3); // succeeded: no further attempts
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries with the same context and credential', async () => {
    const r = await localReplica();
    r.revoke.mockRejectedValueOnce(new Error('provider down'));

    await r.broker.forgetProfile('worker');
    await vi.advanceTimersByTimeAsync(REVOKE_RETRY_BASE_MS);

    expect(r.revoke.mock.calls[1]).toEqual(r.revoke.mock.calls[0]);
  });

  it('caps the delay at the configured maximum', async () => {
    const r = await localReplica();
    r.revoke.mockRejectedValue(new Error('provider down'));

    await r.broker.forgetProfile('worker');
    let previous = r.revoke.mock.calls.length;
    for (let attempt = 1; attempt <= REVOKE_RETRY_MAX_ATTEMPTS; attempt += 1) {
      const delay = Math.min(REVOKE_RETRY_MAX_MS, REVOKE_RETRY_BASE_MS * 2 ** (attempt - 1));
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(r.revoke).toHaveBeenCalledTimes(previous);
      await vi.advanceTimersByTimeAsync(1);
      expect(r.revoke).toHaveBeenCalledTimes(previous + 1);
      previous += 1;
    }
  });

  it('gives up after the retry budget with a warning that carries no secret', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = await localReplica();
    r.revoke.mockRejectedValue(new Error('provider down'));

    await r.broker.forgetProfile('worker');
    await vi.advanceTimersByTimeAsync(REVOKE_RETRY_MAX_MS * (REVOKE_RETRY_MAX_ATTEMPTS + 2));

    expect(r.revoke).toHaveBeenCalledTimes(1 + REVOKE_RETRY_MAX_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      'credential provider revoke abandoned',
      expect.objectContaining({ provider: 'test', profile: 'worker', attempts: 1 + REVOKE_RETRY_MAX_ATTEMPTS }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('r1-tok-1');
  });

  it('never delays forgetProfile or revokeProfile', async () => {
    const forgetting = await localReplica();
    forgetting.revoke.mockRejectedValue(new Error('provider down'));
    await expect(forgetting.broker.forgetProfile('worker')).resolves.toBeUndefined();

    const revoking = await localReplica();
    revoking.revoke.mockRejectedValue(new Error('provider down'));
    await expect(revoking.broker.revokeProfile('worker')).resolves.toBeUndefined();
    // Resolved with the fake clock never advanced: the retry is still pending in the background.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('retries a revoke that failed when the serving replica purged the shared store', async () => {
    const store = spyStore();
    await replica(store, 'before').broker.resolve('test', targetFor('worker'));
    const serving = replica(store, 'serving');
    serving.revoke.mockRejectedValueOnce(new Error('provider down'));

    await serving.broker.revokeProfile('worker');
    await vi.advanceTimersByTimeAsync(REVOKE_RETRY_BASE_MS);

    expect(serving.revoke).toHaveBeenCalledTimes(2);
    expect(serving.revoke.mock.calls[1]?.[1]).toMatchObject({ value: 'before-tok-1' });
  });

  it('uses timers that do not keep the process alive', async () => {
    const r = await localReplica();
    r.revoke.mockRejectedValue(new Error('provider down'));
    const created: Array<{ hasRef(): boolean }> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const handle = realSetTimeout(...args);
      created.push(handle as unknown as { hasRef(): boolean });
      return handle;
    }) as typeof setTimeout);

    await r.broker.forgetProfile('worker');

    expect(created).toHaveLength(1);
    expect(created[0]?.hasRef()).toBe(false);
  });

  it('close() cancels pending retries and schedules none afterwards', async () => {
    const r = await localReplica();
    r.revoke.mockRejectedValue(new Error('provider down'));
    await r.broker.forgetProfile('worker');
    expect(vi.getTimerCount()).toBe(1);

    r.broker.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REVOKE_RETRY_MAX_MS * 10);
    expect(r.revoke).toHaveBeenCalledTimes(1);

    const after = await localReplica();
    after.broker.close();
    after.revoke.mockRejectedValue(new Error('provider down'));
    await after.broker.forgetProfile('worker');
    expect(vi.getTimerCount()).toBe(0);
  });
});
