// In-memory state of one tool's metrics, plus the not-yet-flushed increments.
// Pure helpers used by ToolMetrics (base.ts); no I/O.

import type { MetricsSnapshotRow } from '../../contracts/outbound/repositories.js';
import {
  HOURS, emptyWindow, hourOf, rollWindow, windowFromRow, type HourlyWindow,
} from './hourly.js';
import { MINUTES, emptyMinutes, minuteOf, minutesFromRow, type MinuteWindow } from './minutes.js';

export interface ToolMetric {
  tool: string;
  total: number;
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
  last_ts: number | null;
  last_duration_ms: number | null;
  buckets_60s: number[];      // length 60, oldest first after rollForward()
  buckets_1h: number[];       // length 24, oldest first after rollForward()
  bucket_60s_anchor: number;  // absolute minute index of buckets_60s[59] (the current minute)
  bucket_60s_from: number;    // first absolute minute whose count is known; earlier minutes are unknown, not zero
  bucket_1h_anchor: number;   // absolute hour index of buckets_1h[23] (the current hour)
  bucket_1h_from: number;     // first absolute hour whose count is known; earlier hours are unknown, not zero
}

/** Increments since the last successful flush of one tool. */
export interface PendingDelta {
  total: number;
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
  last_ts: number | null;
  last_duration_ms: number | null;
  /** This process's own increments; every unit is known (zero = no calls). */
  hourly: HourlyWindow;
  minutes: MinuteWindow;
}

/** First hour / minute from which a new tool's counts are known. */
export interface KnownFrom {
  readonly hour: number;
  readonly minute: number;
}

export function freshMetric(tool: string, now: number, from: KnownFrom): ToolMetric {
  return {
    tool,
    total: 0,
    allow: 0,
    deny: 0,
    rule_denies: {},
    last_ts: null,
    last_duration_ms: null,
    buckets_60s: new Array<number>(MINUTES).fill(0),
    buckets_1h: new Array<number>(HOURS).fill(0),
    bucket_60s_anchor: minuteOf(now),
    bucket_60s_from: from.minute,
    bucket_1h_anchor: hourOf(now),
    bucket_1h_from: from.hour,
  };
}

/** A tool that exists in the DB: everything earlier than what the row proves is unknown. */
export function metricFromRow(row: MetricsSnapshotRow, now: number): ToolMetric {
  const hour = hourOf(now);
  const minute = minuteOf(now);
  const m = freshMetric(row.tool_name, now, { hour, minute });
  m.total = row.total;
  m.allow = row.allow;
  m.deny = row.deny;
  m.rule_denies = { ...row.rule_denies };
  m.last_ts = row.last_ts;
  m.last_duration_ms = row.last_duration_ms;
  // Windows are anchored in absolute time: shift them by the units that passed since
  // the persisted anchor (downtime = zero calls). A legacy row without an anchor
  // cannot be placed in time, so its history is unknown.
  const h = row.buckets_1h_anchor;
  applyHourly(m, h == null
    ? emptyWindow(hour, hour)
    : rollWindow(windowFromRow(row.buckets_1h, h, row.buckets_1h_from ?? h), hour));
  const mi = row.buckets_60s_anchor;
  applyMinutes(m, mi == null
    ? emptyMinutes(minute, minute)
    : rollWindow(minutesFromRow(row.buckets_60s, mi, row.buckets_60s_from ?? mi), minute));
  return m;
}

export function hourlyOf(m: ToolMetric): HourlyWindow {
  return { buckets: m.buckets_1h, anchor: m.bucket_1h_anchor, from: m.bucket_1h_from };
}

export function minutesOf(m: ToolMetric): MinuteWindow {
  return { buckets: m.buckets_60s, anchor: m.bucket_60s_anchor, from: m.bucket_60s_from };
}

export function applyHourly(m: ToolMetric, w: HourlyWindow): void {
  m.buckets_1h = [...w.buckets];
  m.bucket_1h_anchor = w.anchor;
  m.bucket_1h_from = w.from;
}

export function applyMinutes(m: ToolMetric, w: MinuteWindow): void {
  m.buckets_60s = [...w.buckets];
  m.bucket_60s_anchor = w.anchor;
  m.bucket_60s_from = w.from;
}

export function emptyPending(now: number): PendingDelta {
  const hour = hourOf(now);
  const minute = minuteOf(now);
  return {
    total: 0, allow: 0, deny: 0, rule_denies: {}, last_ts: null, last_duration_ms: null,
    hourly: emptyWindow(hour, hour - (HOURS - 1)),
    minutes: emptyMinutes(minute, minute - (MINUTES - 1)),
  };
}

/** Roll both windows to "now", filling any intervening units with zeros. */
export function rollForward(m: ToolMetric, now: number): void {
  applyHourly(m, rollWindow(hourlyOf(m), hourOf(now)));
  applyMinutes(m, rollWindow(minutesOf(m), minuteOf(now)));
}
