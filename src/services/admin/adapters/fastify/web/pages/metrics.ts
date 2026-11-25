// Metrics dashboard page — scoped KPI strip, per-tool table, and an HTML bar
// list of the top deny rules across all tools.
//
// Returns the inner body for /admin/metrics (between <main>...</main>); the
// caller is responsible for HEAD, NAV, and FOOT.
//
// `metricsList()` does not currently surface bucket history, so the table
// does not include a sparkline column. All tool names and rule names are
// HTML-escaped before interpolation. Formatting (numbers, deny rate, relative
// time) lives in ../format.ts and is deterministic: `now` is injectable.

import { escapeHtml, pill, kpi } from '../components.js';
import {
  classifyMetrics,
  emptyStateText,
  formatDenyBasis,
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
}

const TOP_DENY_RULES = 5;
const SHOW_DENIES_HREF = '/admin/audit?decision=deny';

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

function aggregateRuleDenies(metrics: MetricsEntry[]): RuleCount[] {
  const agg = new Map<string, number>();
  for (const m of metrics) {
    for (const [rule, count] of Object.entries(m.rule_denies)) {
      if (count <= 0) continue;
      agg.set(rule, (agg.get(rule) ?? 0) + count);
    }
  }
  return [...agg.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function renderScope(now: number, allow: number, available: boolean): string {
  const allowed = available
    ? ` Allowed by policy: <strong class="nowrap">${escapeHtml(formatNumber(allow))}</strong>.`
    : '';
  return `<p class="metrics-scope">CLI calls · cumulative counters since process start · generated ${renderGeneratedAt(now)}.${allowed}</p>`;
}

function renderKpis(metrics: MetricsEntry[] | null | undefined): string {
  const state = classifyMetrics(metrics);
  const list = metrics ?? [];
  const totalCalls = sum(list.map((m) => m.total));
  const totalDeny = sum(list.map((m) => m.deny));
  const callsValue = state === 'unavailable' ? '—' : formatNumber(totalCalls);
  const blockedValue = state === 'unavailable' ? '—' : formatNumber(totalDeny);
  const blockedHint =
    state === 'ok'
      ? `${formatDenyRate(totalDeny, totalCalls)} · ${formatDenyBasis(totalDeny, totalCalls)}`
      : emptyStateText(state, totalCalls);
  const callsHint = state === 'unavailable' ? emptyStateText(state, totalCalls) : '';
  return `<div class="kpi-strip">
${kpi('Total calls', callsValue, callsHint, 'kpi-primary')}
${kpi('Blocked by policy', blockedValue, blockedHint, 'kpi-primary')}
</div>`;
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

function renderRuleItem(rule: RuleCount, max: number): string {
  const pct = max > 0 ? Math.max(2, Math.round((rule.count / max) * 100)) : 0;
  return `<li>
<div class="rule-head"><span class="rule-name">${escapeHtml(rule.name)}</span><span class="rule-count">${escapeHtml(formatNumber(rule.count))}</span></div>
<span class="rule-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
</li>`;
}

function renderTopDenyRules(metrics: MetricsEntry[] | null | undefined): string {
  const state = classifyMetrics(metrics);
  const list = metrics ?? [];
  if (state !== 'ok') {
    return `<p class="empty-state">${escapeHtml(emptyStateText(state, sum(list.map((m) => m.total))))}</p>`;
  }
  const aggregated = aggregateRuleDenies(list);
  if (aggregated.length === 0) {
    return `<p class="empty-state">No deny rules recorded</p>`;
  }
  const max = aggregated[0]?.count ?? 0;
  const top = aggregated.slice(0, TOP_DENY_RULES);
  const rest = aggregated.slice(TOP_DENY_RULES);
  const topList = `<ul class="rule-bars">${top.map((r) => renderRuleItem(r, max)).join('\n')}</ul>`;
  const other =
    rest.length > 0
      ? `\n<details class="metrics-details"><summary>Other (${escapeHtml(formatNumber(rest.length))})</summary>
<ul class="rule-bars">${rest.map((r) => renderRuleItem(r, max)).join('\n')}</ul>
</details>`
      : '';
  return `${topList}${other}
<p class="rule-bars-note">Bar width is relative to the most frequent rule.</p>`;
}

function renderActions(metrics: MetricsEntry[] | null | undefined): string {
  if (classifyMetrics(metrics) !== 'ok') return '';
  return `<p class="metrics-actions"><a href="${SHOW_DENIES_HREF}">Show denies</a> in the audit log</p>`;
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

${renderKpis(metrics)}

${renderActions(metrics)}

<h3>per tool</h3>
${renderTable(metrics, now)}

<h3>top deny rules</h3>
${renderTopDenyRules(metrics)}

${renderExportDetails()}`;
}
