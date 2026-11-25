import { describe, it, expect } from 'vitest';
import { proxyDriverKey, proxyDriverNamespace } from '../../../src/services/upstreams/adapters/mcp/driver.js';

describe('proxyDriverKey', () => {
  it('is the bare namespace when there is no per-identity override', () => {
    expect(proxyDriverKey('vault')).toBe('vault');
  });

  it('gives different agents on the same profile different keys', () => {
    const builder = proxyDriverKey('vault', { profile: 'worker', agent: 'builder' });
    const reviewer = proxyDriverKey('vault', { profile: 'worker', agent: 'reviewer' });
    expect(builder).not.toBe(reviewer);
  });

  it('does not collide "no agent" with an agent named "_" or the empty label', () => {
    const none = proxyDriverKey('vault', { profile: 'worker', agent: null });
    expect(none).not.toBe(proxyDriverKey('vault', { profile: 'worker', agent: '_' }));
    expect(none).not.toBe(proxyDriverKey('vault', { profile: 'worker', agent: '' }));
  });

  it('gives different profiles different keys for the same agent', () => {
    expect(proxyDriverKey('vault', { profile: 'a', agent: 'x' })).not.toBe(
      proxyDriverKey('vault', { profile: 'b', agent: 'x' }));
  });

  it('keeps the namespace recoverable from a per-identity key', () => {
    expect(proxyDriverNamespace(proxyDriverKey('vault', { profile: 'worker', agent: 'builder' }))).toBe('vault');
    expect(proxyDriverNamespace(proxyDriverKey('vault'))).toBe('vault');
  });

  it('keeps the profile directly after the namespace so a profile prefix still matches', () => {
    const key = proxyDriverKey('vault', { profile: 'worker', agent: 'builder' });
    expect(key.startsWith('vault\u0000worker\u0000')).toBe(true);
  });
});
