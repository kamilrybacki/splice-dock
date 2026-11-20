import { describe, it, expect, vi } from 'vitest';

describe('logger', () => {
  it('emits structured JSON with required fields', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { logger } = await import('../../src/common/logger.js');
    logger.info('test message', { request_id: 'abc', tool: 'foo__bar' });
    const raw = (spy.mock.calls[0][0] as string).trim();
    const obj = JSON.parse(raw);
    expect(obj.level).toBe('info');
    expect(obj.message).toBe('test message');
    expect(obj.request_id).toBe('abc');
    expect(obj.tool).toBe('foo__bar');
    expect(obj.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    spy.mockRestore();
  });

  it('all four log levels produce valid JSON output', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { logger } = await import('../../src/common/logger.js');
    logger.debug('d', { duration_ms: 1 });
    logger.info('i');
    logger.warn('w');
    logger.error('e', { error: 'oops' });
    const calls = spy.mock.calls.map(c => JSON.parse((c[0] as string).trim()));
    spy.mockRestore();
    expect(calls.map((c: { level: string }) => c.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(calls[0]).toHaveProperty('duration_ms', 1);
    expect(calls[3]).toHaveProperty('error', 'oops');
  });
});
