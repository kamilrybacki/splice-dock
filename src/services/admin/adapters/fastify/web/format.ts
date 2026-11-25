// Pure, deterministic formatting helpers shared by the admin pages. Nothing
// here reads the clock or the locale: callers pass `now` in, and numbers are
// always rendered with the en-US grouping so output is stable across hosts.

import { escapeHtml } from './components.js';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

/** 1234567 -> "1,234,567". Non-finite input renders as an em dash. */
export function formatNumber(n: number): string {
  return Number.isFinite(n) ? NUMBER_FORMAT.format(n) : '—';
}

/**
 * Deny rate as a percentage string.
 *   total <= 0           -> "—" (no denominator, nothing to rate)
 *   deny <= 0            -> "0%" (truly no denies)
 *   0 < rate < 0.05%     -> "<0.1%" (never round a real deny down to 0)
 *   otherwise            -> one decimal, "12.5%"
 */
export function formatDenyRate(deny: number, total: number): string {
  if (!(total > 0)) return '—';
  if (!(deny > 0)) return '0%';
  const pct = (deny / total) * 100;
  if (pct < 0.05) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

/**
 * Exact percentage with adaptive precision, for detail views. A real positive
 * share never renders as zero and a non-total never renders as 100%.
 *   whole <= 0        -> "—"
 *   part <= 0         -> "0%"
 *   part >= whole     -> "100%"
 *   >= 1%             -> one decimal ("12.5%")
 *   0.1% .. 1%        -> two decimals ("0.25%")
 *   below 0.1%        -> two significant digits ("0.0042%"), floor "<0.0001%"
 *   rounds up to 100  -> ">99.9%"
 */
export function formatPercentAdaptive(part: number, whole: number): string {
  if (!(whole > 0)) return '—';
  if (!(part > 0)) return '0%';
  if (part >= whole) return '100%';
  const pct = (part / whole) * 100;
  if (pct >= 99.95) return '>99.9%';
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.1) return `${pct.toFixed(2)}%`;
  if (pct < 0.0001) return '<0.0001%';
  return `${pct.toPrecision(2)}%`;
}

function callsWord(n: number): string {
  return n === 1 ? 'call' : 'calls';
}

/** "3 of 1,200 calls": the count and the denominator behind a rate. */
export function formatDenyBasis(deny: number, total: number): string {
  return `${formatNumber(deny)} of ${formatNumber(total)} ${callsWord(total)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse relative time ("just now", "5 min ago", "3 h ago", "2 d ago"). */
export function formatRelativeTime(ts: number, now: number): string {
  const diff = now - ts;
  // A timestamp ahead of the clock (skew or bad data) is labelled, not "just now".
  if (diff < 0) return 'in the future';
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  return `${Math.floor(diff / DAY)} d ago`;
}

export function utcStamp(ts: number): string {
  const iso = new Date(ts).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * `<time datetime="ISO">N min ago</time>` with the exact UTC time shown next
 * to it (not only in a tooltip). A missing timestamp (0 / not finite) is "—".
 */
export function renderTime(ts: number, now: number): string {
  // Finite values outside the Date range (|ts| > 8.64e15) make toISOString() throw.
  if (!Number.isFinite(ts) || ts <= 0 || Number.isNaN(new Date(ts).getTime())) {
    return '<span class="muted">—</span>';
  }
  const iso = new Date(ts).toISOString();
  const exact = escapeHtml(utcStamp(ts));
  return `<time datetime="${escapeHtml(iso)}" title="${exact}">${escapeHtml(
    formatRelativeTime(ts, now),
  )}</time> <span class="muted nowrap">${exact}</span>`;
}

/** Generated-at stamp for page subtitles. */
export function renderGeneratedAt(now: number): string {
  return `<time datetime="${escapeHtml(new Date(now).toISOString())}">${escapeHtml(utcStamp(now))}</time>`;
}

export type MetricsState = 'unavailable' | 'no-calls' | 'no-denies' | 'ok';

/** Distinct empty states: no data source vs no traffic vs no denies. */
export function classifyMetrics(
  metrics: ReadonlyArray<{ total: number; deny: number }> | null | undefined,
): MetricsState {
  if (!metrics) return 'unavailable';
  const total = metrics.reduce((s, m) => s + m.total, 0);
  if (total <= 0) return 'no-calls';
  const deny = metrics.reduce((s, m) => s + m.deny, 0);
  return deny <= 0 ? 'no-denies' : 'ok';
}

export function emptyStateText(state: MetricsState, totalCalls: number): string {
  if (state === 'unavailable') return 'Data unavailable';
  if (state === 'no-calls') return 'No calls yet';
  if (state === 'no-denies') return `No denies in ${formatNumber(totalCalls)} ${callsWord(totalCalls)}`;
  return '';
}
