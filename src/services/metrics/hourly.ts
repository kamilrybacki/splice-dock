// Time-correct hourly call buckets.
//
// Semantics (the single source of truth for record / rotate / read / merge):
//   anchor — absolute hour index (epoch ms / 3_600_000) of buckets[23], the
//            newest bucket, i.e. the hour the window was last rolled to.
//   buckets[i] covers [anchor-(23-i), anchor-(22-i)) hours.
//   from   — first absolute hour whose count is trustworthy. Hours before it
//            are UNKNOWN (e.g. a legacy snapshot with no anchor), never zero.
//
// Windows are immutable values; every helper returns a new window.

export const HOURS = 24;
export const MS_PER_HOUR = 3_600_000;

export interface HourlyWindow {
  readonly buckets: readonly number[];
  readonly anchor: number;
  readonly from: number;
}

export function hourOf(ts: number): number {
  return Math.floor(ts / MS_PER_HOUR);
}

export function emptyWindow(anchor: number, from: number): HourlyWindow {
  return { buckets: new Array<number>(HOURS).fill(0), anchor, from };
}

/** Advance the window so buckets[23] is `hourNow`. Never moves backwards. */
export function rollWindow(w: HourlyWindow, hourNow: number): HourlyWindow {
  const shift = hourNow - w.anchor;
  if (shift <= 0) return w;
  const n = Math.min(shift, HOURS);
  return {
    buckets: [...w.buckets.slice(n), ...new Array<number>(n).fill(0)],
    anchor: hourNow,
    from: w.from,
  };
}

/** Count one call in the bucket of `hour`; calls older than the window are dropped. */
export function bumpWindow(w: HourlyWindow, hour: number): HourlyWindow {
  const rolled = rollWindow(w, hour);
  const idx = HOURS - 1 - (rolled.anchor - hour);
  if (idx < 0) return rolled;
  const buckets = rolled.buckets.slice();
  buckets[idx] = (buckets[idx] ?? 0) + 1;
  return { ...rolled, buckets };
}

/**
 * Combine two windows hour-by-hour. Counts are summed — the same rule the
 * totals use when replicas flush (each replica contributes its own calls).
 * An hour is known only if it is known in both operands, so `from` is the
 * later of the two.
 */
export function mergeWindows(a: HourlyWindow, b: HourlyWindow): HourlyWindow {
  const anchor = Math.max(a.anchor, b.anchor);
  const ra = rollWindow(a, anchor);
  const rb = rollWindow(b, anchor);
  return {
    buckets: ra.buckets.map((n, i) => n + (rb.buckets[i] ?? 0)),
    anchor,
    from: Math.max(a.from, b.from),
  };
}

/** Rebuild a window from persisted values; short arrays leave older hours unknown. */
export function windowFromRow(buckets: readonly number[], anchor: number, from: number): HourlyWindow {
  const clean = buckets.map((n) => (Number.isFinite(n) && n > 0 ? n : 0));
  const kept = clean.length > HOURS ? clean.slice(clean.length - HOURS) : clean;
  const padded = [...new Array<number>(HOURS - kept.length).fill(0), ...kept];
  const oldestKnown = anchor - (kept.length - 1);
  return { buckets: padded, anchor, from: Math.max(from, oldestKnown) };
}

export interface HourlyView {
  /** Counts per hour, oldest first, starting at the first known hour. */
  readonly buckets: number[];
  /** Absolute hour index of buckets[0]. */
  readonly startHour: number;
}

/** Roll to `hourNow` and drop the unknown leading hours. */
export function hourlyView(w: HourlyWindow, hourNow: number): HourlyView | null {
  const r = rollWindow(w, hourNow);
  const oldest = r.anchor - (HOURS - 1);
  const skip = Math.min(HOURS, Math.max(0, r.from - oldest));
  if (skip >= HOURS) return null;
  return { buckets: r.buckets.slice(skip) as number[], startHour: oldest + skip };
}
