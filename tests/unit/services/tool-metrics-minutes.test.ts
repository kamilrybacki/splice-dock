import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolMetrics } from '../../../src/services/metrics/base.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 10, 12, 30, 10);
const minuteOf = (ts: number) => Math.floor(ts / MIN);
const call = (m: ToolMetrics, tool = 'git') => m.record({ tool, decision: 'allow' });

describe('ToolMetrics minute buckets', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('anchor is the absolute minute of the newest bucket and rotates', () => {
    const m = new ToolMetrics(null);
    call(m);
    vi.setSystemTime(T0 + 2 * MIN); call(m);
    const t = m.get('git')!;
    expect(t.bucket_60s_anchor).toBe(minuteOf(T0 + 2 * MIN));
    expect(t.buckets_60s[59]).toBe(1);
    expect(t.buckets_60s[57]).toBe(1);
  });

  it('replicas flushing in different minutes are summed by absolute minute', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start(); await b.start();
    call(a); call(a);
    vi.setSystemTime(T0 + 2 * MIN);
    call(b);
    await b.flush();
    await a.flush(); // a's window is anchored two minutes behind b's
    const row = (await store.getMetricsSnapshot('git'))!;
    expect(row.buckets_60s_anchor).toBe(minuteOf(T0 + 2 * MIN));
    expect(row.buckets_60s[57]).toBe(2);
    expect(row.buckets_60s[59]).toBe(1);
  });

  it('flushing twice does not overwrite or double count minute buckets', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    await a.start(); call(a); await a.flush(); call(a); await a.flush();
    expect((await store.getMetricsSnapshot('git'))!.buckets_60s[59]).toBe(2);
    expect(a.get('git')!.buckets_60s[59]).toBe(2);
  });

  it('a second replica no longer wipes the first replica minute counts', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start(); await b.start();
    call(a); await a.flush();
    call(b); await b.flush();
    expect((await store.getMetricsSnapshot('git'))!.buckets_60s[59]).toBe(2);
  });

  it('legacy rows without a minute anchor are unknown and still hydrate', async () => {
    const store = await SplicedockStore.open(':memory:');
    await store.upsertMetricsSnapshot({
      tool_name: 'git', total: 9, allow: 9, deny: 0, rule_denies: {},
      buckets_60s: new Array(60).fill(1), buckets_1h: [], last_ts: T0, last_duration_ms: null,
    });
    const m = new ToolMetrics(store, 0);
    await m.start();
    const t = m.get('git')!;
    expect(t.bucket_60s_from).toBe(minuteOf(T0));
    expect(t.buckets_60s).toHaveLength(60);
  });

  it('hydration after downtime shifts persisted minute buckets', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    await a.start(); call(a); await a.flush();
    vi.setSystemTime(T0 + 3 * MIN);
    const b = new ToolMetrics(store, 0);
    await b.start();
    expect(b.get('git')!.buckets_60s[56]).toBe(1);
  });
});
