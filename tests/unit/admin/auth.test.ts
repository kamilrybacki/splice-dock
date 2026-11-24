import { describe, it, expect, vi } from 'vitest';
import { buildAdminAuthHook, CSRF_HEADER, ADMIN_SESSION_COOKIE } from '../../../src/services/admin/adapters/fastify/auth.js';

function run(hook: ReturnType<typeof buildAdminAuthHook>, req: Record<string, unknown>) {
  const done = vi.fn();
  const send = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  const r = { ...req } as Record<string, unknown>;
  hook(r as never, { code } as never, done);
  return { done, code, send, req: r };
}

describe('buildAdminAuthHook', () => {
  const hook = buildAdminAuthHook('my-secret-token');

  it('calls done() when Authorization header matches', () => {
    const done = vi.fn();
    const req = { headers: { authorization: 'Bearer my-secret-token' } } as never;
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() } as never;
    hook(req, reply, done);
    expect(done).toHaveBeenCalledWith();
  });

  it('returns 401 when header is missing', () => {
    const { done, code } = run(hook, { headers: {} });
    expect(code).toHaveBeenCalledWith(401);
    expect(done).not.toHaveBeenCalled();
  });

  it('returns 401 when token is wrong', () => {
    const { code } = run(hook, { headers: { authorization: 'Bearer wrong-token' } });
    expect(code).toHaveBeenCalledWith(401);
  });
});

describe('admin identity', () => {
  const hook = buildAdminAuthHook('legacy-placeholder', [
    { name: 'alice', token: 'alice-placeholder' },
    { name: 'bob', token: 'bob-placeholder' },
  ]);

  it('maps the legacy token to the fixed identity "admin"', () => {
    const { done, req } = run(hook, { method: 'GET', headers: { authorization: 'Bearer legacy-placeholder' } });
    expect(done).toHaveBeenCalled();
    expect(req['adminIdentity']).toBe('admin');
  });

  it('maps a named token to its name, via bearer and via cookie', () => {
    const b = run(hook, { method: 'GET', headers: { authorization: 'Bearer bob-placeholder' } });
    expect(b.req['adminIdentity']).toBe('bob');
    const c = run(hook, { method: 'GET', headers: { cookie: `${ADMIN_SESSION_COOKIE}=alice-placeholder` } });
    expect(c.req['adminIdentity']).toBe('alice');
  });

  it('rejects an unknown token and leaves no identity attached', () => {
    const { code, done, req } = run(hook, { method: 'GET', headers: { authorization: 'Bearer nobody' } });
    expect(code).toHaveBeenCalledWith(401);
    expect(done).not.toHaveBeenCalled();
    expect(req['adminIdentity']).toBeUndefined();
  });

  it('works with no named tokens configured (legacy only)', () => {
    const legacyOnly = buildAdminAuthHook('legacy-placeholder');
    const { req } = run(legacyOnly, { method: 'GET', headers: { authorization: 'Bearer legacy-placeholder' } });
    expect(req['adminIdentity']).toBe('admin');
  });
});

describe('CSRF for cookie-authenticated unsafe methods', () => {
  const hook = buildAdminAuthHook('legacy-placeholder');
  const cookie = `${ADMIN_SESSION_COOKIE}=legacy-placeholder`;

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects cookie %s without the CSRF header (403)', method => {
    const { code, done } = run(hook, { method, headers: { cookie } });
    expect(code).toHaveBeenCalledWith(403);
    expect(done).not.toHaveBeenCalled();
  });

  it('accepts a cookie POST carrying the CSRF header', () => {
    const { done } = run(hook, { method: 'POST', headers: { cookie, [CSRF_HEADER]: '1' } });
    expect(done).toHaveBeenCalled();
  });

  it('does not require the header for safe methods', () => {
    expect(run(hook, { method: 'GET', headers: { cookie } }).done).toHaveBeenCalled();
    expect(run(hook, { method: 'HEAD', headers: { cookie } }).done).toHaveBeenCalled();
  });

  it('exempts bearer-authenticated requests', () => {
    const { done } = run(hook, { method: 'POST', headers: { authorization: 'Bearer legacy-placeholder' } });
    expect(done).toHaveBeenCalled();
  });

  it('returns 401, not 403, for an invalid cookie on POST', () => {
    const { code } = run(hook, { method: 'POST', headers: { cookie: `${ADMIN_SESSION_COOKIE}=wrong` } });
    expect(code).toHaveBeenCalledWith(401);
  });
});
