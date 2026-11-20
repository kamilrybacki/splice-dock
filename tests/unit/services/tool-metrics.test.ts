import { describe, it, expect, beforeEach } from 'vitest';
import { ToolMetrics } from '../../../src/application/metrics/tool-metrics.js';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';

describe('ToolMetrics', () => {
  let metrics: ToolMetrics;
  beforeEach(async () => {
    // In-memory SQLite for the snapshot side; flush interval disabled (0).
    metrics = new ToolMetrics(await SplicedockStore.open(':memory:'), 0);
    await metrics.start();
  });

  it('records allow / deny / rule_denies', () => {
    metrics.record({ tool: 'gh', decision: 'allow' });
    metrics.record({ tool: 'gh', decision: 'deny', rule: 'deny_subcommands' });
    metrics.record({ tool: 'gh', decision: 'deny', rule: 'deny_subcommands' });
    const m = metrics.get('gh')!;
    expect(m.total).toBe(3);
    expect(m.allow).toBe(1);
    expect(m.deny).toBe(2);
    expect(m.rule_denies).toEqual({ deny_subcommands: 2 });
  });

  it('list returns all tools sorted', () => {
    metrics.record({ tool: 'gh', decision: 'allow' });
    metrics.record({ tool: 'codex', decision: 'allow' });
    metrics.record({ tool: 'kubectl', decision: 'allow' });
    expect(metrics.list().map(m => m.tool)).toEqual(['codex', 'gh', 'kubectl']);
  });

  it('record increments the current minute bucket', () => {
    metrics.record({ tool: 'gh', decision: 'allow' });
    metrics.record({ tool: 'gh', decision: 'allow' });
    const m = metrics.get('gh')!;
    // Newest bucket sits at index length-1; total inside the window === 2.
    expect(m.buckets_60s[m.buckets_60s.length - 1]).toBe(2);
    expect(m.buckets_1h[m.buckets_1h.length - 1]).toBe(2);
  });

  it('prometheus exposition contains the expected labels', () => {
    metrics.record({ tool: 'gh', decision: 'allow' });
    metrics.record({ tool: 'gh', decision: 'deny', rule: 'deny_subcommands' });
    const out = metrics.prometheus();
    expect(out).toContain('splicedock_cli_calls_total{tool="gh",decision="allow"} 1');
    expect(out).toContain('splicedock_cli_calls_total{tool="gh",decision="deny"} 1');
    expect(out).toContain('splicedock_cli_deny_total{tool="gh",rule="deny_subcommands"} 1');
  });

  it('snapshot persists across instances when sharing a db', async () => {
    const db = await SplicedockStore.open(':memory:');
    const m1 = new ToolMetrics(db, 0);
    await m1.start();
    m1.record({ tool: 'gh', decision: 'allow' });
    await m1.flush();
    const m2 = new ToolMetrics(db, 0);
    await m2.start();
    expect(m2.get('gh')?.allow).toBe(1);
  });

  it('quote escapes label values', () => {
    const m = new ToolMetrics(null);
    m.record({ tool: 'weird"name', decision: 'allow' });
    expect(m.prometheus()).toContain('splicedock_cli_calls_total{tool="weird\\"name"');
  });
});

describe('ToolMetrics multi-replica flush', () => {
  it('two replicas sharing one store add counts instead of overwriting', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start();
    await b.start();
    a.record({ tool: 'gh', decision: 'allow' });
    a.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    b.record({ tool: 'gh', decision: 'allow' });
    b.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    b.record({ tool: 'gh', decision: 'deny', rule: 'r2' });
    await a.flush();
    await b.flush();
    expect(await store.getMetricsSnapshot('gh')).toMatchObject({ total: 5, allow: 2, deny: 3, rule_denies: { r1: 2, r2: 1 } });
    // UI view: each replica adopts the cluster totals as of its own flush.
    expect(a.get('gh')).toMatchObject({ total: 2, allow: 1, deny: 1, rule_denies: { r1: 1 } });
    expect(b.get('gh')).toMatchObject({ total: 5, allow: 2, deny: 3, rule_denies: { r1: 2, r2: 1 } });
    // A later flush from a brings it up to date and adds its new call exactly once.
    a.record({ tool: 'gh', decision: 'allow' });
    await a.flush();
    expect(a.get('gh')).toMatchObject({ total: 6, allow: 3, deny: 3 });
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(6);
  });

  it('concurrent flushes from two replicas land exact totals in the store', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start(); await b.start();
    for (let i = 0; i < 4; i++) a.record({ tool: 'gh', decision: 'allow' });
    for (let i = 0; i < 3; i++) b.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    await Promise.all([a.flush(), b.flush()]);
    expect(await store.getMetricsSnapshot('gh')).toMatchObject({ total: 7, allow: 4, deny: 3, rule_denies: { r1: 3 } });
  });

  it('prometheus exports process-local counters, so replicas sum to the real count', async () => {
    const store = await SplicedockStore.open(':memory:');
    // Pre-existing cluster history: must not be re-exported by a fresh process.
    const old = new ToolMetrics(store, 0);
    await old.start();
    for (let i = 0; i < 10; i++) old.record({ tool: 'gh', decision: 'allow' });
    await old.flush();

    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start(); await b.start();
    expect(a.get('gh')!.total).toBe(10); // UI view is hydrated
    expect(a.prometheus()).toContain('splicedock_cli_calls_total{tool="gh",decision="allow"} 0');

    a.record({ tool: 'gh', decision: 'allow' });
    a.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    b.record({ tool: 'gh', decision: 'allow' });
    b.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    b.record({ tool: 'gh', decision: 'deny', rule: 'r2' });
    await a.flush();
    await b.flush();
    await a.flush();

    const pa = a.prometheus();
    const pb = b.prometheus();
    expect(pa).toContain('splicedock_cli_calls_total{tool="gh",decision="allow"} 1');
    expect(pa).toContain('splicedock_cli_calls_total{tool="gh",decision="deny"} 1');
    expect(pa).toContain('splicedock_cli_deny_total{tool="gh",rule="r1"} 1');
    expect(pa).not.toContain('rule="r2"');
    expect(pb).toContain('splicedock_cli_calls_total{tool="gh",decision="allow"} 1');
    expect(pb).toContain('splicedock_cli_calls_total{tool="gh",decision="deny"} 2');
    expect(pb).toContain('splicedock_cli_deny_total{tool="gh",rule="r1"} 1');
    expect(pb).toContain('splicedock_cli_deny_total{tool="gh",rule="r2"} 1');
    // Cluster view still shows the merged totals.
    expect(b.get('gh')).toMatchObject({ total: 15, allow: 12, deny: 3 });
  });

  it('flush only sends the increments since the last flush', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    m.record({ tool: 'gh', decision: 'allow' });
    await m.flush();
    await m.flush(); // nothing pending: must not double count
    m.record({ tool: 'gh', decision: 'allow' });
    await m.flush();
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(2);
  });

  it('keeps increments when a flush fails and retries them', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    m.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    const real = store.addMetricsDelta.bind(store);
    store.addMetricsDelta = async () => { throw new Error('db down'); };
    await expect(m.flush()).rejects.toThrow('db down');
    store.addMetricsDelta = real;
    await m.flush();
    expect(await store.getMetricsSnapshot('gh')).toMatchObject({ total: 1, deny: 1, rule_denies: { r1: 1 } });
  });

  it('last_ts never moves backwards across replicas', async () => {
    const store = await SplicedockStore.open(':memory:');
    const a = new ToolMetrics(store, 0);
    const b = new ToolMetrics(store, 0);
    await a.start(); await b.start();
    a.record({ tool: 'gh', decision: 'allow', ts: 2000, duration_ms: 20 });
    b.record({ tool: 'gh', decision: 'allow', ts: 1000, duration_ms: 10 });
    await a.flush();
    await b.flush();
    expect(await store.getMetricsSnapshot('gh')).toMatchObject({ total: 2, last_ts: 2000, last_duration_ms: 20 });
  });

  it('keeps last_duration_ms when a newer delta carries no duration', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    m.record({ tool: 'gh', decision: 'allow', ts: 1000, duration_ms: 42 });
    await m.flush();
    // Upsert directly: a delta whose last_ts is newer but has no duration.
    await store.addMetricsDelta({
      tool_name: 'gh', total: 1, allow: 0, deny: 1, rule_denies: {},
      buckets_60s: [], buckets_1h: [], last_ts: 2000, last_duration_ms: null,
    });
    expect(await store.getMetricsSnapshot('gh')).toMatchObject({ total: 2, last_ts: 2000, last_duration_ms: 42 });
  });
});

describe('ToolMetrics flush serialisation', () => {
  function gatedStore(store: SplicedockStore) {
    const real = store.addMetricsDelta.bind(store);
    const gates: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    const sent: number[] = [];
    store.addMetricsDelta = async (d) => {
      active++;
      maxActive = Math.max(maxActive, active);
      sent.push(d.total);
      await new Promise<void>(r => gates.push(r));
      try { return await real(d); } finally { active--; }
    };
    const releaseAll = async () => {
      while (gates.length > 0 || active > 0) {
        gates.splice(0).forEach(r => r());
        await new Promise(r => setTimeout(r, 0));
      }
    };
    return { gates, sent, releaseAll, maxActive: () => maxActive };
  }

  it('a flush called while one is in flight waits and then sends only new increments', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    const g = gatedStore(store);
    m.record({ tool: 'gh', decision: 'allow' });
    const first = m.flush();
    await new Promise(r => setTimeout(r, 0));
    m.record({ tool: 'gh', decision: 'allow' });
    m.record({ tool: 'gh', decision: 'allow' });
    const second = m.flush();
    await new Promise(r => setTimeout(r, 0));
    expect(g.sent).toEqual([1]); // second has not started yet
    await g.releaseAll();
    await Promise.all([first, second]);
    expect(g.maxActive()).toBe(1);
    expect(g.sent).toEqual([1, 2]);
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(3);
    // The newer result is the one the UI view keeps.
    expect(m.get('gh')!.total).toBe(3);
  });

  it('stop() during a slow interval flush waits for it and flushes the rest', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    const g = gatedStore(store);
    m.record({ tool: 'gh', decision: 'allow' });
    const tick = m.flush();
    await new Promise(r => setTimeout(r, 0));
    m.record({ tool: 'gh', decision: 'deny', rule: 'r1' });
    const stopped = m.stop();
    await g.releaseAll();
    await Promise.all([tick, stopped]);
    expect(g.maxActive()).toBe(1);
    expect(await store.getMetricsSnapshot('gh')).toMatchObject({ total: 2, allow: 1, deny: 1, rule_denies: { r1: 1 } });
  });

  it('a failed flush does not block the next one in the chain', async () => {
    const store = await SplicedockStore.open(':memory:');
    const m = new ToolMetrics(store, 0);
    await m.start();
    const real = store.addMetricsDelta.bind(store);
    let fail = true;
    store.addMetricsDelta = async (d) => {
      if (fail) { fail = false; throw new Error('db down'); }
      return await real(d);
    };
    m.record({ tool: 'gh', decision: 'allow' });
    const failed = m.flush();
    const next = m.flush();
    await expect(failed).rejects.toThrow('db down');
    await next;
    expect((await store.getMetricsSnapshot('gh'))!.total).toBe(1);
  });
});
