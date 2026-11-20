import { expect, it, vi } from 'vitest';
import { resolveSecretStrict, configureSecretGuard } from '../../../src/application/auth/secret-guard.js';
it('bounds stalled resolution and redacts failures', async () => {
  configureSecretGuard({ timeout_ms: 10 });
  vi.stubEnv('VAULT_ADDR', 'http://localhost');
  vi.stubEnv('VAULT_TOKEN', 'test');
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  expect(await resolveSecretStrict('vault:private-test-reference', { auth: true, destructive: true })).toEqual({ ok: false, code: 'vault_timeout' });
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
it('never falls back after a successful credential resolution', async () => {
  configureSecretGuard({ timeout_ms: 100 });
  vi.stubEnv('VAULT_ADDR', 'http://localhost'); vi.stubEnv('VAULT_TOKEN', 'test');
  const mock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: { data: { value: 'test-fixture' } } }) }).mockRejectedValue(new Error('sensitive diagnostic'));
  vi.stubGlobal('fetch', mock);
  try {
    expect((await resolveSecretStrict('vault:test-reference', { auth: true, destructive: true })).ok).toBe(true);
    expect(await resolveSecretStrict('vault:test-reference', { auth: true, destructive: true })).toEqual({ ok: false, code: 'vault_unavailable' });
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
