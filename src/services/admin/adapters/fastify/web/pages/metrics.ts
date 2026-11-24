// Metrics dashboard page — aggregate KPI strip, per-tool table, and an
// ASCII bar chart of the top deny rules across all tools.
//
// Returns the inner body for /admin/metrics (between <main>...</main>); the
// caller is responsible for HEAD, NAV, and FOOT.
//
// `metricsList()` does not currently surface bucket history, so the table
// does not include a sparkline column. All tool names and rule names are
// HTML-escaped before interpolation, including inside the <pre> ASCII chart.

import { escapeHtml, pill, kpi } from '../components.js';

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
  metrics: MetricsEntry[];
}

const ASCII_BAR_WIDTH = 20;
const TOP_DENY_RULES = 10;

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function denyRate(total: number, deny: number): string {
  if (total <= 0) return '—';
  return `${((deny / total) * 100).toFixed(1)}%`;
}

function topRuleFor(rule_denies: Record<string, number>): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of Object.entries(rule_denies)) {
    if (count <= 0) continue;
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}

function aggregateRuleDenies(metrics: MetricsEntry[]): Array<{ name: string; count: number }> {
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

function renderAsciiBar(value: number, max: number, width: number = ASCII_BAR_WIDTH): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  const clamped = Math.max(0, Math.min(width, filled));
  return '█'.repeat(clamped) + '░'.repeat(width - clamped);
}

function renderKpis(metrics: MetricsEntry[]): string {
  const totalCalls = sum(metrics.map((m) => m.total));
  const totalAllow = sum(metrics.map((m) => m.allow));
  const totalDeny = sum(metrics.map((m) => m.deny));
  const rate = denyRate(totalCalls, totalDeny);
  return `<div class="row" style="gap:var(--gap)">
${kpi('Total calls', totalCalls)}
${kpi('Allow', totalAllow)}
${kpi('Deny', totalDeny)}
${kpi('Deny rate', rate)}
</div>`;
}

function renderRow(m: MetricsEntry): string {
  const tool = escapeHtml(m.tool);
  const href = `/admin/tools/${encodeURIComponent(m.tool)}`;
  const top = topRuleFor(m.rule_denies);
  const topCell = top
    ? `${pill(top.name, 'deny')} <span class="muted">${top.count}</span>`
    : '<span class="muted">—</span>';
  let lastCell: string;
  if (!m.last_ts) {
    lastCell = '<span class="muted">—</span>';
  } else {
    const iso = new Date(m.last_ts).toISOString();
    const isoEsc = escapeHtml(iso);
    lastCell = `<span class="muted" data-ts="${m.last_ts}" title="${isoEsc}" x-text="window.timeAgo(+$el.dataset.ts)">${isoEsc}</span>`;
  }
  return `<tr>
<td><a href="${escapeHtml(href)}">${tool}</a></td>
<td>${m.total}</td>
<td>${m.allow}</td>
<td>${m.deny}</td>
<td>${denyRate(m.total, m.deny)}</td>
<td>${topCell}</td>
<td>${lastCell}</td>
</tr>`;
}

function renderTable(metrics: MetricsEntry[]): string {
  if (metrics.length === 0) {
    return `<p class="muted">(no metrics recorded yet)</p>`;
  }
  // Stable sort: list() already returns entries alphabetically; sorting by
  // total desc gives "total desc, then tool asc" for ties.
  const sorted = [...metrics].sort((a, b) => b.total - a.total);
  const body = sorted.map(renderRow).join('\n');
  return `<table class="metrics-table">
<thead>
<tr>
<th>tool</th>
<th>total</th>
<th>allow</th>
<th>deny</th>
<th>deny%</th>
<th>top deny rule</th>
<th>last seen</th>
</tr>
</thead>
<tbody>${body}</tbody>
</table>`;
}

function renderTopDenyRules(metrics: MetricsEntry[]): string {
  const aggregated = aggregateRuleDenies(metrics);
  if (aggregated.length === 0) {
    return `<p class="muted">(no denies recorded)</p>`;
  }
  const top = aggregated.slice(0, TOP_DENY_RULES);
  const maxCount = top[0]?.count ?? 0;
  const maxNameLen = top.length > 0 ? Math.max(...top.map((r) => r.name.length)) : 0;
  const lines = top.map((r) => {
    const namePadded = r.name.padEnd(maxNameLen, ' ');
    const bar = renderAsciiBar(r.count, maxCount);
    return `${escapeHtml(namePadded)}  ${bar} ${r.count}`;
  });
  return `<div class="ascii-bar"><pre>${lines.join('\n')}</pre></div>`;
}

export function renderMetricsPage(view: MetricsPageInput): string {
  const { metrics } = view;
  return `<h2>usage metrics</h2>
<p class="muted">Prometheus scrape: <code>/metrics</code> on this port. JSON: <code>/api/v1/usage</code>.</p>

${renderKpis(metrics)}

<h3>per tool</h3>
${renderTable(metrics)}

<h3>top deny rules</h3>
${renderTopDenyRules(metrics)}`;
}
