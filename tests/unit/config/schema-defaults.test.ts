import { describe, it, expect } from 'vitest';
import { splicedockConfigSchema } from '../../../src/config/schema.js';

// zod 4: `.default({})` short-circuits and skips inner defaults; `.prefault({})`
// keeps the v3 behaviour of parsing {} through the object. Guard that here.
describe('splicedockConfigSchema nested defaults', () => {
  const cfg = splicedockConfigSchema.parse({});

  it('fills server defaults from an empty config', () => {
    expect(cfg.server.port).toBe(8788);
    expect(cfg.server.require_profile_token).toBe(true);
    expect(cfg.server.admin_tokens).toEqual([]);
  });

  it('keeps binding to all interfaces unless a host is configured', () => {
    expect(cfg.server.host).toBeUndefined();
    expect(cfg.server.admin_host).toBe('0.0.0.0');
  });

  it('accepts explicit bind hosts and rejects empty ones', () => {
    const c = splicedockConfigSchema.parse({ server: { host: '127.0.0.1', admin_host: '127.0.0.1' } });
    expect(c.server.host).toBe('127.0.0.1');
    expect(c.server.admin_host).toBe('127.0.0.1');
    expect(() => splicedockConfigSchema.parse({ server: { admin_host: '' } })).toThrow();
    expect(() => splicedockConfigSchema.parse({ server: { host: '' } })).toThrow();
  });

  it('lets a config opt out of profile tokens explicitly', () => {
    expect(splicedockConfigSchema.parse({ server: { require_profile_token: false } }).server.require_profile_token).toBe(false);
  });

  it('fills deeply nested object defaults', () => {
    expect(cfg.server.shadow.queue_max).toBe(1000);
    expect(cfg.server.token_policy.max_ttl_seconds).toBe(2592000);
    expect(cfg.server.vault.fail_closed_auth).toBe(true);
    expect(cfg.server.vault.fail_closed_destructive).toBe(true);
  });

  it('has no strong-consent tools unless configured', () => {
    expect(cfg.server.consent.strong_default_tools).toEqual([]);
  });

  it('still accepts the deprecated broker block', () => {
    expect(() => splicedockConfigSchema.parse({ broker: { repo_delete: { enabled: false } } })).not.toThrow();
  });

  it('keeps profiles as a string-keyed record', () => {
    expect(cfg.profiles).toEqual({});
  });
});
