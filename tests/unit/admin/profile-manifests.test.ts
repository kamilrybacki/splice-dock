import { it, expect } from 'vitest';
import Fastify from 'fastify';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { seedProfilesFromConfig, loadRuntimeProfiles } from '../../../src/services/profiles/runtime/loader.js';
import { yamlManifestCodec } from '../../../src/services/profiles/adapters/yaml.js';
import { registerProfileRoutes } from '../../../src/services/admin/adapters/fastify/routes/profiles.js';

it('preserves YAML comments, rejects stale revisions, persists flags and deletion across startup', async () => {
 const store = await SplicedockStore.open(':memory:');
 const app = Fastify(); const registry = new ProfileRegistry();
 const log = { info() {}, warn() {} };
 const configured = { workspace: { tools:['*'], enable_code_mode:false, credentials:{} } };
 try {
  await seedProfilesFromConfig(store, configured, log, yamlManifestCodec);
  await loadRuntimeProfiles(store, registry, log, yamlManifestCodec);
  registerProfileRoutes(app, registry, new ProfileService(registry, new ToolRegistry()), store);
  const current = (await app.inject('/api/v1/profiles/workspace/manifest')).json().data;
  const manifest = '# operator comment\ntools:\n  - "*"\nenable_code_mode: true\ncredentials: {}\n';
  const save = () => app.inject({ method:'PUT', url:'/api/v1/profiles/workspace/manifest', payload:{manifest, base_revision:current.revision} });
  expect((await save()).statusCode).toBe(200);
  expect((await save()).statusCode).toBe(409);
  await seedProfilesFromConfig(store, configured, log, yamlManifestCodec);
  const rebooted = new ProfileRegistry(); await loadRuntimeProfiles(store,rebooted,log, yamlManifestCodec);
  expect(rebooted.isCodeModeEnabled('workspace')).toBe(true);
  expect((await store.getRuntimeProfile('workspace'))?.manifest_yaml).toBe(manifest);
  expect((await app.inject({method:'DELETE',url:'/api/v1/profiles/workspace'})).statusCode).toBe(204);
  await seedProfilesFromConfig(store,configured,log, yamlManifestCodec);
  expect(await store.getRuntimeProfile('workspace')).toBeNull();
 } finally { await app.close(); await store.close(); }
});
