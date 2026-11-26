import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { MAX_RETRY_AGE_MS, ToolMetrics } from '../../../src/services/metrics/base.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { registerUsageRoutes } from '../../../src/services/admin/adapters/fastify/routes/usage.js';
import { emptyTimeWindow, windowSum } from '../../../src/services/metrics/window.js';
import type { MetricsDelta } from '../../../src/contracts/outbound/repositories.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 10, 12, 30, 10);

const delta = (over: Partial<MetricsDelta> = {}): MetricsDelta => ({
  tool_name: 'gh', total: 1, allow: 1, deny: 0, rule_denies: {},
  buckets_60s: [], buckets_1h: [], last_ts: 1000, last_duration_ms: 5, ...over,
});

describe('atomic seq claim', () => {
  it('rejects a lower seq from the same replica', async () => {
    const store = await SplicedockStore.open(':memory:');
    await store.addMetricsDelta(delta({ replica_id: 'r1', seq: 2 }));
    await store.addMetricsDelta(delta({ replica_id: 'r1', seq: 1 }));
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(1);
  });

  it('applies concurrent duplicates of one seq exactly once', async () => {
    const store = await SplicedockStore.open(':memory:');
    await Promise.all([1, 2, 3].map(() => store.addMetricsDelta(delta({ replica_id: 'r1', seq: 7 }))));
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(1);
  });

  it('a duplicate claim adds nothing to the windows either', async () => {
    const store = await SplicedockStore.open(':memory:');
    const first = await store.addMetricsDelta(delta({ replica_id: 'r1', seq: 1 }));
    const dup = await store.addMetricsDelta(delta({ replica_id: 'r1', seq: 1 }));
    expect(dup.buckets_1h).toEqual(first.buckets_1h);
    expect(dup.buckets_60s).toEqual(first.buckets_60s);
  });
});

describe('time-dependent metrics behaviour', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('drops an unacked delta retried for longer than MAX_RETRY_AGE_MS', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    m.record({ tool: 'gh', decision: 'allow' });
    const real = store.addMetricsDelta.bind(store);
    store.addMetricsDelta = async () => { throw new Error('down'); };
    await expect(m.flush()).rejects.toThrow('down');
    vi.setSystemTime(T0 + MAX_RETRY_AGE_MS + MIN);
    m.record({ tool: 'gh', decision: 'allow' });
    const sent: number[] = [];
    store.addMetricsDelta = async (d) => { sent.push(d.seq ?? -1); return real(d); };
    await m.flush();
    expect(sent).toEqual([2]); // seq 1 was given up, only the newer delta went out
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(1);
  });

  it('still retries an unacked delta younger than MAX_RETRY_AGE_MS', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    m.record({ tool: 'gh', decision: 'allow' });
    const real = store.addMetricsDelta.bind(store);
    store.addMetricsDelta = async () => { throw new Error('down'); };
    await expect(m.flush()).rejects.toThrow('down');
    vi.setSystemTime(T0 + MAX_RETRY_AGE_MS - MIN);
    store.addMetricsDelta = real;
    await m.flush();
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(1);
  });

  it('adopts a newer last call made on another replica', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start();
    await b.start();
    // b's clock runs ahead of a's. a records a call mid-flush, so the tool still has
    // pending work at refresh time and only adoptRow can bring b's newer call in.
    vi.setSystemTime(T0 + 5 * MIN);
    b.record({ tool: 'gh', decision: 'allow', duration_ms: 42 });
    await b.flush();
    vi.setSystemTime(T0);
    a.record({ tool: 'gh', decision: 'allow', duration_ms: 3 });
    const real = store.addMetricsDelta.bind(store);
    store.addMetricsDelta = async (d) => {
      const row = await real(d);
      vi.setSystemTime(T0 + MIN);
      a.record({ tool: 'gh', decision: 'allow', duration_ms: 4 });
      return row;
    };
    await a.flush();
    expect(a.get('gh')!.last_ts).toBe(T0 + 5 * MIN);
    expect(a.get('gh')!.last_duration_ms).toBe(42);
  });

  describe('usage route windows', () => {
    async function usage(m: ToolMetrics, since: string) {
      const app = Fastify({ logger: false });
      registerUsageRoutes(app, m);
      await app.ready();
      try {
        const res = await app.inject({ method: 'GET', url: `/api/v1/usage/gh?since=${since}` });
        return res.json().data as { calls_in_window: number; calls_in_window_complete: boolean };
      } finally { await app.close(); }
    }

    it('rolls to now: calls older than the range are not counted', async () => {
      const m = new ToolMetrics(null);
      m.record({ tool: 'gh', decision: 'allow' });
      vi.setSystemTime(T0 + 90 * MIN);
      expect((await usage(m, '60m')).calls_in_window).toBe(0);
    });

    it('counts only known minutes of a legacy snapshot and flags it incomplete', async () => {
      const store = await SplicedockStore.open(':memory:');
      await store.upsertMetricsSnapshot({
        tool_name: 'gh', total: 60, allow: 60, deny: 0, rule_denies: {},
        buckets_60s: new Array(60).fill(1), buckets_1h: [], last_ts: T0, last_duration_ms: null,
      });
      const m = new ToolMetrics(store, 0);
      await m.start();
      const r = await usage(m, '30m');
      expect(r.calls_in_window).toBeLessThanOrEqual(1);
      expect(r.calls_in_window_complete).toBe(false);
    });
  });
});

describe('windowSum', () => {
  const U = 1_000_000;

  it('sums the last n units of a fully known window', () => {
    const w = { ...emptyTimeWindow(5, U, 0), buckets: [1, 2, 3, 4, 5] };
    expect(windowSum(w, U, 2)).toEqual({ sum: 9, complete: true });
  });

  it('rolls to unitNow before summing', () => {
    const w = { ...emptyTimeWindow(5, U, 0), buckets: [1, 2, 3, 4, 5] };
    expect(windowSum(w, U + 2, 3)).toEqual({ sum: 5, complete: true });
  });

  it('skips unknown units and reports the sum as incomplete', () => {
    const w = { ...emptyTimeWindow(5, U, U - 1), buckets: [9, 9, 9, 4, 5] };
    expect(windowSum(w, U, 4)).toEqual({ sum: 9, complete: false });
  });

  it('caps the range at the window size', () => {
    const w = { ...emptyTimeWindow(3, U, 0), buckets: [1, 1, 1] };
    expect(windowSum(w, U, 99)).toEqual({ sum: 3, complete: true });
  });
});
