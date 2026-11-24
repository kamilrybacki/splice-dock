import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { buildAdminAuthHook, CSRF_HEADER, ADMIN_SESSION_COOKIE } from '../../../src/services/admin/adapters/fastify/auth.js';
import { registerApprovalRoutes } from '../../../src/services/admin/adapters/fastify/routes/approvals.js';
import type { ApprovalService } from '../../../src/services/approvals/base.js';

const ID = '11111111-2222-3333-4444-555555555555';
let app: ReturnType<typeof Fastify> | undefined;

async function build() {
  const service = {
    isStrong: vi.fn().mockReturnValue(false),
    approve: vi.fn().mockReturnValue(true),
    reject: vi.fn().mockReturnValue(true),
    get: vi.fn().mockReturnValue({ id: ID }),
    list: vi.fn().mockReturnValue([]),
  };
  app = Fastify({ logger: false });
  app.decorateRequest('adminIdentity', undefined);
  await app.register(async authed => {
    authed.addHook('preHandler', buildAdminAuthHook('legacy-placeholder', [{ name: 'alice', token: 'alice-placeholder' }]));
    registerApprovalRoutes(authed, service as unknown as ApprovalService);
  });
  return service;
}

afterEach(async () => { await app?.close(); app = undefined; });

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('approval approver identity', () => {
  it('admin bearer cannot approve strong',async()=>{const svc=await build();svc.isStrong.mockReturnValue(true);const r=await app!.inject({method:'POST',url:`/api/v1/approvals/${ID}/approve`,headers:bearer('alice-placeholder')});expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('webauthn_required');expect(svc.approve).toHaveBeenCalledWith(ID,'alice');});
  it('uses the authenticated name and ignores body.approver (approve)', async () => {
    const svc = await build();
    const res = await app!.inject({
      method: 'POST', url: `/api/v1/approvals/${ID}/approve`,
      headers: bearer('alice-placeholder'), payload: { approver: 'mallory' },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.approve).toHaveBeenCalledWith(ID, 'alice');
  });

  it('uses the authenticated name and ignores body.approver (reject)', async () => {
    const svc = await build();
    await app!.inject({
      method: 'POST', url: `/api/v1/approvals/${ID}/reject`,
      headers: bearer('alice-placeholder'), payload: { approver: 'mallory' },
    });
    expect(svc.reject).toHaveBeenCalledWith(ID, 'alice');
  });

  it('records the fixed identity "admin" for the legacy token', async () => {
    const svc = await build();
    await app!.inject({ method: 'POST', url: `/api/v1/approvals/${ID}/approve`, headers: bearer('legacy-placeholder'), payload: {} });
    expect(svc.approve).toHaveBeenCalledWith(ID, 'admin');
  });

  it('still accepts a request without a body', async () => {
    const svc = await build();
    const res = await app!.inject({ method: 'POST', url: `/api/v1/approvals/${ID}/approve`, headers: bearer('alice-placeholder') });
    expect(res.statusCode).toBe(200);
    expect(svc.approve).toHaveBeenCalledWith(ID, 'alice');
  });

  it('blocks a cookie-authenticated approve without the CSRF header, and allows it with', async () => {
    const svc = await build();
    const cookie = `${ADMIN_SESSION_COOKIE}=alice-placeholder`;
    const blocked = await app!.inject({ method: 'POST', url: `/api/v1/approvals/${ID}/approve`, headers: { cookie }, payload: {} });
    expect(blocked.statusCode).toBe(403);
    expect(svc.approve).not.toHaveBeenCalled();
    const ok = await app!.inject({ method: 'POST', url: `/api/v1/approvals/${ID}/approve`, headers: { cookie, [CSRF_HEADER]: '1' }, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(svc.approve).toHaveBeenCalledWith(ID, 'alice');
  });
});
