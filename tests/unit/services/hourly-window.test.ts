import { describe, it, expect } from 'vitest';
import {
  HOURS, bumpWindow, emptyWindow, hourlyView, mergeWindows, rollWindow, windowFromRow,
} from '../../../src/services/metrics/hourly.js';

const H = 1_000_000; // arbitrary absolute hour index

function win(anchor: number, entries: Record<number, number>, from = 0) {
  const w = emptyWindow(anchor, from);
  return { ...w, buckets: w.buckets.map((_, i) => entries[i] ?? 0) };
}

describe('hourly window semantics', () => {
  it('index 23 is the current hour and index i covers anchor-(23-i)', () => {
    let w = emptyWindow(H, 0);
    w = bumpWindow(w, H);
    expect(w.buckets[HOURS - 1]).toBe(1);
    w = bumpWindow(w, H - 2); // a call two hours ago lands at index 21
    expect(w.buckets[HOURS - 3]).toBe(1);
  });

  it('drops calls older than the window and rolls forward on newer hours', () => {
    let w = bumpWindow(emptyWindow(H, 0), H - 30);
    expect(w.buckets.every((n) => n === 0)).toBe(true);
    w = bumpWindow(bumpWindow(emptyWindow(H, 0), H), H + 1);
    expect(w.anchor).toBe(H + 1);
    expect(w.buckets[HOURS - 1]).toBe(1);
    expect(w.buckets[HOURS - 2]).toBe(1);
  });

  it('rolls across a multi-hour gap and clears everything after 24h', () => {
    const w = win(H, { 23: 4, 22: 2 });
    const r3 = rollWindow(w, H + 3);
    expect(r3.buckets[20]).toBe(4);
    expect(r3.buckets[19]).toBe(2);
    expect(r3.buckets.slice(21)).toEqual([0, 0, 0]);
    expect(rollWindow(w, H + 24).buckets.every((n) => n === 0)).toBe(true);
    expect(rollWindow(w, H + 500).anchor).toBe(H + 500);
  });

  it('does not move backwards when the clock steps back', () => {
    const w = win(H, { 23: 1 });
    expect(rollWindow(w, H - 1)).toBe(w);
  });

  it('merges by absolute hour and sums', () => {
    const a = win(H, { 23: 5, 22: 1 });
    const b = win(H - 1, { 23: 2, 22: 7 }); // b lags one hour behind
    const m = mergeWindows(a, b);
    expect(m.anchor).toBe(H);
    expect(m.buckets[23]).toBe(5); // b's newest is hour H-1, not H
    expect(m.buckets[22]).toBe(1 + 2);
    expect(m.buckets[21]).toBe(7);
  });

  it('merge keeps the later "known from" hour', () => {
    const m = mergeWindows(win(H, {}, H - 3), win(H, {}, 0));
    expect(m.from).toBe(H - 3);
  });

  it('hourlyView hides hours before `from` instead of zero-filling', () => {
    const w = { ...win(H, { 23: 3, 22: 1 }), from: H - 1 };
    const v = hourlyView(w, H)!;
    expect(v.buckets).toEqual([1, 3]);
    expect(v.startHour).toBe(H - 1);
    expect(hourlyView({ ...w, from: H + 5 }, H + 5)!.buckets).toEqual([0]);
  });

  it('windowFromRow pads short arrays and bounds `from`', () => {
    const w = windowFromRow([1, 2], H, 0);
    expect(w.buckets).toHaveLength(HOURS);
    expect(w.buckets.slice(-2)).toEqual([1, 2]);
    expect(w.from).toBe(H - 1); // older hours are unknown, not zero
  });
});
