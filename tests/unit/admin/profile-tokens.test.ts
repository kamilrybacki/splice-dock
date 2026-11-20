import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { registerProfileTokenRoutes } from '../../../src/adapters/inbound/admin/routes/profile-tokens.js';
import { hashProfileToken } from '../../../src/application/auth/profile-token.js';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';

describe('profile-token routes', () => {
  let app: FastifyInstance;
  let store: SplicedockStore;

  beforeEach(async () => {
    store = await SplicedockStore.open(':memory:');
    app = Fastify({ logger: false });
    registerProfileTokenRoutes(app, store);
    await app.ready();
  });
  afterEach(async () => { await app.close(); await store.close(); });

  it('POST mints a token shown once, storing only its hash', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds: 3600 } });
    expect(res.statusCode).toBe(201);
    const data = (res.json() as { data: { id: string; profile: string; token: string } }).data;
    expect(data.profile).toBe('ops');
    expect(typeof data.token).toBe('string');
    expect(data.token.length).toBeGreaterThanOrEqual(40);
    // The raw token is not persisted; only its sha256 hash resolves.
    expect(await store.findProfileByToken(hashProfileToken(data.token), Date.now())).toEqual({ id: data.id, profile: 'ops', agent: null });
    const listed = await store.listProfileTokens();
    expect(listed[0]).not.toHaveProperty('token');
    expect(listed[0]).not.toHaveProperty('token_hash');
  });

  it('POST rejects a missing or malformed profile name', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'bad name!' } })).statusCode).toBe(422);
  });

  it('GET lists tokens without exposing the secret', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds: 3600 } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/profile-tokens' });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]['profile']).toBe('ops');
    expect(rows[0]).not.toHaveProperty('token');
    expect(rows[0]).not.toHaveProperty('token_hash');
  });

  it('DELETE removes a token (204) or reports 404', async () => {
    const mk = await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds: 3600 } });
    const id = (mk.json() as { data: { id: string } }).data.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/profile-tokens/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/profile-tokens/${id}` })).statusCode).toBe(404);
  });

  it('POST with agent persists it, returns it, and lookup + list carry it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', agent: 'claude-code', expires_in_seconds: 3600 } });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { id: string; token: string; agent: string };
    expect(data.agent).toBe('claude-code');
    expect(await store.findProfileByToken(hashProfileToken(data.token), Date.now())).toEqual({ id: data.id, profile: 'ops', agent: 'claude-code' });
    const rows = (await app.inject({ method: 'GET', url: '/api/v1/profile-tokens' })).json().data as Array<{ agent: string | null }>;
    expect(rows[0].agent).toBe('claude-code');
  });

  it('POST without agent returns null agent', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds: 3600 } });
    expect(res.json().data.agent).toBeNull();
  });

  it('POST rejects an invalid agent with 422', async () => {
    for (const agent of ['bad name!', 'x'.repeat(65), '', 5, 'a\nb']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', agent, expires_in_seconds: 3600 } });
      expect(res.statusCode, String(agent)).toBe(422);
    }
    expect(await store.listProfileTokens()).toHaveLength(0);
  });

  it('rotate carries the agent label to the successor', async () => {
    const mk = await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', agent: 'agent-a', expires_in_seconds: 3600 } });
    const old = mk.json().data as { id: string };
    const rot = await app.inject({ method: 'POST', url: `/api/v1/profile-tokens/${old.id}/rotate` });
    expect(rot.statusCode).toBe(201);
    const next = rot.json().data as { id: string; token: string; agent: string };
    expect(next.agent).toBe('agent-a');
    expect(await store.findProfileByToken(hashProfileToken(next.token), Date.now())).toEqual({ id: next.id, profile: 'ops', agent: 'agent-a' });
  });

  it('hashProfileToken is a stable sha256 hex', () => {
    expect(hashProfileToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
  it('PATCH sets and clears the agent label without changing the token', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds: 3600 } })).json() as { data: { id: string; token: string } };
    const { id, token } = created.data;
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/profile-tokens/${id}`, payload: { agent: 'agent-a' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { id, profile: 'ops', agent: 'agent-a' } });
    expect(await store.findProfileByToken(hashProfileToken(token), Date.now())).toEqual({ id, profile: 'ops', agent: 'agent-a' });
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/profile-tokens/${id}`, payload: { agent: null } })).statusCode).toBe(200);
    expect(await store.findProfileByToken(hashProfileToken(token), Date.now())).toEqual({ id, profile: 'ops', agent: null });
  });

  it('PATCH rejects a bad label, a missing field, and unknown or revoked tokens', async () => {
    const { id } = ((await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds: 3600 } })).json() as { data: { id: string } }).data;
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/profile-tokens/${id}`, payload: { agent: 'bad name!' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/profile-tokens/${id}`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/profile-tokens/nope', payload: { agent: 'agent-a' } })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: `/api/v1/profile-tokens/${id}/revoke`, payload: { reason: 'manual' } });
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/profile-tokens/${id}`, payload: { agent: 'agent-a' } })).statusCode).toBe(404);
  });
});

it('rejects mint without TTL or above maximum', async () => {
  const store = await SplicedockStore.open(':memory:');
  const app = Fastify(); registerProfileTokenRoutes(app, store);
  for (const expires_in_seconds of [undefined, 0, -1, 1.5, 2592001]) {
    expect((await app.inject({ method: 'POST', url: '/api/v1/profile-tokens', payload: { profile: 'ops', expires_in_seconds } })).statusCode).toBe(400);
  }
  await app.close(); await store.close();
});
