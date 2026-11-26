// Metrics dashboard page — Calls and Denied-by-policy cards with detail dialogs,
// per-tool table.
//
// Returns the inner body for /admin/metrics (between <main>...</main>); the
// caller is responsible for HEAD, NAV, and FOOT.
//
// The per-tool table has no sparkline column; the Calls dialog gets the
// aggregated hourly history via the optional `hourly` input. All tool names and rule names are
// HTML-escaped before interpolation. Formatting (numbers, deny rate, relative
// time) lives in ../format.ts and is deterministic: `now` is injectable.

import { escapeHtml, pill } from '../components.js';
import { renderCallsCard, renderCallsDialog, type HourlyHistory } from './metric-dialogs/calls.js';
import { buildDeniedModel, renderDeniedCard, renderDeniedDialog } from './metric-dialogs/denied.js';
import {
  classifyMetrics,
  emptyStateText,
  formatDenyRate,
  formatNumber,
  renderGeneratedAt,
  renderTime,
} from '../format.js';

export interface MetricsEntry {
  tool: string;
  total: number;
  allow: number;
  deny: number;
  /** rule name → deny count */
  rule_denies: Record<string, number>;
  /** Unix timestamp ms of the most recent call; 0 if never observed. */
  last_ts: number;
}

export interface MetricsPageInput {
  /** null / undefined means the counters could not be read ("Data unavailable"). */
  metrics: MetricsEntry[] | null | undefined;
  /** Current time in ms; injected so output is deterministic in tests. */
  now?: number;
  /** Hourly call history with real bounds; omit when unreliable. */
  hourly?: HourlyHistory | null;
  /** Unix ms when counters began, only if reliably known. */
  recordingStartTs?: number;
}

interface RuleCount {
  name: string;
  count: number;
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function topRuleFor(rule_denies: Record<string, number>): RuleCount | null {
  let best: RuleCount | null = null;
  for (const [name, count] of Object.entries(rule_denies)) {
    if (count <= 0) continue;
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}

function aggregateRuleDenies(metrics: MetricsEntry[]): Record<string, number> {
  // A Map, not a plain object: a rule named "__proto__" must count like any other.
  const agg = new Map<string, number>();
  for (const m of metrics) {
    for (const [rule, count] of Object.entries(m.rule_denies)) {
      if (count > 0) agg.set(rule, (agg.get(rule) ?? 0) + count);
    }
  }
  return Object.fromEntries(agg);
}

function renderScope(now: number, allow: number, available: boolean): string {
  const allowed = available
    ? ` Allowed by policy: <strong class="nowrap">${escapeHtml(formatNumber(allow))}</strong>.`
    : '';
  return `<p class="metrics-scope">CLI calls · cumulative counters · snapshot ${renderGeneratedAt(now)}.${allowed}</p>`;
}

function renderCards(view: MetricsPageInput, now: number): string {
  const list = view.metrics ?? [];
  const available = classifyMetrics(view.metrics) !== 'unavailable';
  const totalCalls = sum(list.map((m) => m.total));
  const denied = {
    totalCalls,
    deny: sum(list.map((m) => m.deny)),
    ruleDenies: aggregateRuleDenies(list),
    recordingStartTs: view.recordingStartTs,
    now,
  };
  const model = buildDeniedModel(denied);
  const calls = { totalCalls, hourly: view.hourly, now };
  const dialogs = available ? `${renderCallsDialog(calls)}\n${renderDeniedDialog(model, denied)}` : '';
  return `<div class="metric-cards">
${renderCallsCard(totalCalls, available)}
${renderDeniedCard(model, available)}
</div>
${dialogs}`;
}

function renderRow(m: MetricsEntry, now: number): string {
  const tool = escapeHtml(m.tool);
  const href = `/admin/tools/${encodeURIComponent(m.tool)}`;
  const top = topRuleFor(m.rule_denies);
  const topCell = top
    ? `${pill(top.name)} <span class="muted nowrap">${escapeHtml(formatNumber(top.count))}</span>`
    : '<span class="muted">—</span>';
  return `<tr>
<td><a href="${escapeHtml(href)}">${tool}</a></td>
<td class="num">${escapeHtml(formatNumber(m.total))}</td>
<td class="num">${escapeHtml(formatNumber(m.allow))}</td>
<td class="num">${escapeHtml(formatNumber(m.deny))}</td>
<td class="num">${escapeHtml(formatDenyRate(m.deny, m.total))}</td>
<td>${topCell}</td>
<td class="nowrap">${renderTime(m.last_ts, now)}</td>
</tr>`;
}

function renderTable(metrics: MetricsEntry[] | null | undefined, now: number): string {
  const state = classifyMetrics(metrics);
  if (!metrics || state === 'no-calls') {
    return `<p class="empty-state">${escapeHtml(emptyStateText(state, 0))}</p>`;
  }
  // Stable sort: list() already returns entries alphabetically; sorting by
  // total desc gives "total desc, then tool asc" for ties.
  const sorted = [...metrics].sort((a, b) => b.total - a.total);
  const body = sorted.map((m) => renderRow(m, now)).join('\n');
  return `<div class="table-scroll">
<table class="metrics-table">
<thead>
<tr>
<th>tool</th>
<th class="num">total</th>
<th class="num">allow</th>
<th class="num">deny</th>
<th class="num">deny%</th>
<th>top deny rule</th>
<th>last seen</th>
</tr>
</thead>
<tbody>${body}</tbody>
</table>
</div>`;
}

function renderExportDetails(): string {
  return `<details class="metrics-details">
<summary>Export &amp; scraping</summary>
<p class="muted">Prometheus scrape: <code>/metrics</code> on this port. JSON: <code>/api/v1/usage</code>.</p>
</details>`;
}

export function renderMetricsPage(view: MetricsPageInput): string {
  const { metrics } = view;
  const now = view.now ?? Date.now();
  const available = classifyMetrics(metrics) !== 'unavailable';
  const allow = sum((metrics ?? []).map((m) => m.allow));
  return `<h2>usage metrics</h2>
${renderScope(now, allow, available)}

${renderCards(view, now)}

<h3>per tool</h3>
${renderTable(metrics, now)}

${renderExportDetails()}`;
}
