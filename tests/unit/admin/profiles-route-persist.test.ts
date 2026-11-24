import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerProfileRoutes } from '../../../src/services/admin/adapters/fastify/routes/profiles.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { loadRuntimeProfiles } from '../../../src/services/profiles/runtime/loader.js';

const log = { info: () => {}, warn: () => {} };

describe('profile routes persist runtime profiles to the store', () => {
  let app: FastifyInstance;
  let registry: ProfileRegistry;
  let store: SplicedockStore;

  beforeEach(async () => {
    registry = new ProfileRegistry();
    const service = new ProfileService(registry, new ToolRegistry());
    store = await SplicedockStore.open(':memory:');
    app = Fastify({ logger: false });
    registerProfileRoutes(app, registry, service, store);
    await app.ready();
  });
  afterEach(async () => { await app.close(); await store.close(); });

  it('POST persists the profile to runtime_profiles', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'ops', tools: ['grafana__*'] } });
    expect(res.statusCode).toBe(201);
    const rows = await store.listRuntimeProfiles();
    expect(rows.map(r => r.name)).toEqual(['ops']);
    expect(rows[0].tools).toEqual(['grafana__*']);
  });

  it('POST a reserved name (default) is rejected 409 and never persisted', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'default', tools: ['grafana__*'] } });
    expect(res.statusCode).toBe(409);
    expect(await store.listRuntimeProfiles()).toEqual([]);
    expect(registry.getProfile('default')).toBeUndefined();
  });

  it('POST a name that collides with a file-defined profile is rejected 409', async () => {
    registry.addFileProfile('workspace', { tools: ['vault__*'] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'workspace', tools: ['grafana__*'] } });
    expect(res.statusCode).toBe(409);
    expect(await store.listRuntimeProfiles()).toEqual([]);
    // The file profile is untouched.
    expect(registry.getProfile('workspace')).toEqual({ tools: ['vault__*'], source: 'file' });
  });

  it('DELETE removes the persisted row', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'ops', tools: ['grafana__*'] } });
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/profiles/ops' });
    expect(del.statusCode).toBe(204);
    expect(await store.listRuntimeProfiles()).toEqual([]);
  });

  it('a profile created via POST survives a simulated restart', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'ops', tools: ['grafana__*', 'exa__*'] } });
    // Simulate a pod restart: a fresh registry reloaded from the same store.
    const rebooted = new ProfileRegistry();
    await loadRuntimeProfiles(store, rebooted, log);
    expect(rebooted.getProfile('ops')).toMatchObject({ tools: ['grafana__*', 'exa__*'], source: 'runtime' });
  });
});
