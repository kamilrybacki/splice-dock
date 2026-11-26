// Hourly (24 x 1h) binding of the generic window helpers in ./window.ts.
// anchor = absolute hour index (epoch ms / 3_600_000) of buckets[23], the
// current, in-progress hour. See window.ts for the full semantics.

import {
  emptyTimeWindow, windowFromRow as windowFromRowN, windowView, type TimeWindow,
} from './window.js';

export { bumpWindow, mergeWindows, rollWindow } from './window.js';

export const HOURS = 24;
export const MS_PER_HOUR = 3_600_000;

export type HourlyWindow = TimeWindow;

export function hourOf(ts: number): number {
  return Math.floor(ts / MS_PER_HOUR);
}

export function emptyWindow(anchor: number, from: number): HourlyWindow {
  return emptyTimeWindow(HOURS, anchor, from);
}

export function windowFromRow(buckets: readonly number[], anchor: number, from: number): HourlyWindow {
  return windowFromRowN(HOURS, buckets, anchor, from);
}

export interface HourlyView {
  /** Counts per hour, oldest first, starting at the first known hour. */
  readonly buckets: number[];
  /** Absolute hour index of buckets[0]. */
  readonly startHour: number;
}

/** Roll to `hourNow` and drop the unknown leading hours. */
export function hourlyView(w: HourlyWindow, hourNow: number): HourlyView | null {
  const v = windowView(w, hourNow);
  return v ? { buckets: v.buckets, startHour: v.start } : null;
}
