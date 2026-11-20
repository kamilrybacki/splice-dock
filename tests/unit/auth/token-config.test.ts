import { expect, it } from 'vitest';
import { splicedockConfigSchema } from '../../../src/config/schema.js';
it('validates policy defaults, rejects unknown keys and unsafe Vault degradation', () => {
  const server = splicedockConfigSchema.parse({}).server;
  expect(server.token_policy.inactivity_mode).toBe('observe');
  expect(server.token_policy.inactivity_days).toBe(30);
  for (const override of [
    { token_policy: { typo: true } }, { vault: { typo: true } },
    { vault: { timeout_ms: 0 } }, { vault: { fail_closed_auth: false } },
    { vault: { fail_closed_destructive: false } }, { vault: { read_cache_seconds: 1 } },
    { token_policy: { max_ttl_seconds: 60, default_ttl_seconds: 120 } },
  ]) expect(splicedockConfigSchema.safeParse({ server: override }).success).toBe(false);
});
