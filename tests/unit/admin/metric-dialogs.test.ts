import { describe, it, expect } from 'vitest';
import { formatPercentAdaptive } from '../../../src/services/admin/adapters/fastify/web/format.js';
import { renderMetricDialog, renderDetailsButton } from '../../../src/services/admin/adapters/fastify/web/dialog.js';
import {
  barWidth,
  buildDeniedModel,
  renderDeniedCard,
  renderDeniedDialog,
  type DeniedInput,
} from '../../../src/services/admin/adapters/fastify/web/pages/metric-dialogs/denied.js';
import {
  barHeight,
  bucketSum,
  isValidHourly,
  renderCallsDialog,
  type HourlyHistory,
} from '../../../src/services/admin/adapters/fastify/web/pages/metric-dialogs/calls.js';
import { renderMetricsPage } from '../../../src/services/admin/adapters/fastify/web/pages/metrics.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function denied(over: Partial<DeniedInput> = {}): DeniedInput {
  return { totalCalls: 1000, deny: 100, ruleDenies: {}, now: NOW, ...over };
}

describe('formatPercentAdaptive', () => {
  it('handles empty denominators and zero parts', () => {
    expect(formatPercentAdaptive(0, 0)).toBe('—');
    expect(formatPercentAdaptive(0, 50)).toBe('0%');
    expect(formatPercentAdaptive(50, 50)).toBe('100%');
  });
  it('never shows a tiny positive share as zero', () => {
    expect(formatPercentAdaptive(1, 10_000)).toBe('0.010%');
    expect(formatPercentAdaptive(1, 1_000_000_000)).not.toBe('0%');
    expect(formatPercentAdaptive(1, 1e12)).toBe('<0.0001%');
  });
  it('uses adaptive precision and never rounds up to 100%', () => {
    expect(formatPercentAdaptive(1, 8)).toBe('12.5%');
    expect(formatPercentAdaptive(1, 400)).toBe('0.25%');
    expect(formatPercentAdaptive(99_999, 100_000)).toBe('>99.9%');
  });
});

describe('dialog component', () => {
  const html = renderMetricDialog({
    id: 'd1', title: '<T>', scope: 's', hero: '<b>h</b>', definition: 'def',
    content: '<p>c</p>', measured: '<p>m</p>', snapshot: 'snap', cta: { href: '/x?a=1&b=2', label: 'Go' },
  });
  it('is a native dialog with aria wiring, heading focus target and Close', () => {
    expect(html).toContain('<dialog id="d1"');
    expect(html).toContain('aria-labelledby="d1-title"');
    expect(html).toContain('aria-describedby="d1-desc"');
    expect(html).toContain('<h2 id="d1-title" tabindex="-1">&lt;T&gt;</h2>');
    expect(html).toContain('data-md-close');
    expect(html).toContain('href="/x?a=1&amp;b=2"');
  });
  it('places header and footer outside the single scroll area', () => {
    expect(html.indexOf('md-header')).toBeLessThan(html.indexOf('md-body'));
    expect(html.indexOf('md-body')).toBeLessThan(html.indexOf('md-footer'));
    expect(html.match(/class="md-body"/g)).toHaveLength(1);
  });
  it('renders the opener with aria-label', () => {
    expect(renderDetailsButton('d1', 'Details of x')).toContain('data-md-open="d1"');
  });
});

describe('denied model', () => {
  it('uses ALL denials as the denominator, also after the top 5', () => {
    const rules: Record<string, number> = {};
    for (let i = 1; i <= 7; i++) rules[`r${i}`] = 10;
    const m = buildDeniedModel(denied({ deny: 100, ruleDenies: rules }));
    expect(m.top).toHaveLength(5);
    expect(m.rest).toHaveLength(2);
    expect(m.unattributed).toBe(30);
    const html = renderDeniedDialog(m, denied({ deny: 100, ruleDenies: rules }));
    expect(html).toContain('10 · 10.0%');
    expect(html).toContain('style="width:10%"');
    expect(html).toContain('Unattributed');
    expect(html).toContain('30 · 30.0%');
  });
  it('omits Unattributed when rules cover all denials', () => {
    const i = denied({ deny: 10, ruleDenies: { a: 10 } });
    expect(renderDeniedDialog(buildDeniedModel(i), i)).not.toContain('Unattributed');
  });
  it('does not present overlapping counts as shares', () => {
    const i = denied({ deny: 10, ruleDenies: { a: 8, b: 8 } });
    const m = buildDeniedModel(i);
    expect(m.inconsistent).toBe(true);
    const html = renderDeniedDialog(m, i);
    expect(html).toContain('not shares');
    expect(html).not.toContain('class="rule-bar"');
  });
  it('0/0: no calls, rate dash, no ranking', () => {
    const i = denied({ totalCalls: 0, deny: 0 });
    const html = renderDeniedDialog(buildDeniedModel(i), i);
    expect(html).toContain('No calls recorded');
    expect(html).toContain('Denial rate: —');
    expect(html).not.toContain('md-rules');
  });
  it('N/0: states no denials and ranks nothing', () => {
    const i = denied({ totalCalls: 1500, deny: 0 });
    const html = renderDeniedDialog(buildDeniedModel(i), i);
    expect(html).toContain('No policy denials');
    expect(html).toContain('among 1,500 recorded calls');
    expect(html).not.toContain('md-rules');
  });
  it('tiny rate keeps precision in the dialog and <0.1% on the card', () => {
    const i = denied({ totalCalls: 100_000, deny: 1, ruleDenies: { a: 1 } });
    const m = buildDeniedModel(i);
    expect(renderDeniedCard(m, true)).toContain('&lt;0.1%');
    expect(renderDeniedDialog(m, i)).toContain('exact rate: 0.0010%');
  });
  it('formats millions and wraps full long names escaped', () => {
    const long = 'rule-<x>-' + 'a'.repeat(120);
    const i = denied({ totalCalls: 12_345_678, deny: 1_234_567, ruleDenies: { [long]: 1_234_567 } });
    const html = renderDeniedDialog(buildDeniedModel(i), i);
    expect(html).toContain('1,234,567');
    expect(html).toContain('rule-&lt;x&gt;-' + 'a'.repeat(120));
    expect(html).not.toContain('<x>');
  });
  it('reports recording start unknown unless provided, and links to the deny audit filter', () => {
    const i = denied({ ruleDenies: { a: 100 } });
    const html = renderDeniedDialog(buildDeniedModel(i), i);
    expect(html).toContain('Recording start unknown');
    expect(html).toContain('href="/admin/audit?decision=deny"');
    const withStart = denied({ ruleDenies: { a: 100 }, recordingStartTs: NOW - 86_400_000 });
    expect(renderDeniedDialog(buildDeniedModel(withStart), withStart)).not.toContain('Recording start unknown');
  });
  it('bar width is never 0 for a positive count', () => {
    expect(barWidth(1, 1_000_000)).toBe(1);
    expect(barWidth(0, 10)).toBe(0);
  });
});

describe('calls dialog', () => {
  const hourly: HourlyHistory = { buckets: [0, 5, 10], startTs: Date.UTC(2026, 0, 1, 9), lastInProgress: true };
  it('without history says unavailable and invents no dates or zero buckets', () => {
    const html = renderCallsDialog({ totalCalls: 500, now: NOW });
    expect(html).toContain('Hourly history unavailable');
    expect(html).toContain('cumulative counter');
    expect(html).not.toContain('class="hist"');
    expect(html).not.toContain('calls in ');
    expect(html).not.toContain('<th>Hour</th>');
  });
  it('rejects invalid history', () => {
    expect(isValidHourly({ buckets: [], startTs: 1, lastInProgress: false })).toBe(false);
    expect(isValidHourly({ buckets: [1], startTs: 0, lastInProgress: false })).toBe(false);
    expect(isValidHourly({ buckets: [-1], startTs: 1, lastInProgress: false })).toBe(false);
    expect(isValidHourly(null)).toBe(false);
    expect(isValidHourly({ buckets: new Array(25).fill(1), startTs: 1, lastInProgress: false })).toBe(false);
    expect(isValidHourly({ buckets: new Array(24).fill(1), startTs: 1, lastInProgress: false })).toBe(true);
  });
  it('histogram sum equals the dialog total; last bucket marked in progress; table present', () => {
    const html = renderCallsDialog({ totalCalls: 9999, hourly, now: NOW });
    expect(bucketSum(hourly)).toBe(15);
    expect(html).toContain('<span class="md-number">15</span>');
    expect(html).toContain('hist-live');
    expect(html).toContain('(in progress)');
    expect(html).toContain('Show hourly values');
    expect(html).toContain('Cumulative counter: 9,999 calls');
    expect(html).toContain('href="/admin/tools"');
  });
  it('0 calls shows no chart', () => {
    const html = renderCallsDialog({ totalCalls: 0, now: NOW });
    expect(html).toContain('No calls recorded');
    expect(html).not.toContain('class="hist"');
  });
  it('axis starts at zero (heights proportional to max)', () => {
    expect(barHeight(5, 10)).toBe(50);
    expect(barHeight(0, 10)).toBe(0);
    expect(barHeight(1, 1_000_000)).toBe(1);
  });
});

describe('metrics page integration', () => {
  it('renders both cards and dialogs, none when data unavailable', () => {
    const ok = renderMetricsPage({
      metrics: [{ tool: 'gh', total: 10, allow: 8, deny: 2, rule_denies: { r: 2 }, last_ts: 0 }],
      now: NOW,
    });
    expect(ok).toContain('data-md-open="md-calls"');
    expect(ok).toContain('aria-label="Details of policy denials"');
    expect(ok).toContain('<dialog id="md-denied"');
    const bad = renderMetricsPage({ metrics: null, now: NOW });
    expect(bad).not.toContain('<dialog');
  });
  it('counts a rule named __proto__ instead of reporting it as unattributed', () => {
    const rule_denies = JSON.parse('{"__proto__": 2}') as Record<string, number>;
    const html = renderMetricsPage({
      metrics: [{ tool: 'gh', total: 10, allow: 8, deny: 2, rule_denies, last_ts: 0 }],
      now: NOW,
    });
    expect(html).toContain('<span class="rule-name">__proto__</span>');
    expect(html).not.toContain('No rule attribution recorded');
    expect(html).not.toContain('Unattributed');
  });
});
