// metrics_snapshots persistence: row reads and the cross-replica delta merge.
// Kept apart from store.ts; SplicedockStore delegates its MetricsRepository
// methods here. Time semantics of the bucket windows live in ../../metrics/window.ts.

import type { MetricsDelta, MetricsSnapshotRow } from '../../../contracts/outbound/repositories.js';
import type { SqlDb } from '../base.js';
import { HOURS, hourOf } from '../../metrics/hourly.js';
import { MINUTES, minuteOf } from '../../metrics/minutes.js';
import { mergeStored } from '../../metrics/window.js';

interface RawMetricsRow {
  tool_name: string;
  total: number;
  allow: number;
  deny: number;
  rule_denies_json: string | null;
  buckets_60s_json: string | null;
  buckets_60s_anchor: number | null;
  buckets_60s_from: number | null;
  buckets_1h_json: string | null;
  buckets_1h_anchor: number | null;
  buckets_1h_from: number | null;
  last_ts: number | null;
  last_duration_ms: number | null;
  updated_at: number;
}

export async function readMetricsRow(db: SqlDb, tool: string): Promise<MetricsSnapshotRow | null> {
  const row = await db
    .prepare(
      `SELECT tool_name, total, allow, deny, rule_denies_json,
              buckets_60s_json, buckets_60s_anchor, buckets_60s_from,
              buckets_1h_json, buckets_1h_anchor, buckets_1h_from,
              last_ts, last_duration_ms, updated_at
       FROM metrics_snapshots WHERE tool_name = ?`,
    )
    .get(tool) as RawMetricsRow | undefined;
  if (!row) return null;
  return {
    tool_name: row.tool_name,
    total: row.total,
    allow: row.allow,
    deny: row.deny,
    rule_denies: row.rule_denies_json ? safeParseObj(row.rule_denies_json) : {},
    buckets_60s: row.buckets_60s_json ? safeParseArr(row.buckets_60s_json) : [],
    buckets_60s_anchor: row.buckets_60s_anchor ?? null,
    buckets_60s_from: row.buckets_60s_from ?? null,
    buckets_1h: row.buckets_1h_json ? safeParseArr(row.buckets_1h_json) : [],
    buckets_1h_anchor: row.buckets_1h_anchor ?? null,
    buckets_1h_from: row.buckets_1h_from ?? null,
    last_ts: row.last_ts,
    last_duration_ms: row.last_duration_ms,
    updated_at: row.updated_at,
  };
}

export async function listMetricsRows(db: SqlDb): Promise<MetricsSnapshotRow[]> {
  const tools = await db
    .prepare('SELECT tool_name FROM metrics_snapshots ORDER BY tool_name')
    .all() as Array<{ tool_name: string }>;
  const rows: MetricsSnapshotRow[] = [];
  for (const t of tools) {
    const row = await readMetricsRow(db, t.tool_name);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * Add one replica's counter increments to the shared row without losing a
 * concurrent replica's. Counters use `col = col + excluded.col` (atomic on
 * both backends); rule_denies and both bucket windows are merged under the row
 * lock the upsert takes for the rest of the transaction. Windows are aligned by
 * absolute hour / minute and summed (see mergeWindows: same rule as the totals).
 * Returns the merged row.
 */
export async function applyMetricsDelta(db: SqlDb, d: MetricsDelta): Promise<MetricsSnapshotRow> {
  return await db.transaction(async () => {
    await db.prepare(
      `INSERT INTO metrics_snapshots (
          tool_name, total, allow, deny, rule_denies_json,
          buckets_60s_json, buckets_1h_json, last_ts, last_duration_ms, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_name) DO UPDATE SET
         total            = metrics_snapshots.total + excluded.total,
         allow            = metrics_snapshots.allow + excluded.allow,
         deny             = metrics_snapshots.deny + excluded.deny,
         last_duration_ms = CASE WHEN excluded.last_ts IS NOT NULL
           AND (metrics_snapshots.last_ts IS NULL OR excluded.last_ts >= metrics_snapshots.last_ts)
           THEN COALESCE(excluded.last_duration_ms, metrics_snapshots.last_duration_ms)
           ELSE metrics_snapshots.last_duration_ms END,
         last_ts          = CASE WHEN excluded.last_ts IS NOT NULL
           AND (metrics_snapshots.last_ts IS NULL OR excluded.last_ts >= metrics_snapshots.last_ts)
           THEN excluded.last_ts ELSE metrics_snapshots.last_ts END,
         updated_at       = excluded.updated_at`,
    ).run(
      // '[]' + NULL anchor marks a window created by this very delta (legacy rows hold entries).
      d.tool_name, d.total, d.allow, d.deny, '{}', '[]', '[]',
      d.last_ts, d.last_duration_ms, Date.now(),
    );
    // The upsert holds the row lock until commit, so this read-merge-write is serialised.
    const cur = await readMetricsRow(db, d.tool_name) as MetricsSnapshotRow;
    const rule_denies = { ...cur.rule_denies };
    for (const [rule, n] of Object.entries(d.rule_denies)) rule_denies[rule] = (rule_denies[rule] ?? 0) + n;
    const now = Date.now();
    const hourly = mergeStored(
      HOURS, hourOf(now),
      { buckets: cur.buckets_1h, anchor: cur.buckets_1h_anchor, from: cur.buckets_1h_from },
      { buckets: d.buckets_1h, anchor: d.buckets_1h_anchor, from: d.buckets_1h_from },
      cur.buckets_1h.length === 0 && cur.buckets_1h_anchor == null,
    );
    const minutes = mergeStored(
      MINUTES, minuteOf(now),
      { buckets: cur.buckets_60s, anchor: cur.buckets_60s_anchor, from: cur.buckets_60s_from },
      { buckets: d.buckets_60s, anchor: d.buckets_60s_anchor, from: d.buckets_60s_from },
      cur.buckets_60s.length === 0 && cur.buckets_60s_anchor == null,
    );
    await db.prepare(
      `UPDATE metrics_snapshots SET rule_denies_json = ?,
         buckets_1h_json = ?, buckets_1h_anchor = ?, buckets_1h_from = ?,
         buckets_60s_json = ?, buckets_60s_anchor = ?, buckets_60s_from = ?
       WHERE tool_name = ?`,
    ).run(
      JSON.stringify(rule_denies),
      JSON.stringify(hourly.buckets), hourly.anchor, hourly.from,
      JSON.stringify(minutes.buckets), minutes.anchor, minutes.from,
      d.tool_name,
    );
    return {
      ...cur, rule_denies,
      buckets_1h: [...hourly.buckets], buckets_1h_anchor: hourly.anchor, buckets_1h_from: hourly.from,
      buckets_60s: [...minutes.buckets], buckets_60s_anchor: minutes.anchor, buckets_60s_from: minutes.from,
    };
  })();
}

export async function upsertMetricsRow(db: SqlDb, s: Omit<MetricsSnapshotRow, 'updated_at'>): Promise<void> {
  await db
    .prepare(
      `INSERT INTO metrics_snapshots (
          tool_name, total, allow, deny, rule_denies_json,
          buckets_60s_json, buckets_60s_anchor, buckets_60s_from,
          buckets_1h_json, buckets_1h_anchor, buckets_1h_from,
          last_ts, last_duration_ms, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_name) DO UPDATE SET
         total              = excluded.total,
         allow              = excluded.allow,
         deny               = excluded.deny,
         rule_denies_json   = excluded.rule_denies_json,
         buckets_60s_json   = excluded.buckets_60s_json,
         buckets_60s_anchor = excluded.buckets_60s_anchor,
         buckets_60s_from   = excluded.buckets_60s_from,
         buckets_1h_json    = excluded.buckets_1h_json,
         buckets_1h_anchor  = excluded.buckets_1h_anchor,
         buckets_1h_from    = excluded.buckets_1h_from,
         last_ts            = excluded.last_ts,
         last_duration_ms   = excluded.last_duration_ms,
         updated_at         = excluded.updated_at`,
    )
    .run(
      s.tool_name, s.total, s.allow, s.deny, JSON.stringify(s.rule_denies),
      JSON.stringify(s.buckets_60s), s.buckets_60s_anchor ?? null, s.buckets_60s_from ?? null,
      JSON.stringify(s.buckets_1h), s.buckets_1h_anchor ?? null, s.buckets_1h_from ?? null,
      s.last_ts, s.last_duration_ms, Date.now(),
    );
}

function safeParseObj(s: string): Record<string, number> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function safeParseArr(s: string): number[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as number[]) : [];
  } catch {
    return [];
  }
}
