import { describe, it, expect, vi } from 'vitest';
import { createCredentialBroker } from '../../../src/services/secrets/broker.js';
import { MemoryCredentialStore } from '../../../src/services/secrets/memory/store.js';
import type { CredentialAdapters, CredentialBroker, MintContext, MintedCredential } from '../../../src/services/secrets/base.js';

const target = { profile: 'worker', agent: null, backend: 'vault', authenticated: true, tokenId: 'tid-1' };

const provider = {
  type: 'command' as const, command: 'unused', args: [], timeout_ms: 1000, ttl_seconds: 3600,
  output: { format: 'text' as const, secret_field: 'token' },
};

/** A broker over its own private store, minting through the shared `mint` spy. */
function brokerWith(mint: (ctx: MintContext) => Promise<MintedCredential>, revoke = vi.fn(async () => undefined)): CredentialBroker {
  const adapters: CredentialAdapters = {
    provider: () => ({ mint, revoke }),
    store: () => new MemoryCredentialStore(),
  };
  return createCredentialBroker({ providers: { test: provider }, storage: { type: 'memory', prefix: '' } }, adapters);
}

describe('credential broker instances', () => {
  it('keep separate caches: a value cached by one is minted again by the other', async () => {
    const mint = vi.fn(async () => ({ secret: `tok-${mint.mock.calls.length}` }));
    const a = brokerWith(mint);
    const b = brokerWith(mint);

    expect(await a.resolve('test', target)).toBe('tok-1');
    expect(await a.resolve('test', target)).toBe('tok-1');
    expect(mint).toHaveBeenCalledTimes(1);

    expect(await b.resolve('test', target)).toBe('tok-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('do not share single-flight: concurrent resolves on two brokers mint once each', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mint = vi.fn(async () => {
      const n = mint.mock.calls.length;
      await gate;
      return { secret: `tok-${n}` };
    });
    const a = brokerWith(mint);
    const b = brokerWith(mint);

    const pending = [a.resolve('test', target), a.resolve('test', target), b.resolve('test', target)];
    release();
    const [first, second, other] = await Promise.all(pending);

    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('do not share a failure backoff: one broker backing off does not block another', async () => {
    const failing = vi.fn(async (): Promise<MintedCredential> => { throw new Error('upstream down'); });
    const healthy = vi.fn(async () => ({ secret: 'ok' }));
    const a = brokerWith(failing);
    const b = brokerWith(healthy);

    await expect(a.resolve('test', target)).rejects.toThrow('credential_unavailable');
    await expect(a.resolve('test', target)).rejects.toThrow('credential_mint_backoff');
    expect(await b.resolve('test', target)).toBe('ok');
  });

  it('revoking a profile on one broker leaves the other broker cache intact', async () => {
    const mint = vi.fn(async () => ({ secret: `tok-${mint.mock.calls.length}` }));
    const revoke = vi.fn(async () => undefined);
    const a = brokerWith(mint, revoke);
    const b = brokerWith(mint, revoke);

    expect(await a.resolve('test', target)).toBe('tok-1');
    expect(await b.resolve('test', target)).toBe('tok-2');

    await a.revokeProfile('worker');

    expect(await a.resolve('test', target)).toBe('tok-3');
    expect(await b.resolve('test', target)).toBe('tok-2');
    expect(mint).toHaveBeenCalledTimes(3);
  });
});
