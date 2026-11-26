import { describe, it, expect } from 'vitest';
import { ToolMetrics } from '../../../src/services/metrics/base.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import type { MetricsDelta } from '../../../src/contracts/outbound/repositories.js';

const delta = (over: Partial<MetricsDelta> = {}): MetricsDelta => ({
  tool_name: 'gh', total: 1, allow: 1, deny: 0, rule_denies: {},
  buckets_60s: [], buckets_1h: [], last_ts: 1000, last_duration_ms: 5, ...over,
});

describe('idempotent delta delivery', () => {
  it('store applies a (replica, tool, seq) delta only once', async () => {
    const store = await SplicedockStore.open(':memory:');
    await store.addMetricsDelta(delta({ replica_id: 'r1', seq: 1 }));
    const again = await store.addMetricsDelta(delta({ replica_id: 'r1', seq: 1 }));
    expect(again.total).toBe(1);
    await store.addMetricsDelta(delta({ replica_id: 'r1', seq: 2 }));
    await store.addMetricsDelta(delta({ replica_id: 'r2', seq: 1 }));
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(3);
  });

  it('deltas without a replica id are always applied', async () => {
    const store = await SplicedockStore.open(':memory:');
    await store.addMetricsDelta(delta());
    await store.addMetricsDelta(delta());
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(2);
  });

  it('a flush that committed but reported failure is not counted twice', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    m.record({ tool: 'gh', decision: 'allow' });
    const real = store.addMetricsDelta.bind(store);
    store.addMetricsDelta = async (d) => { await real(d); throw new Error('commit reply lost'); };
    await expect(m.flush()).rejects.toThrow('commit reply lost');
    m.record({ tool: 'gh', decision: 'allow' }); // newer increment must not be folded into the failed delta
    store.addMetricsDelta = real;
    await m.flush();
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(2);
    expect(m.get('gh')!.total).toBe(2);
  });

  it('resends the failed delta first, then newer increments with a new seq', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    m.record({ tool: 'gh', decision: 'allow' });
    const real = store.addMetricsDelta.bind(store);
    store.addMetricsDelta = async () => { throw new Error('down'); };
    await expect(m.flush()).rejects.toThrow('down');
    m.record({ tool: 'gh', decision: 'allow' });
    const sent: Array<[number, number | undefined]> = [];
    store.addMetricsDelta = async (d) => { sent.push([d.total, d.seq]); return real(d); };
    await m.flush();
    expect(sent).toEqual([[1, 1], [1, 2]]);
  });

  it('prunes applied-seq rows older than a week', async () => {
    const store = await SplicedockStore.open(':memory:');
    await store.addMetricsDelta(delta({ replica_id: 'old', seq: 5 }));
    const realNow = Date.now;
    Date.now = () => realNow() + 8 * 24 * 3600_000;
    try {
      await store.addMetricsDelta(delta({ replica_id: 'new', seq: 1 }));
      // 'old' was pruned, so its seq 5 is no longer remembered.
      await store.addMetricsDelta(delta({ replica_id: 'old', seq: 5 }));
    } finally { Date.now = realNow; }
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(3);
  });
});
