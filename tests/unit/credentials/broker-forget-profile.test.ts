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

describe('CredentialBroker.forgetProfile (local-only purge)', () => {
  it('drops the L1 entry: the next resolve goes back to the shared store', async () => {
    const store = spyStore();
    const { broker, mint } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker'));
    store.get.mockClear();
    await broker.resolve('test', targetFor('worker'));
    expect(store.get).not.toHaveBeenCalled(); // served from L1

    broker.forgetProfile('worker');

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

    receiver.broker.forgetProfile('worker');

    const next = await receiver.broker.resolve('test', targetFor('worker'));
    expect(next).not.toBe(first);
    expect(receiver.mint).toHaveBeenCalledTimes(1);
  });

  it('clears mint backoff for the profile', async () => {
    const { broker, mint } = replica(spyStore(), 'r1');
    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_unavailable');
    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_mint_backoff');
    expect(mint).toHaveBeenCalledTimes(1);

    broker.forgetProfile('worker');

    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow('credential_unavailable');
    expect(mint).toHaveBeenCalledTimes(2); // attempted again instead of failing fast
  });

  it('drops mint records, so a later revokeProfile has nothing to send to the provider', async () => {
    const { broker, revoke } = replica(spyStore(), 'r1');
    await broker.resolve('test', targetFor('worker'));

    broker.forgetProfile('worker');
    await broker.revokeProfile('worker');

    expect(revoke).not.toHaveBeenCalled();
  });

  it('never calls the provider revoke or purges the shared store', async () => {
    const store = spyStore();
    const { broker, revoke } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker'));
    await expect(broker.resolve('test', targetFor('worker', 'flaky'))).rejects.toThrow();

    broker.forgetProfile('worker');

    expect(revoke).not.toHaveBeenCalled();
    expect(store.deletePrefix).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('leaves other profiles untouched, including a profile whose name extends the deleted one', async () => {
    const store = spyStore();
    const { broker, mint } = replica(store, 'r1');
    await broker.resolve('test', targetFor('worker'));
    await broker.resolve('test', targetFor('worker-2'));
    await expect(broker.resolve('test', targetFor('other', 'flaky'))).rejects.toThrow('credential_unavailable');
    store.get.mockClear();

    broker.forgetProfile('worker');

    await broker.resolve('test', targetFor('worker-2'));
    expect(store.get).not.toHaveBeenCalled(); // still in L1
    await expect(broker.resolve('test', targetFor('other', 'flaky'))).rejects.toThrow('credential_mint_backoff');
    expect(mint).toHaveBeenCalledTimes(3); // two good mints and one failed; nothing re-minted
  });

  it('is a no-op for a profile it has never seen', () => {
    const { broker } = replica(spyStore(), 'r1');
    expect(() => broker.forgetProfile('ghost')).not.toThrow();
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
