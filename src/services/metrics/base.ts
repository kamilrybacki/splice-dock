// Per-tool usage metrics for the WebUI + Prometheus exposition.
//
// Counters are accumulated in-memory on every cli_passthrough __run dispatch.
// A periodic flush adds this process's increments to the shared DB row, so the
// dashboard shows cluster-wide numbers that survive a pod restart.
//
// Two views of the counts:
//   metrics (get/list)  — cluster-wide totals adopted from the DB after each
//                         flush; for the WebUI / API.
//   local (localCounters) — this process's own monotonic counters since start.
//                         Every replica is scraped separately and Prometheus
//                         sums the series; exporting cluster totals would make
//                         N replicas report N× the real count.
//
// Two bucket arrays power sparklines:
//   buckets_60s — 60 entries, one per minute, last hour
//   buckets_1h  — 24 entries, one per hour, last day.
// Both are time-correct windows (./window.ts, bound in ./minutes.ts and
// ./hourly.ts): anchor = absolute minute / hour of the newest index (the
// current, in-progress one), `from` = first trustworthy unit (earlier units are
// unknown, not zero). Each replica flushes its own per-window increments and the
// DB sums them by absolute minute / hour, so replicas never overwrite each other.
//
// Each bucket holds the count of calls landing in that interval. We don't
// store per-decision per-bucket counts — that's a 6× memory blowup for
// modest UX gain. The WebUI shows total calls per bucket + a separate
// rule-deny breakdown bar from the all-time totals.

import { randomUUID } from 'node:crypto';
import type { MetricsDelta, MetricsRepository, MetricsSnapshotRow } from '../../contracts/outbound/repositories.js';
import { logger } from '../../common/logger.js';
import {
  HOURS, MS_PER_HOUR, bumpWindow, emptyWindow, hourOf, hourlyView, mergeWindows, windowFromRow,
} from './hourly.js';
import { MINUTES, minuteOf, minutesFromRow } from './minutes.js';
import {
  applyHourly, applyMinutes, emptyPending, freshMetric, hourlyOf, metricFromRow, minutesOf, rollForward,
  type KnownFrom, type PendingDelta, type ToolMetric,
} from './metric-state.js';

export type { ToolMetric } from './metric-state.js';

/** Aggregated hourly call history, oldest bucket first. */
export interface HourlyHistoryView {
  readonly buckets: number[];
  /** Epoch ms of the start of buckets[0]. */
  readonly startTs: number;
  /** The last bucket is the current, still-running hour. */
  readonly lastInProgress: boolean;
}

/** Process-local counters of one tool, as handed to exposition adapters. */
export interface ToolLocalCounters {
  readonly tool: string;
  readonly allow: number;
  readonly deny: number;
  readonly rule_denies: Readonly<Record<string, number>>;
  readonly last_duration_ms: number | null;
}

export class ToolMetrics {
  private metrics = new Map<string, ToolMetric>();
  private flushHandle: NodeJS.Timeout | null = null;
  // Increments since the last successful flush, per tool. Flushed as deltas so
  // replicas sharing one DB add to each other's counts instead of overwriting them.
  private pending = new Map<string, PendingDelta>();
  // Process-local counters for the Prometheus exposition. Never hydrated or
  // overwritten from the DB, so they only ever increase.
  private local = new Map<string, LocalCounters>();
  // Deltas sent (or about to be) but not yet acknowledged by the store, per tool.
  // Re-sent unchanged, with the same seq, until acknowledged.
  private unacked = new Map<string, MetricsDelta>();
  private seqs = new Map<string, number>();
  // Identifies this process in the store's applied-seq bookkeeping.
  private readonly replicaId = randomUUID();
  // Flushes run one at a time (interval tick vs slow flush vs stop()); a
  // concurrent flush() chains behind the one in flight.
  private flushChain: Promise<void> = Promise.resolve();
  // Without a store nothing predates this process, so earlier units are unknown.
  private readonly startedAt = Date.now();

  constructor(
    private readonly store: MetricsRepository | null = null,
    private readonly flushIntervalMs = 30_000,
  ) {}

  /** Hydrate counters from the DB and start the periodic snapshot writer. */
  async start(): Promise<void> {
    if (this.store) {
      const now = Date.now();
      for (const row of await this.store.listMetricsSnapshots()) {
        this.metrics.set(row.tool_name, metricFromRow(row, now));
      }
    }
    if (this.flushIntervalMs > 0 && this.store) {
      this.flushHandle = setInterval(() => {
        this.flush().catch(err => logger.warn('tool metrics flush failed', { err: String(err) }));
      }, this.flushIntervalMs);
      // Don't keep the event loop alive just for this.
      this.flushHandle.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.flushHandle) {
      clearInterval(this.flushHandle);
      this.flushHandle = null;
    }
    await this.flush();
  }

  /** Record a single dispatch outcome. */
  record(args: {
    tool: string;
    decision: 'allow' | 'deny';
    rule?: string;
    duration_ms?: number;
    ts?: number;
  }): void {
    const ts = args.ts ?? Date.now();
    const hour = hourOf(ts);
    const minute = minuteOf(ts);
    const m = this.metrics.get(args.tool) ?? freshMetric(args.tool, ts, this.knownFrom(ts));
    rollForward(m, ts);
    m.total += 1;
    if (args.decision === 'allow') m.allow += 1; else m.deny += 1;
    if (args.decision === 'deny' && args.rule) {
      m.rule_denies[args.rule] = (m.rule_denies[args.rule] ?? 0) + 1;
    }
    m.last_ts = ts;
    if (args.duration_ms !== undefined) m.last_duration_ms = args.duration_ms;
    applyHourly(m, bumpWindow(hourlyOf(m), hour));
    applyMinutes(m, bumpWindow(minutesOf(m), minute));
    this.metrics.set(args.tool, m);
    const p = this.pending.get(args.tool) ?? emptyPending(ts);
    p.hourly = bumpWindow(p.hourly, hour);
    p.minutes = bumpWindow(p.minutes, minute);
    p.total += 1;
    if (args.decision === 'allow') p.allow += 1; else p.deny += 1;
    if (args.decision === 'deny' && args.rule) p.rule_denies[args.rule] = (p.rule_denies[args.rule] ?? 0) + 1;
    p.last_ts = ts;
    if (args.duration_ms !== undefined) p.last_duration_ms = args.duration_ms;
    this.pending.set(args.tool, p);
    const l = this.local.get(args.tool) ?? { allow: 0, deny: 0, rule_denies: {} };
    if (args.decision === 'allow') l.allow += 1; else l.deny += 1;
    if (args.decision === 'deny' && args.rule) l.rule_denies[args.rule] = (l.rule_denies[args.rule] ?? 0) + 1;
    this.local.set(args.tool, l);
  }

  /** First hour / minute from which a tool first seen at `ts` has known counts. */
  private knownFrom(ts: number): KnownFrom {
    if (this.store) return { hour: hourOf(ts) - (HOURS - 1), minute: minuteOf(ts) - (MINUTES - 1) };
    return { hour: hourOf(this.startedAt), minute: minuteOf(this.startedAt) };
  }

  /**
   * Hourly call history summed over all tools, oldest first, current hour last.
   * Hours that are not known (legacy snapshots, hours before this process or the
   * tool existed) are cut off rather than shown as zeros; null when nothing is known.
   */
  hourlyHistory(now = Date.now()): HourlyHistoryView | null {
    const hourNow = hourOf(now);
    if (this.metrics.size === 0) return null;
    // mergeWindows aligns by absolute hour, so a window anchored ahead of this
    // clock (another replica's skew) is not summed into the wrong buckets.
    let merged = emptyWindow(hourNow, -Infinity);
    for (const m of this.metrics.values()) merged = mergeWindows(merged, hourlyOf(m));
    const view = hourlyView(merged, hourNow);
    if (!view) return null;
    return { buckets: view.buckets, startTs: view.startHour * MS_PER_HOUR, lastInProgress: true };
  }

  get(tool: string): ToolMetric | null {
    const m = this.metrics.get(tool);
    if (!m) return null;
    rollForward(m, Date.now());
    return m;
  }

  list(): ToolMetric[] {
    const now = Date.now();
    const out: ToolMetric[] = [];
    for (const m of this.metrics.values()) {
      rollForward(m, now);
      out.push(m);
    }
    return out.sort((a, b) => a.tool.localeCompare(b.tool));
  }

  /** This process's own monotonic counters, one entry per known tool (see header),
   *  for exposition adapters. Never reflects cluster-wide DB totals. */
  localCounters(): readonly ToolLocalCounters[] {
    return this.list().map(m => {
      const l = this.local.get(m.tool) ?? { allow: 0, deny: 0, rule_denies: {} };
      return { tool: m.tool, allow: l.allow, deny: l.deny, rule_denies: { ...l.rule_denies }, last_duration_ms: m.last_duration_ms };
    });
  }

  /**
   * Add this replica's unflushed increments to the DB, then adopt the merged
   * totals for the UI view. Serialised: a call made while a flush is in flight
   * waits for it and then flushes whatever was recorded meanwhile, so an older
   * result can never overwrite a newer one.
   *
   * Delivery is idempotent. Every delta carries (replica_id, seq) with seq
   * increasing per tool, and the store applies it only if seq is above the last
   * one it applied for that pair. A delta stays in `unacked` until the store
   * answers: if the upsert committed but the client saw an error (dropped
   * connection before the COMMIT reply), the very same delta is re-sent first on
   * the next flush and the store recognises it instead of counting it twice.
   * Newer increments get a new seq and are never folded into an unacked delta.
   */
  flush(): Promise<void> {
    const run = this.flushChain.catch(() => undefined).then(() => this.flushOnce());
    this.flushChain = run;
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (!this.store) return;
    let firstError: unknown;
    for (const tool of new Set([...this.unacked.keys(), ...this.pending.keys()])) {
      try {
        await this.flushTool(this.store, tool);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Send a tool's unacked delta (if any), then its pending increments. */
  private async flushTool(store: MetricsRepository, tool: string): Promise<void> {
    let row: MetricsSnapshotRow | null = null;
    const retry = this.unacked.get(tool);
    if (retry) {
      row = await store.addMetricsDelta(retry);
      this.unacked.delete(tool);
    }
    const p = this.pending.get(tool);
    if (p) {
      this.pending.delete(tool);
      const seq = (this.seqs.get(tool) ?? 0) + 1;
      this.seqs.set(tool, seq);
      const delta = this.toDelta(tool, p, seq);
      this.unacked.set(tool, delta);
      row = await store.addMetricsDelta(delta);
      this.unacked.delete(tool);
    }
    const m = this.metrics.get(tool);
    // Adopt cluster-wide totals (other replicas' counts) plus anything recorded mid-flush.
    if (row && m) adoptRow(m, row, this.pending.get(tool) ?? emptyPending(Date.now()));
  }

  private toDelta(tool: string, p: PendingDelta, seq: number): MetricsDelta {
    return {
      tool_name: tool,
      total: p.total, allow: p.allow, deny: p.deny,
      rule_denies: { ...p.rule_denies },
      buckets_60s: [...p.minutes.buckets], buckets_60s_anchor: p.minutes.anchor, buckets_60s_from: p.minutes.from,
      buckets_1h: [...p.hourly.buckets],
      buckets_1h_anchor: p.hourly.anchor, buckets_1h_from: p.hourly.from,
      last_ts: p.last_ts, last_duration_ms: p.last_duration_ms,
      replica_id: this.replicaId, seq,
    };
  }
}

/** Replace a metric's cluster-wide view with the DB row plus increments not yet sent. */
function adoptRow(m: ToolMetric, row: MetricsSnapshotRow, extra: PendingDelta): void {
  m.total = row.total + extra.total;
  m.allow = row.allow + extra.allow;
  m.deny = row.deny + extra.deny;
  m.rule_denies = { ...row.rule_denies };
  for (const [r, n] of Object.entries(extra.rule_denies)) m.rule_denies[r] = (m.rule_denies[r] ?? 0) + n;
  const rowAnchor = row.buckets_1h_anchor ?? extra.hourly.anchor;
  applyHourly(m, mergeWindows(
    windowFromRow(row.buckets_1h, rowAnchor, row.buckets_1h_from ?? rowAnchor), extra.hourly));
  const rowMinute = row.buckets_60s_anchor ?? extra.minutes.anchor;
  applyMinutes(m, mergeWindows(
    minutesFromRow(row.buckets_60s, rowMinute, row.buckets_60s_from ?? rowMinute), extra.minutes));
}

interface LocalCounters {
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
}
