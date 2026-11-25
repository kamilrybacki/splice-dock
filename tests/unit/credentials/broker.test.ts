import { resolveCredentialSource } from '../../../src/services/secrets/adapters/resolution.js';
import { credentialAdapters } from '../../../src/services/secrets/adapters/index.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureCredentialBroker,
  resetCredentialBroker,
  resetCredentialCache,
  resolveMintedCredential,
  revokeProfileCredentials,
} from '../../../src/services/secrets/broker.js';
import { logger } from '../../../src/common/logger.js';
import type { CredentialProviderConfig } from '../../../src/config/types.js';
import type { CredentialAdapters, MintedCredential } from '../../../src/services/secrets/base.js';
import { MemoryCredentialStore } from '../../../src/services/secrets/memory/store.js';

let dir: string;
let counter: string;

const COUNT_AND_PRINT = 'n=$(cat "$0" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0"; echo tok-$n';
const COUNT_AND_PRINT_JSON =
  `n=$(cat "$0" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0"; printf '{"token":"tok-%s","exp":1}' "$n"`;

/** Each mint prints `tok-<n>` from a counter file, so a remint is visible. */
function commandProvider(
  overrides: Partial<Extract<CredentialProviderConfig, { type: 'command' }>> = {},
): Extract<CredentialProviderConfig, { type: 'command' }> {
  return {
    type: 'command',
    command: 'sh',
    args: ['-c', COUNT_AND_PRINT, counter],
    timeout_ms: 5000,
    ttl_seconds: 3600,
    max_ttl_seconds: 86_400,
    output: { format: 'text', secret_field: 'token' },
    ...overrides,
  };
}

function configure(providers: Record<string, CredentialProviderConfig> = { test: commandProvider() }): void {
  configureCredentialBroker({ providers, storage: { type: 'memory', prefix: '' } }, credentialAdapters);
}

const target = { profile: 'worker', agent: null, backend: 'vault', authenticated: true, tokenId: 'tid-1' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splicedock-mint-'));
  counter = join(dir, 'counter');
  writeFileSync(counter, '0');
});

afterEach(() => {
  resetCredentialBroker();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('credential broker', () => {
  it('mints once and reuses the cached value', async () => {
    configure();
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
  });

  it('single-flights concurrent callers', async () => {
    configure();
    const values = await Promise.all(Array.from({ length: 8 }, () => resolveMintedCredential('test', target)));
    expect(new Set(values)).toEqual(new Set(['tok-1']));
  });

  it('keys the cache by profile, agent and backend', async () => {
    configure();
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    expect(await resolveMintedCredential('test', { ...target, profile: 'other' })).toBe('tok-2');
    expect(await resolveMintedCredential('test', { ...target, agent: 'bot' })).toBe('tok-3');
    expect(await resolveMintedCredential('test', { ...target, backend: 'grafana' })).toBe('tok-4');
  });

  it('reuses a value persisted in the store after the cache is dropped', async () => {
    configure();
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    // Drop only the in-memory layer, as another replica would never have it.
    resetCredentialCache();
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
  });

  it('remints once the credential is close to expiry', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    configure({
      test: commandProvider({
        args: ['-c', COUNT_AND_PRINT_JSON, counter],
        output: { format: 'json', secret_field: 'token', expires_in_field: 'exp' },
      }),
    });

    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    vi.spyOn(Date, 'now').mockReturnValue(now + 950);
    expect(await resolveMintedCredential('test', target)).toBe('tok-2');
  });

  it('fails closed on a provider error and retries on the next call', async () => {
    configure({ test: commandProvider({ command: 'sh', args: ['-c', 'exit 3'] }) });
    await expect(resolveMintedCredential('test', target)).rejects.toThrow('credential_unavailable');
    await expect(resolveMintedCredential('test', target)).rejects.toThrow('credential_unavailable');
  });

  it('refuses an undeclared provider', async () => {
    configure();
    await expect(resolveMintedCredential('nope', target)).rejects.toThrow('unknown_credential_provider');
  });

  it('refuses to mint without a profile identity', async () => {
    configure();
    await expect(resolveMintedCredential('test', { ...target, profile: '' })).rejects.toThrow('credential_identity_missing');
  });

  it('rejects an unauthenticated target without calling the provider on a cold cache', async () => {
    configure();
    await expect(resolveMintedCredential('test', { ...target, authenticated: false, tokenId: 'legacy-query' }))
      .rejects.toThrow('credential_identity_unauthenticated');
    expect(readFileSync(counter, 'utf8').trim()).toBe('0');
  });

  it('rejects an unauthenticated target even when the cache is warm', async () => {
    configure();
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    await expect(resolveMintedCredential('test', { ...target, authenticated: false }))
      .rejects.toThrow('credential_identity_unauthenticated');
    expect(readFileSync(counter, 'utf8').trim()).toBe('1');
  });

  it('refuses an unauthenticated request that arrives while an authenticated mint is in flight', async () => {
    configure();
    const authenticated = resolveMintedCredential('test', target);
    const anonymous = resolveMintedCredential('test', { ...target, authenticated: false, tokenId: 'legacy-query' });
    await expect(anonymous).rejects.toThrow('credential_identity_unauthenticated');
    expect(await authenticated).toBe('tok-1');
    expect(readFileSync(counter, 'utf8').trim()).toBe('1');
  });

  it('includes the token id in the credential minted log, never the value', async () => {
    configure();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    await resolveMintedCredential('test', target);
    const call = info.mock.calls.find(c => c[0] === 'credential minted');
    expect(call?.[1]).toMatchObject({ token_id: 'tid-1' });
    expect(JSON.stringify(call)).not.toContain('tok-1');
  });

  it('resolves static and minted sources through one entry point', async () => {
    configure();
    process.env['BROKER_TEST_TOKEN'] = 'static-value';
    try {
      expect(await resolveCredentialSource({ from: 'env:BROKER_TEST_TOKEN' }, target)).toBe('static-value');
      expect(await resolveCredentialSource({ mint: 'test' }, target)).toBe('tok-1');
    } finally {
      delete process.env['BROKER_TEST_TOKEN'];
    }
  });

  it('purges a profile on revocation so the next call mints again', async () => {
    configure();
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    await revokeProfileCredentials('worker');
    expect(await resolveMintedCredential('test', target)).toBe('tok-2');
  });
});

describe('credential lifetime cap', () => {
  const NOW = 1_800_000_000_000;
  const HOUR_MS = 3_600_000;
  const TEN_YEARS_MS = 10 * 365 * 24 * HOUR_MS;
  const PROVIDER = commandProvider({ ttl_seconds: 3600, max_ttl_seconds: 7200 });

  function wire(mint: () => MintedCredential, store = new MemoryCredentialStore(), config = PROVIDER) {
    let mints = 0;
    const adapters: CredentialAdapters = {
      provider: () => ({ mint: async () => ({ ...mint(), secret: `tok-${++mints}` }) }),
      store: () => store,
    };
    configureCredentialBroker({ providers: { test: config }, storage: { type: 'memory', prefix: '' } }, adapters);
    return store;
  }

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  it('caps a provider-reported expiry that is far in the future', async () => {
    const store = wire(() => ({ secret: '', expiresAt: NOW + TEN_YEARS_MS }));
    await resolveMintedCredential('test', target);
    expect((await store.get('worker/vault/_/test'))?.expiresAt).toBe(NOW + 7200_000);

    // Past the cap the cached value must not be served any more.
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 7200_000 + 1);
    expect(await resolveMintedCredential('test', target)).toBe('tok-2');
  });

  it('applies ttl_seconds when the provider reports no expiry', async () => {
    const store = wire(() => ({ secret: '' }));
    await resolveMintedCredential('test', target);
    expect((await store.get('worker/vault/_/test'))?.expiresAt).toBe(NOW + 3600_000);
  });

  it('keeps a provider expiry that is already inside the cap', async () => {
    const store = wire(() => ({ secret: '', expiresAt: NOW + 600_000 }));
    await resolveMintedCredential('test', target);
    expect(await store.get('worker/vault/_/test')).toMatchObject({ expiresAt: NOW + 600_000, ttlMs: 600_000 });
  });

  it('sizes the stored lifetime from the capped expiry', async () => {
    const store = wire(() => ({ secret: '', expiresAt: NOW + TEN_YEARS_MS }));
    await resolveMintedCredential('test', target);
    expect((await store.get('worker/vault/_/test'))?.ttlMs).toBe(7200_000);
  });

  it('logs when the cap applies, without the credential value', async () => {
    wire(() => ({ secret: '', expiresAt: NOW + TEN_YEARS_MS }));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await resolveMintedCredential('test', target);
    const call = warn.mock.calls.find(c => c[0] === 'credential lifetime capped');
    expect(call?.[1]).toMatchObject({
      provider: 'test',
      profile: 'worker',
      backend: 'vault',
      reported_expires_at: NOW + TEN_YEARS_MS,
      expires_at: NOW + 7200_000,
      max_ttl_seconds: 7200,
    });
    expect(JSON.stringify(call)).not.toContain('tok-1');
  });

  it('does not log a cap event when nothing was capped', async () => {
    wire(() => ({ secret: '', expiresAt: NOW + 600_000 }));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await resolveMintedCredential('test', target);
    expect(warn.mock.calls.some(c => c[0] === 'credential lifetime capped')).toBe(false);
  });

  it('does not trust a stored entry that outlives the cap, and replaces it', async () => {
    const store = wire(() => ({ secret: '', expiresAt: NOW + 600_000 }));
    await store.put('worker/vault/_/test', {
      value: 'old-secret',
      expiresAt: NOW + TEN_YEARS_MS,
      ttlMs: TEN_YEARS_MS,
      provider: 'test',
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    expect(await store.get('worker/vault/_/test')).toMatchObject({ value: 'tok-1', expiresAt: NOW + 600_000 });
    const call = warn.mock.calls.find(c => c[0] === 'credential store entry exceeds max_ttl; reminting');
    expect(call?.[1]).toMatchObject({ provider: 'test', profile: 'worker', max_ttl_seconds: 7200 });
    expect(JSON.stringify(call)).not.toContain('old-secret');
  });

  it('still reuses a stored entry that is within the cap', async () => {
    const store = wire(() => ({ secret: '' }));
    await store.put('worker/vault/_/test', {
      value: 'kept',
      expiresAt: NOW + 3600_000,
      ttlMs: 3600_000,
      provider: 'test',
    });
    expect(await resolveMintedCredential('test', target)).toBe('kept');
  });

  it('rejects an old entry that was issued for longer than the cap, even with little time left', async () => {
    const store = wire(() => ({ secret: '', expiresAt: NOW + 600_000 }));
    await store.put('worker/vault/_/test', {
      value: 'old-secret',
      expiresAt: NOW + 3600_000,
      ttlMs: 10 * 86_400_000,
      provider: 'test',
    });
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
  });

  it('reuses an entry written at exactly the cap by a replica whose clock runs ahead', async () => {
    const store = wire(() => ({ secret: '' }));
    await store.put('worker/vault/_/test', {
      value: 'kept',
      expiresAt: NOW + 7200_000 + 30_000,
      ttlMs: 7200_000,
      provider: 'test',
    });
    expect(await resolveMintedCredential('test', target)).toBe('kept');
  });

  it('remints an entry that records no lifetime', async () => {
    const store = wire(() => ({ secret: '', expiresAt: NOW + 600_000 }));
    await store.put('worker/vault/_/test', { value: 'legacy', expiresAt: NOW + 3600_000, provider: 'test' });
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
  });

  it('does not let a persisted far-future entry outlive the cap across restarts', async () => {
    const store = wire(() => ({ secret: '', expiresAt: NOW + 600_000 }));
    await store.put('worker/vault/_/test', {
      value: 'old-secret',
      expiresAt: NOW + TEN_YEARS_MS,
      provider: 'test',
    });
    expect(await resolveMintedCredential('test', target)).toBe('tok-1');
    // A restarted replica reads the replaced, bounded entry, not the old one.
    resetCredentialCache();
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 7200_000 + 1);
    expect(await resolveMintedCredential('test', target)).toBe('tok-2');
  });

  it('falls back to a safe default cap when the config carries none', async () => {
    const withoutCap = { ...PROVIDER } as Partial<typeof PROVIDER>;
    delete withoutCap.max_ttl_seconds;
    const store = wire(() => ({ secret: '', expiresAt: NOW + TEN_YEARS_MS }), new MemoryCredentialStore(), withoutCap as typeof PROVIDER);
    await resolveMintedCredential('test', target);
    expect((await store.get('worker/vault/_/test'))?.expiresAt).toBe(NOW + 86_400_000);
  });
});
