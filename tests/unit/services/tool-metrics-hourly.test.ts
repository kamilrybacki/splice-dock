import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolMetrics } from '../../../src/services/metrics/base.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 10, 12, 30); // mid-hour

const call = (m: ToolMetrics, tool = 'git') => m.record({ tool, decision: 'allow' });

describe('ToolMetrics hourly buckets', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('records into the current hour and rotates across hour boundaries', () => {
    const m = new ToolMetrics(null);
    call(m); call(m);
    vi.setSystemTime(T0 + HOUR); call(m);
    const t = m.get('git')!;
    expect(t.buckets_1h[23]).toBe(1);
    expect(t.buckets_1h[22]).toBe(2);
    expect(t.bucket_1h_anchor).toBe(Math.floor((T0 + HOUR) / HOUR));
  });

  it('handles multi-hour gaps and a gap of a day or more', () => {
    const m = new ToolMetrics(null);
    call(m);
    vi.setSystemTime(T0 + 5 * HOUR);
    expect(m.get('git')!.buckets_1h[18]).toBe(1);
    vi.setSystemTime(T0 + 30 * HOUR);
    expect(m.get('git')!.buckets_1h.every(n => n === 0)).toBe(true);
  });

  it('hourlyHistory has no invented zeros before the process knew about the tool', () => {
    const m = new ToolMetrics(null);
    expect(m.hourlyHistory()).toBeNull();
    call(m);
    vi.setSystemTime(T0 + 2 * HOUR);
    const h = m.hourlyHistory()!;
    expect(h.buckets).toEqual([1, 0, 0]);
    expect(h.startTs).toBe(Math.floor(T0 / HOUR) * HOUR);
    expect(h.lastInProgress).toBe(true);
  });

  it('hydration after downtime shifts persisted buckets by the elapsed hours', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    await a.start(); call(a); call(a); await a.flush();
    vi.setSystemTime(T0 + 3 * HOUR);
    const b = new ToolMetrics(store, 0);
    await b.start();
    const t = b.get('git')!;
    expect(t.buckets_1h[20]).toBe(2);
    expect(t.buckets_1h[23]).toBe(0);
    call(b);
    expect(b.get('git')!.buckets_1h[23]).toBe(1);
    // A DB-backed tool known since its first flush: earlier hours had no calls, so 24 known buckets.
    const h = b.hourlyHistory()!;
    expect(h.buckets).toHaveLength(24);
    expect(h.buckets.slice(-4)).toEqual([2, 0, 0, 1]);
  });

  it('drops everything after 24h+ of downtime', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    await a.start(); call(a); await a.flush();
    vi.setSystemTime(T0 + 40 * HOUR);
    const b = new ToolMetrics(store, 0);
    await b.start();
    expect(b.get('git')!.buckets_1h.every(n => n === 0)).toBe(true);
  });

  it('legacy rows without an anchor are unknown, not zero', async () => {
    const store = await SplicedockStore.open(':memory:');
    await store.upsertMetricsSnapshot({
      tool_name: 'git', total: 9, allow: 9, deny: 0, rule_denies: {},
      buckets_60s: [], buckets_1h: new Array(24).fill(1), last_ts: T0, last_duration_ms: null,
    });
    const m = new ToolMetrics(store, 0);
    await m.start();
    const h = m.hourlyHistory()!;
    expect(h.buckets).toEqual([0]);
    expect(h.startTs).toBe(Math.floor(T0 / HOUR) * HOUR);
  });

  it('replicas flushing in different hours are aligned by absolute hour and summed', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start(); await b.start();
    call(a); call(a);               // hour H
    vi.setSystemTime(T0 + 2 * HOUR);
    call(b);                        // hour H+2
    await b.flush();
    await a.flush();                // a flushes late; its window is anchored at H
    const row = (await store.getMetricsSnapshot('git'))!;
    expect(row.buckets_1h_anchor).toBe(Math.floor((T0 + 2 * HOUR) / HOUR));
    expect(row.buckets_1h[21]).toBe(2);
    expect(row.buckets_1h[23]).toBe(1);
    expect(row.total).toBe(3);
  });

  it('flushing twice does not double count hourly buckets', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    await a.start(); call(a); await a.flush(); call(a); await a.flush();
    const row = (await store.getMetricsSnapshot('git'))!;
    expect(row.buckets_1h[23]).toBe(2);
    expect(a.get('git')!.buckets_1h[23]).toBe(2);
  });
});
