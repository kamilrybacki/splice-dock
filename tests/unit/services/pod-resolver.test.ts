import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLookup = vi.fn();
vi.mock('node:dns', () => ({ promises: { lookup: (...args: unknown[]) => mockLookup(...args) } }));

const { PodResolver } = await import('../../../src/services/upstreams/adapters/dns/pods.js');

describe('PodResolver', () => {
  let r: PodResolver;

  beforeEach(() => {
    r = new PodResolver();
    mockLookup.mockReset();
  });

  it('resolves DNS and caches for TTL', async () => {
    mockLookup.mockResolvedValue([
      { address: '10.0.0.1', family: 4 },
      { address: '10.0.0.2', family: 4 },
    ]);
    const a = await r.resolve('foo.svc');
    const b = await r.resolve('foo.svc');
    expect(a).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(b).toBe(a); // cache hit — same reference
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it('round-robins across IPs', () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    expect(r.pickOne('x', ips)).toBe('10.0.0.1');
    expect(r.pickOne('x', ips)).toBe('10.0.0.2');
    expect(r.pickOne('x', ips)).toBe('10.0.0.3');
    expect(r.pickOne('x', ips)).toBe('10.0.0.1');
  });

  it('invalidate clears cache', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await r.resolve('foo.svc');
    r.invalidate('foo.svc');
    await r.resolve('foo.svc');
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it('throws when no pods available', () => {
    expect(() => r.pickOne('x', [])).toThrow(/no pods/);
  });

  it('re-fetches after TTL expires', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    // Use a very short TTL (1ms) so cache expires immediately
    await r.resolve('bar.svc', 1);
    await new Promise(res => setTimeout(res, 5));
    mockLookup.mockResolvedValue([{ address: '10.0.0.2', family: 4 }]);
    const fresh = await r.resolve('bar.svc', 1);
    expect(fresh).toEqual(['10.0.0.2']);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it('round-robin is independent per serviceDns key', () => {
    const ips = ['10.0.0.1', '10.0.0.2'];
    // advance x once
    r.pickOne('x', ips);
    // y should still start at index 0
    expect(r.pickOne('y', ips)).toBe('10.0.0.1');
  });
});
