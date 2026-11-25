import { describe, it, expect } from 'vitest';
import {
  renderMetricsPage,
  type MetricsEntry,
} from '../../../src/services/admin/adapters/fastify/web/pages/metrics.js';
import { renderToolsPage } from '../../../src/services/admin/adapters/fastify/web/pages/tools.js';
import { parseDecisionFilter } from '../../../src/services/admin/adapters/fastify/web/pages/audit.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function entry(tool: string, over: Partial<MetricsEntry> = {}): MetricsEntry {
  return { tool, total: 0, allow: 0, deny: 0, rule_denies: {}, last_ts: 0, ...over };
}

describe('renderMetricsPage', () => {
  it('states the scope and labels the policy outcomes', () => {
    const html = renderMetricsPage({
      metrics: [entry('kubectl', { total: 1200, allow: 1197, deny: 3, rule_denies: { r1: 3 }, last_ts: NOW - 120_000 })],
      now: NOW,
    });
    expect(html).toContain('CLI calls · cumulative counters since process start');
    expect(html).toContain('generated');
    expect(html).toContain('Allowed by policy');
    expect(html).toContain('Blocked by policy');
    expect(html).toContain('1,200');
    expect(html).toContain('3 of 1,200 calls');
    expect(html).toContain('2 min ago');
    expect(html).toContain('<time datetime="2026-01-01T11:58:00.000Z"');
  });

  it('shows <0.1% instead of rounding a real deny to 0%', () => {
    const html = renderMetricsPage({
      metrics: [entry('gh', { total: 10_000, allow: 9_999, deny: 1, rule_denies: { r: 1 } })],
      now: NOW,
    });
    expect(html).toContain('&lt;0.1%');
  });

  it('wraps the table for horizontal scroll and links to filtered denies', () => {
    const html = renderMetricsPage({
      metrics: [entry('gh', { total: 4, allow: 3, deny: 1, rule_denies: { r: 1 } })],
      now: NOW,
    });
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('href="/admin/audit?decision=deny"');
    expect(html).toContain('<details class="metrics-details">');
  });

  it('lists top 5 rules and folds the rest into <details> Other', () => {
    const rules: Record<string, number> = {};
    for (let i = 1; i <= 7; i++) rules[`rule-${i}`] = 100 - i;
    const html = renderMetricsPage({
      metrics: [entry('gh', { total: 1000, allow: 300, deny: 700, rule_denies: rules })],
      now: NOW,
    });
    expect(html).toContain('Other (2)');
    expect(html).toContain('Bar width is relative to the most frequent rule.');
    expect(html).not.toContain('█');
    const top = html.split('<details class="metrics-details"><summary>Other')[0] ?? '';
    expect(top).toContain('rule-5');
    expect(top).not.toContain('rule-6');
  });

  it('escapes tool and rule names', () => {
    const html = renderMetricsPage({
      metrics: [entry('<b>x</b>', { total: 2, deny: 1, allow: 1, rule_denies: { '<i>': 1 } })],
      now: NOW,
    });
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>');
  });

  it('uses distinct empty states', () => {
    const unavailable = renderMetricsPage({ metrics: null, now: NOW });
    expect(unavailable).toContain('Data unavailable');
    expect(unavailable).not.toContain('No calls yet');

    const none = renderMetricsPage({ metrics: [], now: NOW });
    expect(none).toContain('No calls yet');

    const noDenies = renderMetricsPage({ metrics: [entry('gh', { total: 1500, allow: 1500 })], now: NOW });
    expect(noDenies).toContain('No denies in 1,500 calls');
    expect(noDenies).not.toContain('Show denies');
  });
});

describe('renderToolsPage', () => {
  it('labels the top deny rule as covering the last 50 denies', () => {
    const html = renderToolsPage({ policies: [], recent_denies: [], metrics: [], now: NOW });
    expect(html).toContain('Most frequent rule in the last 50 denies');
  });
});

describe('parseDecisionFilter', () => {
  it('accepts only whitelisted decisions', () => {
    expect(parseDecisionFilter('deny')).toBe('deny');
    expect(parseDecisionFilter('allow')).toBe('allow');
    expect(parseDecisionFilter('approval')).toBe('approval');
    expect(parseDecisionFilter('x')).toBeUndefined();
    expect(parseDecisionFilter(undefined)).toBeUndefined();
  });
});
