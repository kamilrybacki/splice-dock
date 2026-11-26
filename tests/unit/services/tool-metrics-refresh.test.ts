import { describe, it, expect } from 'vitest';
import { ToolMetrics } from '../../../src/services/metrics/base.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';

describe('refresh from the DB on flush', () => {
  it('shows a tool first seen on another replica after a flush tick with nothing pending', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start();
    await b.start();
    b.record({ tool: 'gh', decision: 'allow', duration_ms: 7 });
    b.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    await b.flush();
    expect(a.get('gh')).toBeNull();
    await a.flush();
    const m = a.get('gh')!;
    expect(m.total).toBe(2);
    expect(m.allow).toBe(1);
    expect(m.deny).toBe(1);
    expect(m.rule_denies).toEqual({ r1: 1 });
    expect(m.last_duration_ms).toBe(7);
    expect(m.buckets_1h.reduce((x, y) => x + y, 0)).toBe(2);
  });

  it('keeps this replica own counters out of localCounters', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start();
    await b.start();
    b.record({ tool: 'gh', decision: 'allow', duration_ms: 99 });
    await b.flush();
    a.record({ tool: 'gh', decision: 'allow' });
    await a.flush();
    expect(a.get('gh')!.total).toBe(2); // cluster-wide view
    expect(a.localCounters()).toEqual([
      { tool: 'gh', allow: 1, deny: 0, rule_denies: {}, last_duration_ms: null },
    ]);
    b.record({ tool: 'npm', decision: 'allow' });
    await b.flush();
    await a.flush();
    const npm = a.localCounters().find(c => c.tool === 'npm')!;
    expect(npm.allow).toBe(0);
  });

  it('does not double count or overwrite tools with unflushed increments', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    await a.start();
    a.record({ tool: 'gh', decision: 'allow' });
    const real = store.addMetricsDelta.bind(store);
    store.addMetricsDelta = async () => { throw new Error('down'); };
    await expect(a.flush()).rejects.toThrow('down');
    expect(a.get('gh')!.total).toBe(1); // refresh must not regress it to the empty DB row
    store.addMetricsDelta = real;
    await a.flush();
    await a.flush();
    expect(a.get('gh')!.total).toBe(1);
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(1);
  });
});
