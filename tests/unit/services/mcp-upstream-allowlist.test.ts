import { describe, it, expect } from 'vitest';
import { isUpstreamHostAllowed } from '../../../src/application/upstreams/mcp-upstream-allowlist.js';

describe('isUpstreamHostAllowed', () => {
  it('denies everything by default', () => {
    expect(isUpstreamHostAllowed('a.svc', [])).toBe(false);
  });
  it('matches exact hosts case-insensitively', () => {
    expect(isUpstreamHostAllowed(' A.Svc ', ['a.svc'])).toBe(true);
    expect(isUpstreamHostAllowed('b.svc', ['a.svc'])).toBe(false);
  });
  it('wildcard matches subdomains but not the apex or lookalikes', () => {
    const list = ['*.tools.svc'];
    expect(isUpstreamHostAllowed('x.tools.svc', list)).toBe(true);
    expect(isUpstreamHostAllowed('tools.svc', list)).toBe(false);
    expect(isUpstreamHostAllowed('evil-tools.svc', list)).toBe(false);
  });
});
