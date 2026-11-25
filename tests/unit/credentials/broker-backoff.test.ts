import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MINT_BACKOFF_BASE_MS,
  MINT_BACKOFF_MAX_MS,
  createCredentialBroker,
} from '../../../src/services/secrets/broker.js';
import { MemoryCredentialStore } from '../../../src/services/secrets/memory/store.js';
import type { CredentialAdapters, CredentialBroker, MintContext, MintedCredential } from '../../../src/services/secrets/base.js';

type Outcome = 'fail' | 'ok' | { ok: true; lifetimeMs: number };

const target = { profile: 'worker', agent: null, backend: 'vault', authenticated: true, tokenId: 'tid-1' };

let outcomes: Outcome[];
let broker: CredentialBroker;
let mint: ReturnType<typeof vi.fn<(ctx: MintContext) => Promise<MintedCredential>>>;

/** Scripted provider: each mint consumes the next outcome, `ok` once the script runs out. */
function configure(): void {
  let n = 0;
  mint = vi.fn(async () => {
    const next = outcomes.shift() ?? 'ok';
    if (next === 'fail') throw new Error('upstream down');
    n += 1;
    return typeof next === 'object'
      ? { secret: `tok-${n}`, expiresAt: Date.now() + next.lifetimeMs }
      : { secret: `tok-${n}` };
  });
  const adapters: CredentialAdapters = {
    provider: () => ({ mint, revoke: async () => undefined }),
    store: () => new MemoryCredentialStore(),
  };
  broker = createCredentialBroker({
    providers: { test: { type: 'command', command: 'unused', args: [], timeout_ms: 1000, ttl_seconds: 3600, output: { format: 'text', secret_field: 'token' } } },
    storage: { type: 'memory', prefix: '' },
  }, adapters);
}

async function failureOf(call: Promise<string>): Promise<Error & { retryAfterMs?: number }> {
  try {
    await call;
  } catch (err) {
    return err as Error & { retryAfterMs?: number };
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  // Zero jitter by default: the window is exactly the computed delay.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  outcomes = [];
  configure();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('credential mint failure backoff', () => {
  it('fails fast inside the window without calling the provider', async () => {
    outcomes = ['fail'];
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    expect(mint).toHaveBeenCalledTimes(1);

    const err = await failureOf(broker.resolve('test', target));
    expect(err.message).toBe('credential_mint_backoff');
    expect(err.retryAfterMs).toBe(MINT_BACKOFF_BASE_MS);
    expect(mint).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(400);
    const later = await failureOf(broker.resolve('test', target));
    expect(later.retryAfterMs).toBe(MINT_BACKOFF_BASE_MS - 400);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('calls the provider again once the window has passed', async () => {
    outcomes = ['fail', 'ok'];
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    vi.advanceTimersByTime(MINT_BACKOFF_BASE_MS);
    expect(await broker.resolve('test', target)).toBe('tok-1');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('doubles the window on each consecutive failure up to the ceiling', async () => {
    outcomes = Array.from({ length: 12 }, () => 'fail' as const);
    let expected = MINT_BACKOFF_BASE_MS;
    for (let i = 0; i < 9; i++) {
      await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
      const blocked = await failureOf(broker.resolve('test', target));
      expect(blocked.retryAfterMs).toBe(Math.min(expected, MINT_BACKOFF_MAX_MS));
      vi.advanceTimersByTime(Math.min(expected, MINT_BACKOFF_MAX_MS));
      expected *= 2;
    }
    expect(MINT_BACKOFF_MAX_MS).toBe(60_000);
  });

  it('shortens the window by jitter but never past the ceiling', async () => {
    outcomes = Array.from({ length: 12 }, () => 'fail' as const);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    const err = await failureOf(broker.resolve('test', target));
    expect(err.retryAfterMs).toBeLessThan(MINT_BACKOFF_BASE_MS);
    expect(err.retryAfterMs).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(MINT_BACKOFF_MAX_MS);
      await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
      const next = await failureOf(broker.resolve('test', target));
      expect(next.retryAfterMs).toBeLessThanOrEqual(MINT_BACKOFF_MAX_MS);
    }
  });

  it('resets the backoff after a successful mint', async () => {
    outcomes = ['fail', 'fail', { ok: true, lifetimeMs: 1000 }, 'fail'];
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    vi.advanceTimersByTime(MINT_BACKOFF_BASE_MS);
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    vi.advanceTimersByTime(MINT_BACKOFF_BASE_MS * 2);
    expect(await broker.resolve('test', target)).toBe('tok-1');

    // The credential expires; the next mint fails and starts from the base window again.
    vi.advanceTimersByTime(1000);
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    const err = await failureOf(broker.resolve('test', target));
    expect(err.retryAfterMs).toBe(MINT_BACKOFF_BASE_MS);
  });

  it('forgets a long-quiet failure streak', async () => {
    outcomes = ['fail', 'fail', 'fail', 'fail', 'fail'];
    for (let i = 0; i < 4; i++) {
      await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
      vi.advanceTimersByTime(MINT_BACKOFF_MAX_MS);
    }
    // Quiet for far longer than the ceiling, then one more failure.
    vi.advanceTimersByTime(MINT_BACKOFF_MAX_MS * 3);
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    const err = await failureOf(broker.resolve('test', target));
    expect(err.retryAfterMs).toBe(MINT_BACKOFF_BASE_MS);
  });

  it('shares one failed mint between concurrent callers, then backs off', async () => {
    outcomes = ['fail'];
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => broker.resolve('test', target)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(mint).toHaveBeenCalledTimes(1);
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_mint_backoff');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('keeps backoff per key: another profile, agent or backend still mints', async () => {
    outcomes = ['fail'];
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    expect(await broker.resolve('test', { ...target, profile: 'other' })).toBe('tok-1');
    expect(await broker.resolve('test', { ...target, agent: 'bot' })).toBe('tok-2');
    expect(await broker.resolve('test', { ...target, backend: 'grafana' })).toBe('tok-3');
  });

  describe('identity errors', () => {
    it('are not cached and never block other callers', async () => {
      await expect(broker.resolve('test', { ...target, profile: '' })).rejects.toThrow('credential_identity_missing');
      await expect(broker.resolve('test', { ...target, authenticated: false })).rejects.toThrow('credential_identity_unauthenticated');
      expect(mint).not.toHaveBeenCalled();
      // The same key as the refused unauthenticated call mints for a real caller.
      expect(await broker.resolve('test', target)).toBe('tok-1');
    });

    it('still win over an active backoff for the same key', async () => {
      outcomes = ['fail'];
      await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
      await expect(broker.resolve('test', { ...target, authenticated: false }))
        .rejects.toThrow('credential_identity_unauthenticated');
      await expect(broker.resolve('test', { ...target, profile: '' }))
        .rejects.toThrow('credential_identity_missing');
    });

    it('do not start a backoff by themselves', async () => {
      await expect(broker.resolve('test', { ...target, authenticated: false })).rejects.toThrow('credential_identity_unauthenticated');
      await expect(broker.resolve('nope', target)).rejects.toThrow('unknown_credential_provider');
      outcomes = ['fail'];
      await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
      const err = await failureOf(broker.resolve('test', target));
      expect(err.retryAfterMs).toBe(MINT_BACKOFF_BASE_MS);
    });
  });

  it('is not shared with another broker instance', async () => {
    outcomes = ['fail'];
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_mint_backoff');
    configure();
    expect(await broker.resolve('test', target)).toBe('tok-1');
  });

  it('is cleared for a profile when its credentials are revoked', async () => {
    outcomes = ['fail'];
    await expect(broker.resolve('test', target)).rejects.toThrow('credential_unavailable');
    await broker.revokeProfile('worker');
    expect(await broker.resolve('test', target)).toBe('tok-1');
  });

  it('keeps the backoff of other profiles when one is revoked', async () => {
    outcomes = ['fail'];
    await expect(broker.resolve('test', { ...target, profile: 'keeper' })).rejects.toThrow('credential_unavailable');
    await broker.revokeProfile('worker');
    await expect(broker.resolve('test', { ...target, profile: 'keeper' })).rejects.toThrow('credential_mint_backoff');
  });
  describe('a mint that is still running when the state is cleaned up', () => {
    function deferredFailure(): { release: () => void } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      mint.mockImplementationOnce(async () => {
        await gate;
        throw new Error('upstream down');
      });
      return { release };
    }

    it('does not write its failure back after the profile is revoked', async () => {
      const { release } = deferredFailure();
      const pending = broker.resolve('test', target);
      await vi.advanceTimersByTimeAsync(0);
      await broker.revokeProfile('worker');
      release();
      await expect(pending).rejects.toThrow('credential_unavailable');
      expect(await broker.resolve('test', target)).toBe('tok-1');
    });
  });
});
