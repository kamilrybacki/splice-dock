// "Calls" card + detail dialog. Hourly history is optional: without real time
// bounds the dialog says so and never invents dates or zero-fills gaps.

import { escapeHtml } from '../../components.js';
import { renderDetailsButton, renderMetricDialog } from '../../dialog.js';
import { formatNumber, renderGeneratedAt, utcStamp } from '../../format.js';

export const CALLS_DIALOG_ID = 'md-calls';
export const TOOLS_HREF = '/admin/tools';
const HOUR_MS = 3_600_000;

/** Hourly call counts with REAL bounds. Only build this from reliable data. */
export interface HourlyHistory {
  /** Counts per hour, oldest first. */
  buckets: number[];
  /** Unix ms of the start of buckets[0]. */
  startTs: number;
  /** True when the final bucket is still accumulating. */
  lastInProgress: boolean;
}

export interface CallsInput {
  /** Cumulative counter total across tools. */
  totalCalls: number;
  hourly?: HourlyHistory | null;
  now: number;
}

/** The dialog describes the last 24 hours, so longer histories are rejected. */
export const MAX_HOURLY_BUCKETS = 24;

export function isValidHourly(h: HourlyHistory | null | undefined): h is HourlyHistory {
  return (
    !!h &&
    Array.isArray(h.buckets) &&
    h.buckets.length > 0 &&
    h.buckets.length <= MAX_HOURLY_BUCKETS &&
    Number.isFinite(h.startTs) &&
    h.startTs > 0 &&
    h.buckets.every((n) => Number.isFinite(n) && n >= 0)
  );
}

export function bucketSum(h: HourlyHistory): number {
  return h.buckets.reduce((a, b) => a + b, 0);
}

function hourLabel(h: HourlyHistory, i: number): string {
  const start = h.startTs + i * HOUR_MS;
  const live = h.lastInProgress && i === h.buckets.length - 1 ? ' (in progress)' : '';
  return `${utcStamp(start)}${live}`;
}

/** Bar height in percent of the max bucket; axis starts at zero. */
export function barHeight(count: number, max: number): number {
  if (!(max > 0) || !(count > 0)) return 0;
  return Math.max(1, Math.round((count / max) * 100));
}

export function renderCallsCard(totalCalls: number, available: boolean): string {
  const value = available ? formatNumber(totalCalls) : '—';
  const sub = !available
    ? 'Data unavailable'
    : totalCalls <= 0
      ? 'No calls recorded'
      : 'Cumulative · allowed and denied';
  const button = available ? renderDetailsButton(CALLS_DIALOG_ID, 'Details of calls') : '';
  return `<div class="metric-card" data-metric="calls">
<span class="kpi-label">Calls</span>
<span class="metric-value nowrap">${escapeHtml(value)}</span>
<span class="metric-sub">${escapeHtml(sub)}</span>
${button}
</div>`;
}

function renderHistogram(h: HourlyHistory): string {
  const max = Math.max(...h.buckets);
  const last = h.buckets.length - 1;
  const bars = h.buckets
    .map((n, i) => {
      const label = `${hourLabel(h, i)}: ${formatNumber(n)} ${n === 1 ? 'call' : 'calls'}`;
      const cls = h.lastInProgress && i === last ? ' class="hist-live"' : '';
      return `<li${cls} tabindex="0" data-hist-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span style="height:${barHeight(n, max)}%"></span></li>`;
    })
    .join('');
  const rows = h.buckets
    .map((n, i) => `<tr><td>${escapeHtml(hourLabel(h, i))}</td><td>${escapeHtml(formatNumber(n))}</td></tr>`)
    .join('');
  const axis = `<span>${escapeHtml(utcStamp(h.startTs))}</span><span>${escapeHtml(utcStamp(h.startTs + last * HOUR_MS))}${h.lastInProgress ? ' · in progress' : ''}</span>`;
  return `<ol class="hist" aria-label="Calls per hour, axis from 0 to ${escapeHtml(formatNumber(max))}">${bars}</ol>
<div class="hist-axis">${axis}</div>
<p class="hist-readout" aria-live="polite">Select a bar to read an hour. Unit: calls per hour, axis from 0.</p>
<details class="md-rest"><summary>Show hourly values</summary><table class="md-table"><thead><tr><th>Hour</th><th>Calls</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

function renderHero(input: CallsInput, hourly: HourlyHistory | null): string {
  if (hourly) {
    const sum = bucketSum(hourly);
    return `<span class="md-number">${escapeHtml(formatNumber(sum))}</span><span class="md-basis">calls in ${escapeHtml(formatNumber(hourly.buckets.length))} hourly buckets, ${escapeHtml(utcStamp(hourly.startTs))} to ${escapeHtml(utcStamp(hourly.startTs + hourly.buckets.length * HOUR_MS))}</span>`;
  }
  if (input.totalCalls <= 0) {
    return `<span class="md-number">No calls recorded</span>`;
  }
  return `<span class="md-number">${escapeHtml(formatNumber(input.totalCalls))}</span><span class="md-basis">cumulative counter, not an hourly total</span>`;
}

function renderContent(hourly: HourlyHistory | null, totalCalls: number): string {
  if (hourly) {
    const cumulative = `<p class="md-note">Cumulative counter: ${escapeHtml(formatNumber(totalCalls))} calls. It is a separate figure from the hourly total above.</p>`;
    return `${renderHistogram(hourly)}${cumulative}`;
  }
  if (totalCalls <= 0) return '';
  return `<p class="md-note"><strong>Hourly history unavailable.</strong> This page has no reliable time bounds for hourly buckets, so none are shown.</p>`;
}

function renderMeasured(hourly: HourlyHistory | null): string {
  const bounds = hourly
    ? 'The buckets are the real hours listed in the table; they are not an exact rolling 24 hours.'
    : 'Dates are never inferred when the bucket bounds are unknown.';
  return `<p>Calls include both allowed and denied requests. ${bounds}</p>`;
}

export function renderCallsDialog(input: CallsInput): string {
  const hourly = isValidHourly(input.hourly) ? input.hourly : null;
  return renderMetricDialog({
    id: CALLS_DIALOG_ID,
    title: 'Calls',
    scope: 'Recent hourly activity · all tools',
    hero: renderHero(input, hourly),
    definition: 'Every call recorded, allowed or denied, grouped by hour when history is available.',
    content: renderContent(hourly, input.totalCalls),
    measured: renderMeasured(hourly),
    snapshot: `Snapshot ${renderGeneratedAt(input.now)}`,
    cta: { href: TOOLS_HREF, label: 'View tools' },
  });
}
