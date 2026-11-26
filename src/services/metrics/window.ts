// Time-correct bucket windows, generic over the window size (24 hours, 60 minutes).
//
// Semantics (the single source of truth for record / rotate / read / merge):
//   anchor — absolute unit index (epoch ms / unit ms) of the newest bucket,
//            i.e. the unit the window was last rolled to.
//   buckets[i] covers unit anchor-(size-1-i).
//   from   — first absolute unit whose count is trustworthy. Units before it
//            are UNKNOWN (e.g. a legacy snapshot with no anchor), never zero.
//
// The window size is the length of `buckets`. Windows are immutable values;
// every helper returns a new window. hourly.ts / minutes.ts bind a size.

export interface TimeWindow {
  readonly buckets: readonly number[];
  readonly anchor: number;
  readonly from: number;
}

export function emptyTimeWindow(size: number, anchor: number, from: number): TimeWindow {
  return { buckets: new Array<number>(size).fill(0), anchor, from };
}

/** Advance the window so its newest bucket is `unitNow`. Never moves backwards. */
export function rollWindow(w: TimeWindow, unitNow: number): TimeWindow {
  const size = w.buckets.length;
  const shift = unitNow - w.anchor;
  if (shift <= 0) return w;
  const n = Math.min(shift, size);
  return {
    buckets: [...w.buckets.slice(n), ...new Array<number>(n).fill(0)],
    anchor: unitNow,
    from: w.from,
  };
}

/** Count one call in the bucket of `unit`; calls older than the window are dropped. */
export function bumpWindow(w: TimeWindow, unit: number): TimeWindow {
  const rolled = rollWindow(w, unit);
  const idx = w.buckets.length - 1 - (rolled.anchor - unit);
  if (idx < 0) return rolled;
  const buckets = rolled.buckets.slice();
  buckets[idx] = (buckets[idx] ?? 0) + 1;
  return { ...rolled, buckets };
}

/**
 * Combine two windows unit-by-unit. Counts are summed — the same rule the
 * totals use when replicas flush (each replica contributes its own calls).
 * A unit is known only if it is known in both operands, so `from` is the
 * later of the two.
 */
export function mergeWindows(a: TimeWindow, b: TimeWindow): TimeWindow {
  const anchor = Math.max(a.anchor, b.anchor);
  const ra = rollWindow(a, anchor);
  const rb = rollWindow(b, anchor);
  return {
    buckets: ra.buckets.map((n, i) => n + (rb.buckets[i] ?? 0)),
    anchor,
    from: Math.max(a.from, b.from),
  };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Rebuild a window from persisted values. Short arrays leave older units unknown,
 * and a corrupt value (non-numeric, negative) makes it and every older unit unknown.
 */
export function windowFromRow(size: number, buckets: readonly number[], anchor: number, from: number): TimeWindow {
  const kept = buckets.length > size ? buckets.slice(buckets.length - size) : buckets;
  const lastBad = kept.reduce((acc, n, i) => (isCount(n) ? acc : i), -1);
  const clean = kept.map((n) => (isCount(n) ? n : 0));
  const padded = [...new Array<number>(size - clean.length).fill(0), ...clean];
  const oldestKnown = anchor - (kept.length - 1) + (lastBad + 1);
  return { buckets: padded, anchor, from: Math.max(from, oldestKnown) };
}

export interface WindowView {
  /** Counts per unit, oldest first, starting at the first known unit. */
  readonly buckets: number[];
  /** Absolute unit index of buckets[0]. */
  readonly start: number;
}

/** Roll to `unitNow` and drop the unknown leading units. */
export function windowView(w: TimeWindow, unitNow: number): WindowView | null {
  const size = w.buckets.length;
  const r = rollWindow(w, unitNow);
  const oldest = r.anchor - (size - 1);
  const skip = Math.min(size, Math.max(0, r.from - oldest));
  if (skip >= size) return null;
  return { buckets: r.buckets.slice(skip) as number[], start: oldest + skip };
}

/** A persisted window as stored on a row (null anchor/from = legacy, unknown). */
export interface StoredWindow {
  readonly buckets: readonly number[];
  readonly anchor?: number | null;
  readonly from?: number | null;
}

/**
 * Combine the stored window of a row with a replica's delta, by absolute unit.
 * `created`: the row was created by this very delta — an all-zero base known from
 * size-1 units back (no earlier calls existed). Otherwise a row with no anchor is
 * legacy: its units cannot be placed in time, so the base is zeros known only
 * from the delta's unit.
 */
export function mergeStored(
  size: number, unitNow: number, cur: StoredWindow, incoming: StoredWindow, created: boolean,
): TimeWindow {
  const dAnchor = incoming.anchor ?? unitNow;
  const inc = windowFromRow(size, incoming.buckets, dAnchor, incoming.from ?? dAnchor - (size - 1));
  if (cur.anchor == null) {
    return mergeWindows(emptyTimeWindow(size, dAnchor, created ? dAnchor - (size - 1) : dAnchor), inc);
  }
  return mergeWindows(windowFromRow(size, cur.buckets, cur.anchor, cur.from ?? cur.anchor), inc);
}
