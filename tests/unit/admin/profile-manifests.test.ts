import { it, expect } from 'vitest';
import Fastify from 'fastify';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
import { ProfileRegistry } from '../../../src/application/registry/profile-registry.js';
import { ToolRegistry } from '../../../src/application/registry/tool-registry.js';
import { ProfileService } from '../../../src/application/profiles/profile-service.js';
import { seedProfilesFromConfig, loadRuntimeProfiles } from '../../../src/application/runtime/runtime-profile-loader.js';
import { registerProfileRoutes } from '../../../src/adapters/inbound/admin/routes/profiles.js';

it('preserves YAML comments, rejects stale revisions, persists flags and deletion across startup', async () => {
 const store = await SplicedockStore.open(':memory:');
 const app = Fastify(); const registry = new ProfileRegistry();
 const log = { info() {}, warn() {} };
 const configured = { workspace: { tools:['*'], enable_code_mode:false, credentials:{} } };
 try {
  await seedProfilesFromConfig(store, configured, log);
  await loadRuntimeProfiles(store, registry, log);
  registerProfileRoutes(app, registry, new ProfileService(registry, new ToolRegistry()), store);
  const current = (await app.inject('/api/v1/profiles/workspace/manifest')).json().data;
  const manifest = '# operator comment\ntools:\n  - "*"\nenable_code_mode: true\ncredentials: {}\n';
  const save = () => app.inject({ method:'PUT', url:'/api/v1/profiles/workspace/manifest', payload:{manifest, base_revision:current.revision} });
  expect((await save()).statusCode).toBe(200);
  expect((await save()).statusCode).toBe(409);
  await seedProfilesFromConfig(store, configured, log);
  const rebooted = new ProfileRegistry(); await loadRuntimeProfiles(store,rebooted,log);
  expect(rebooted.isCodeModeEnabled('workspace')).toBe(true);
  expect((await store.getRuntimeProfile('workspace'))?.manifest_yaml).toBe(manifest);
  expect((await app.inject({method:'DELETE',url:'/api/v1/profiles/workspace'})).statusCode).toBe(204);
  await seedProfilesFromConfig(store,configured,log);
  expect(await store.getRuntimeProfile('workspace')).toBeNull();
 } finally { await app.close(); await store.close(); }
});
