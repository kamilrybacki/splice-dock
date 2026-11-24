import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerProfileTokenRoutes } from '../../src/services/admin/adapters/fastify/routes/profile-tokens.js';
import { buildAdminAuthHook, buildAdminTokenSet } from '../../src/services/admin/adapters/fastify/auth.js';
import { SplicedockStore } from '../../src/services/database/adapters/store.js';
import { hashProfileToken } from '../../src/services/authentication/base.js';
it('authenticates admin mutations, binds identity, rotates and immediately revokes', async () => {
  const store = await SplicedockStore.open(':memory:');
  const app = Fastify();
  app.decorateRequest('adminIdentity', undefined);
  app.addHook('preHandler', buildAdminAuthHook(buildAdminTokenSet('test-admin', [])));
  registerProfileTokenRoutes(app, store, { max_ttl_seconds: 120, default_ttl_seconds: 60 });
  const headers = { authorization: 'Bearer test-admin' };
  try {
    expect((await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds: 60 } })).statusCode).toBe(401);
    const minted = await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', headers, payload: { profile: 'ops', expires_in_seconds: 60 } });
    expect(minted.statusCode).toBe(201);
    const { id, token } = minted.json().data;
    expect((await store.listProfileTokens())[0].created_by).toBe('admin');
    expect((await store.findProfileByToken(hashProfileToken(token), Date.now()))?.id).toBe(id);
    const rotated = await app.inject({ method: 'POST', url: `/api/v1/profile-tokens/${id}/rotate`, headers });
    expect(rotated.statusCode).toBe(201);
    expect(await store.findProfileByToken(hashProfileToken(token), Date.now())).toBeNull();
    const successor = rotated.json().data;
    const revoke = () => app.inject({ method: 'POST', url: `/api/v1/profile-tokens/${successor.id}/revoke`, headers, payload: { reason: 'compromised' } });
    expect((await revoke()).statusCode).toBe(204);
    expect(await store.findProfileByToken(hashProfileToken(successor.token), Date.now())).toBeNull();
    expect((await revoke()).statusCode).toBe(409);
    expect(await store.listProfileTokens()).toHaveLength(2);
  } finally { await app.close(); await store.close(); }
});
