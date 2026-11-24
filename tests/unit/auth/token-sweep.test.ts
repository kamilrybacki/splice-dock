import { expect, it, vi } from 'vitest';
import { startTokenSweep } from '../../../src/services/authentication/lifecycle/tokens.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { splicedockConfigSchema } from '../../../src/config/schema.js';
import { createPrometheusMetrics } from '../../../src/services/metrics/adapters/prometheus/index.js';
it('schedules observation by default and cancels before database shutdown', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const store = await SplicedockStore.open(':memory:');
  const metrics = createPrometheusMetrics();
  const policy = splicedockConfigSchema.parse({}).server.token_policy;
  await store.insertProfileToken('old', 'ops', 'hash');
  vi.setSystemTime(1000 + 31 * 86400000);
  const stop = startTokenSweep(store, policy, metrics);
  try {
    await vi.advanceTimersByTimeAsync(policy.sweep_interval_seconds * 1000);
    await vi.waitFor(async () => { expect((await metrics.tokenLifecycle.get()).values.length).toBeGreaterThan(0); });
    expect((await store.listProfileTokens())[0].revoked_at).toBeNull();
    expect((await metrics.tokenLifecycle.get()).values).toEqual(expect.arrayContaining([expect.objectContaining({ labels: { event: 'would_revoke_inactive' }, value: 1 })]));
  } finally { stop(); await store.close(); metrics.registry.clear(); vi.useRealTimers(); }
});
