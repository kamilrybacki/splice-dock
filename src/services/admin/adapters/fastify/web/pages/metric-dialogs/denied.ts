// "Denied by policy" card + detail dialog, built from the cumulative counters
// already rendered on the page (no fetch on open). Bars are the share of ALL
// denials, never of the top 5 or of the leading rule.

import { escapeHtml } from '../../components.js';
import { renderDetailsButton, renderMetricDialog } from '../../dialog.js';
import {
  formatDenyBasis,
  formatDenyRate,
  formatNumber,
  formatPercentAdaptive,
  renderGeneratedAt,
} from '../../format.js';

export const DENIED_DIALOG_ID = 'md-denied';
export const AUDIT_DENY_HREF = '/admin/audit?decision=deny';
const TOP_RULES = 5;

export interface DeniedInput {
  totalCalls: number;
  deny: number;
  /** rule name -> deny count, aggregated across tools. */
  ruleDenies: Record<string, number>;
  /** Unix ms when counters began, only if reliably known. */
  recordingStartTs?: number;
  now: number;
}

export interface RuleShare {
  name: string;
  count: number;
}

export interface DeniedModel {
  totalCalls: number;
  deny: number;
  rules: RuleShare[];
  top: RuleShare[];
  rest: RuleShare[];
  /** Denials not attributed to any rule; 0 when none. */
  unattributed: number;
  /** Rule counts exceed the denial total: categories cannot be disjoint shares. */
  inconsistent: boolean;
}

export function buildDeniedModel(input: DeniedInput): DeniedModel {
  const rules = Object.entries(input.ruleDenies)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const attributed = rules.reduce((acc, r) => acc + r.count, 0);
  return {
    totalCalls: input.totalCalls,
    deny: input.deny,
    rules,
    top: rules.slice(0, TOP_RULES),
    rest: rules.slice(TOP_RULES),
    unattributed: Math.max(0, input.deny - attributed),
    inconsistent: attributed > input.deny,
  };
}

/** Bar width in whole percent of ALL denials; never 0 for a positive count. */
export function barWidth(count: number, deny: number): number {
  if (!(deny > 0) || !(count > 0)) return 0;
  return Math.min(100, Math.max(1, Math.round((count / deny) * 100)));
}

export function renderDeniedCard(m: DeniedModel, available: boolean): string {
  const value = available ? formatNumber(m.deny) : '—';
  const rate = available && m.totalCalls > 0 ? formatDenyRate(m.deny, m.totalCalls) : '';
  const sub = !available
    ? 'Data unavailable'
    : m.totalCalls <= 0
      ? 'No calls recorded'
      : `of ${formatNumber(m.totalCalls)} ${m.totalCalls === 1 ? 'call' : 'calls'}`;
  const rateHtml = rate ? `<span class="metric-rate">${escapeHtml(rate)}</span>` : '';
  const button = available
    ? renderDetailsButton(DENIED_DIALOG_ID, 'Details of policy denials')
    : '';
  return `<div class="metric-card" data-metric="denied">
<span class="kpi-label">Denied by policy</span>
<span class="metric-value nowrap">${escapeHtml(value)}${rateHtml}</span>
<span class="metric-sub">${escapeHtml(sub)}</span>
${button}
</div>`;
}

function renderRuleRow(r: RuleShare, deny: number, shares: boolean): string {
  const share = shares ? formatPercentAdaptive(r.count, deny) : '';
  const bar = shares
    ? `<span class="rule-bar" aria-hidden="true"><span style="width:${barWidth(r.count, deny)}%"></span></span>`
    : '';
  const count = `${formatNumber(r.count)}${share ? ` · ${share}` : ''}`;
  return `<li><div class="rule-head"><span class="rule-name">${escapeHtml(r.name)}</span><span class="rule-count">${escapeHtml(count)}</span></div>${bar}</li>`;
}

function renderUnattributed(m: DeniedModel): string {
  if (m.unattributed <= 0) return '';
  const share = formatPercentAdaptive(m.unattributed, m.deny);
  return `<li class="rule-unattributed"><div class="rule-head"><span class="rule-name">Unattributed</span><span class="rule-count">${escapeHtml(`${formatNumber(m.unattributed)} · ${share}`)}</span></div><span class="rule-bar" aria-hidden="true"><span style="width:${barWidth(m.unattributed, m.deny)}%"></span></span></li>`;
}

function renderRanking(m: DeniedModel): string {
  const shares = !m.inconsistent;
  const list = (rows: RuleShare[], extra = '') =>
    `<ul class="md-rules">${rows.map((r) => renderRuleRow(r, m.deny, shares)).join('')}${extra}</ul>`;
  const rest =
    m.rest.length > 0
      ? `<details class="md-rest"><summary>Other rules (${escapeHtml(formatNumber(m.rest.length))})</summary>${list(m.rest)}</details>`
      : '';
  const caption = shares
    ? `Bar length and percentage are the share of all ${escapeHtml(formatNumber(m.deny))} denials.`
    : 'Rule counts add up to more than the denial total, so they are shown as counts, not shares.';
  return `${list(m.top, renderUnattributed(m))}${rest}<p class="md-note">${caption}</p>`;
}

function renderContent(m: DeniedModel): string {
  if (m.deny <= 0) return '';
  if (m.rules.length === 0 && m.unattributed > 0) {
    return `<p class="md-note">No rule attribution recorded for these denials.</p>`;
  }
  return renderRanking(m);
}

function heroFor(m: DeniedModel): { hero: string; empty: boolean } {
  if (m.totalCalls <= 0) {
    return { hero: `<span class="md-number">No calls recorded</span><span class="md-basis">Denial rate: —</span>`, empty: true };
  }
  if (m.deny <= 0) {
    return {
      hero: `<span class="md-number">No policy denials</span><span class="md-basis">among ${escapeHtml(formatNumber(m.totalCalls))} recorded ${m.totalCalls === 1 ? 'call' : 'calls'}</span>`,
      empty: true,
    };
  }
  return {
    hero: `<span class="md-number">${escapeHtml(formatNumber(m.deny))}</span><span class="md-basis">${escapeHtml(formatDenyBasis(m.deny, m.totalCalls))} · exact rate: ${escapeHtml(formatPercentAdaptive(m.deny, m.totalCalls))}</span>`,
    empty: false,
  };
}

function renderMeasured(start: number | undefined): string {
  const since =
    start && start > 0
      ? `Counters have been recording since ${renderGeneratedAt(start)}.`
      : 'Recording start unknown.';
  return `<p>Counters are cumulative, not a time window. ${since}</p><p>Rule counts are tallied per rule; the audit log may hold a different set of events because of its own retention.</p>`;
}

export function renderDeniedDialog(m: DeniedModel, input: DeniedInput): string {
  const { hero } = heroFor(m);
  return renderMetricDialog({
    id: DENIED_DIALOG_ID,
    title: 'Denied by policy',
    scope: 'All tools · cumulative counters',
    hero,
    definition:
      'Calls blocked by a policy decision. A denial does not necessarily mean the service is unhealthy.',
    content: renderContent(m),
    measured: renderMeasured(input.recordingStartTs),
    snapshot: `Snapshot ${renderGeneratedAt(input.now)}`,
    cta: { href: AUDIT_DENY_HREF, label: 'View audit' },
  });
}
