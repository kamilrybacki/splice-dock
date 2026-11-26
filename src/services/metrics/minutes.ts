// Per-minute (60 x 1min) binding of the generic window helpers in ./window.ts.
// anchor = absolute minute index (epoch ms / 60_000) of buckets[59], the
// current, in-progress minute. See window.ts for the full semantics.

import { emptyTimeWindow, windowFromRow as windowFromRowN, type TimeWindow } from './window.js';

export const MINUTES = 60;
export const MS_PER_MINUTE = 60_000;

export type MinuteWindow = TimeWindow;

export function minuteOf(ts: number): number {
  return Math.floor(ts / MS_PER_MINUTE);
}

export function emptyMinutes(anchor: number, from: number): MinuteWindow {
  return emptyTimeWindow(MINUTES, anchor, from);
}

export function minutesFromRow(buckets: readonly number[], anchor: number, from: number): MinuteWindow {
  return windowFromRowN(MINUTES, buckets, anchor, from);
}
