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
//   buckets_1h  — 24 entries, one per hour, last day. Time semantics (and the
//                 cross-replica merge) live in ./hourly.ts: anchor = hour of
//                 index 23 (the current, in-progress hour).
//
// Each bucket holds the count of calls landing in that interval. We don't
// store per-decision per-bucket counts — that's a 6× memory blowup for
// modest UX gain. The WebUI shows total calls per bucket + a separate
// rule-deny breakdown bar from the all-time totals.

import type { MetricsDelta, MetricsRepository } from '../../contracts/outbound/repositories.js';
import { logger } from '../../common/logger.js';
import {
  HOURS, MS_PER_HOUR, bumpWindow, emptyWindow, hourOf, hourlyView, mergeWindows, rollWindow, windowFromRow,
  type HourlyWindow,
} from './hourly.js';

const MINUTES_BUCKETS = 60;
const HOURS_BUCKETS = HOURS;
const MS_PER_MINUTE = 60_000;

export interface ToolMetric {
  tool: string;
  total: number;
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
  last_ts: number | null;
  last_duration_ms: number | null;
  buckets_60s: number[];   // length 60, oldest first after rollForward()
  buckets_1h: number[];    // length 24, oldest first after rollForward()
  bucket_60s_anchor: number;  // minute index at index 0
  bucket_1h_anchor: number;   // absolute hour index of buckets_1h[23] (the current hour)
  bucket_1h_from: number;     // first absolute hour whose count is known; earlier hours are unknown, not zero
}

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

function freshMetric(tool: string, now: number, from: number): ToolMetric {
  return {
    tool,
    total: 0,
    allow: 0,
    deny: 0,
    rule_denies: {},
    last_ts: null,
    last_duration_ms: null,
    buckets_60s: new Array(MINUTES_BUCKETS).fill(0),
    buckets_1h: new Array(HOURS_BUCKETS).fill(0),
    bucket_60s_anchor: Math.floor(now / MS_PER_MINUTE),
    bucket_1h_anchor: hourOf(now),
    bucket_1h_from: from,
  };
}

function windowOf(m: ToolMetric): HourlyWindow {
  return { buckets: m.buckets_1h, anchor: m.bucket_1h_anchor, from: m.bucket_1h_from };
}

function applyWindow(m: ToolMetric, w: HourlyWindow): void {
  m.buckets_1h = [...w.buckets];
  m.bucket_1h_anchor = w.anchor;
  m.bucket_1h_from = w.from;
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
  // Flushes run one at a time (interval tick vs slow flush vs stop()); a
  // concurrent flush() chains behind the one in flight.
  private flushChain: Promise<void> = Promise.resolve();
  // Without a store nothing predates this process, so hours before it started are unknown.
  private readonly startHour = hourOf(Date.now());

  constructor(
    private readonly store: MetricsRepository | null = null,
    private readonly flushIntervalMs = 30_000,
  ) {}

  /** Hydrate counters from the DB and start the periodic snapshot writer. */
  async start(): Promise<void> {
    if (this.store) {
      const now = Date.now();
      for (const row of await this.store.listMetricsSnapshots()) {
        const m = freshMetric(row.tool_name, now, hourOf(now));
        m.total = row.total;
        m.allow = row.allow;
        m.deny = row.deny;
        m.rule_denies = row.rule_denies;
        m.last_ts = row.last_ts;
        m.last_duration_ms = row.last_duration_ms;
        m.buckets_60s = padToLength(row.buckets_60s, MINUTES_BUCKETS);
        // Hourly buckets are anchored in absolute time: shift them by the hours
        // that passed since the persisted anchor (downtime = zero calls). A legacy
        // row without an anchor cannot be placed in time, so its history is unknown.
        const anchor = row.buckets_1h_anchor;
        applyWindow(m, anchor == null
          ? emptyWindow(hourOf(now), hourOf(now))
          : rollWindow(windowFromRow(row.buckets_1h, anchor, row.buckets_1h_from ?? anchor), hourOf(now)));
        this.metrics.set(row.tool_name, m);
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
    const m = this.metrics.get(args.tool)
      ?? freshMetric(args.tool, ts, this.store ? hour - (HOURS - 1) : this.startHour);
    rollForward(m, ts);
    m.total += 1;
    if (args.decision === 'allow') m.allow += 1; else m.deny += 1;
    if (args.decision === 'deny' && args.rule) {
      m.rule_denies[args.rule] = (m.rule_denies[args.rule] ?? 0) + 1;
    }
    m.last_ts = ts;
    if (args.duration_ms !== undefined) m.last_duration_ms = args.duration_ms;
    m.buckets_60s[MINUTES_BUCKETS - 1] += 1;
    applyWindow(m, bumpWindow(windowOf(m), hour));
    this.metrics.set(args.tool, m);
    const p = this.pending.get(args.tool) ?? emptyPending(hour);
    p.hourly = bumpWindow(p.hourly, hour);
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

  /**
   * Hourly call history summed over all tools, oldest first, current hour last.
   * Hours that are not known (legacy snapshots, hours before this process or the
   * tool existed) are cut off rather than shown as zeros; null when nothing is known.
   */
  hourlyHistory(now = Date.now()): HourlyHistoryView | null {
    const hourNow = hourOf(now);
    let sum: number[] = new Array<number>(HOURS).fill(0);
    let from = -Infinity;
    let any = false;
    for (const m of this.metrics.values()) {
      const w = rollWindow(windowOf(m), hourNow);
      sum = sum.map((n, i) => n + (w.buckets[i] ?? 0));
      from = Math.max(from, w.from);
      any = true;
    }
    if (!any) return null;
    const view = hourlyView({ buckets: sum, anchor: hourNow, from }, hourNow);
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
   * Delivery is at-least-once: if the upsert commits but the client then sees
   * an error (dropped connection before the COMMIT reply), the increments are
   * kept and re-sent on the next flush, so they can be counted twice. That is
   * accepted for usage metrics; there are no idempotency tokens.
   */
  flush(): Promise<void> {
    const run = this.flushChain.catch(() => undefined).then(() => this.flushOnce());
    this.flushChain = run;
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (!this.store || this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    let firstError: unknown;
    for (const [tool, p] of batch) {
      const m = this.metrics.get(tool);
      if (!m) continue;
      const delta: MetricsDelta = {
        tool_name: tool,
        total: p.total, allow: p.allow, deny: p.deny,
        rule_denies: p.rule_denies,
        buckets_60s: m.buckets_60s, buckets_1h: [...p.hourly.buckets],
        buckets_1h_anchor: p.hourly.anchor, buckets_1h_from: p.hourly.from,
        last_ts: p.last_ts, last_duration_ms: p.last_duration_ms,
      };
      try {
        const row = await this.store.addMetricsDelta(delta);
        // Adopt cluster-wide totals (other replicas' counts) plus anything recorded mid-flush.
        const extra = this.pending.get(tool) ?? emptyPending(hourOf(Date.now()));
        m.total = row.total + extra.total;
        m.allow = row.allow + extra.allow;
        m.deny = row.deny + extra.deny;
        m.rule_denies = { ...row.rule_denies };
        for (const [r, n] of Object.entries(extra.rule_denies)) m.rule_denies[r] = (m.rule_denies[r] ?? 0) + n;
        const rowAnchor = row.buckets_1h_anchor ?? extra.hourly.anchor;
        applyWindow(m, mergeWindows(
          windowFromRow(row.buckets_1h, rowAnchor, row.buckets_1h_from ?? rowAnchor), extra.hourly));
      } catch (err) {
        // Not persisted: keep the increments for the next flush.
        const cur = this.pending.get(tool) ?? emptyPending(p.hourly.anchor);
        cur.hourly = mergeWindows(cur.hourly, p.hourly);
        cur.total += p.total; cur.allow += p.allow; cur.deny += p.deny;
        for (const [r, n] of Object.entries(p.rule_denies)) cur.rule_denies[r] = (cur.rule_denies[r] ?? 0) + n;
        cur.last_ts = cur.last_ts ?? p.last_ts;
        cur.last_duration_ms = cur.last_duration_ms ?? p.last_duration_ms;
        this.pending.set(tool, cur);
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}

interface LocalCounters {
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
}

interface PendingDelta {
  total: number;
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
  last_ts: number | null;
  last_duration_ms: number | null;
  /** This process's own hourly increments; every hour is known (zero = no calls). */
  hourly: HourlyWindow;
}

function emptyPending(hour: number): PendingDelta {
  return {
    total: 0, allow: 0, deny: 0, rule_denies: {}, last_ts: null, last_duration_ms: null,
    hourly: emptyWindow(hour, hour - (HOURS - 1)),
  };
}

/** Advance the per-minute bucket window to "now", filling any intervening
 *  slots with zeros, and roll the hourly window to the current hour. */
function rollForward(m: ToolMetric, now: number): void {
  const minuteNow = Math.floor(now / MS_PER_MINUTE);
  const minuteShift = Math.min(MINUTES_BUCKETS, Math.max(0, minuteNow - m.bucket_60s_anchor - (MINUTES_BUCKETS - 1)));
  applyWindow(m, rollWindow(windowOf(m), hourOf(now)));
  if (minuteShift > 0) {
    m.buckets_60s.splice(0, minuteShift);
    for (let i = 0; i < minuteShift; i++) m.buckets_60s.push(0);
    m.bucket_60s_anchor += minuteShift;
  }
}

function padToLength(arr: number[], len: number): number[] {
  if (arr.length === len) return arr;
  if (arr.length > len) return arr.slice(arr.length - len);
  const out = new Array(len - arr.length).fill(0).concat(arr);
  return out;
}
