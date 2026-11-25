import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCredentialBroker } from '../../../src/services/secrets/broker.js';
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

  it('revokes only the credentials this replica minted, and never touches the shared store', async () => {
    const store = spyStore();
    const origin = replica(store, 'origin');
    const receiver = replica(store, 'receiver');
    const fromOrigin = await origin.broker.resolve('test', targetFor('worker', 'vault'));
    // The receiver reads the origin's credential from the store (no mint of its own)
    // and mints a second one for another backend.
    expect(await receiver.broker.resolve('test', targetFor('worker', 'vault'))).toBe(fromOrigin);
    await receiver.broker.resolve('test', targetFor('worker', 'git'));
    await expect(receiver.broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow();
    await receiver.broker.resolve('test', targetFor('worker-2', 'vault'));
    store.get.mockClear();
    store.put.mockClear();

    await receiver.broker.forgetProfile('worker');

    expect(receiver.revoke).toHaveBeenCalledTimes(1);
    expect(receiver.revoke.mock.calls[0]?.[0]).toMatchObject({ profile: 'worker', backend: 'git' });
    expect(receiver.revoke.mock.calls[0]?.[1]).toMatchObject({ value: 'receiver-tok-1' });
    expect(origin.revoke).not.toHaveBeenCalled();
    expect(store.deletePrefix).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('still clears local state and resolves when the provider revoke fails', async () => {
    const store = spyStore();
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
    // later cleanup revokes only that one.
    mint.mockImplementation(async () => ({ secret: 'fresh' }));
    expect(await broker.resolve('test', targetFor('worker'))).toBe('fresh');
    revoke.mockClear();
    await broker.forgetProfile('worker');
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
