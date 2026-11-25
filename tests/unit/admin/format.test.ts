import { describe, it, expect } from 'vitest';
import {
  classifyMetrics,
  emptyStateText,
  formatDenyBasis,
  formatDenyRate,
  formatNumber,
  formatRelativeTime,
  renderTime,
} from '../../../src/services/admin/adapters/fastify/web/format.js';
import { spark } from '../../../src/services/admin/adapters/fastify/web/components.js';

describe('formatNumber', () => {
  it('groups thousands with en-US separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(0)).toBe('0');
  });
  it('renders non-finite values as an em dash', () => {
    expect(formatNumber(Number.NaN)).toBe('—');
  });
});

describe('formatDenyRate', () => {
  it('shows <0.1% for a real but tiny rate', () => {
    expect(formatDenyRate(1, 10_000)).toBe('<0.1%');
  });
  it('shows 0% only when there are no denies', () => {
    expect(formatDenyRate(0, 500)).toBe('0%');
  });
  it('shows an em dash without a denominator', () => {
    expect(formatDenyRate(0, 0)).toBe('—');
  });
  it('shows one decimal otherwise', () => {
    expect(formatDenyRate(1, 8)).toBe('12.5%');
  });
});

describe('formatDenyBasis', () => {
  it('gives the count and the denominator', () => {
    expect(formatDenyBasis(3, 1200)).toBe('3 of 1,200 calls');
    expect(formatDenyBasis(1, 1)).toBe('1 of 1 call');
  });
});

describe('relative time', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  it('formats coarse relative time', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 d ago');
  });
  it('renders <time datetime> with the exact time visible', () => {
    const html = renderTime(now - 5 * 60_000, now);
    expect(html).toContain('<time datetime="2026-01-01T11:55:00.000Z"');
    expect(html).toContain('5 min ago');
    expect(html).toContain('2026-01-01 11:55 UTC</span>');
  });
  it('renders a missing timestamp as an em dash', () => {
    expect(renderTime(0, now)).toContain('—');
    expect(renderTime(0, now)).not.toContain('<time');
  });
});

describe('empty states', () => {
  it('distinguishes unavailable, no calls and no denies', () => {
    expect(classifyMetrics(null)).toBe('unavailable');
    expect(classifyMetrics([])).toBe('no-calls');
    expect(classifyMetrics([{ total: 5, deny: 0 }])).toBe('no-denies');
    expect(classifyMetrics([{ total: 5, deny: 1 }])).toBe('ok');
    expect(emptyStateText('unavailable', 0)).toBe('Data unavailable');
    expect(emptyStateText('no-calls', 0)).toBe('No calls yet');
    expect(emptyStateText('no-denies', 1500)).toBe('No denies in 1,500 calls');
  });
});

describe('spark', () => {
  it('draws no line when data is missing', () => {
    for (const v of [null, undefined, []]) {
      const html = spark(v as number[] | null | undefined);
      expect(html).toContain('spark-empty');
      expect(html).not.toContain('▁');
    }
  });
});
