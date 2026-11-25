import type { SplicedockConfig } from './config/types.js';
import { logger } from './common/logger.js';
import { createInvalidationBus } from './services/database/adapters/invalidation/bus.js';
import type { SplicedockStore } from './services/database/adapters/store.js';
import { yamlManifestCodec } from './services/profiles/adapters/yaml.js';
import type { ProfileRegistry } from './services/profiles/registry.js';
import type { CredentialBroker } from './services/secrets/base.js';
import { resyncRuntimeProfiles } from './services/profiles/runtime/loader.js';
import { CacheSync } from './services/runtime/base.js';
import type { ToolService } from './services/tools/base.js';
import type { ToolRegistry } from './services/tools/registry.js';
import { resyncRuntimeTools } from './services/tools/runtime/loader.js';
import { invalidatePolicyForTool } from './services/tools/adapters/cli/passthrough.js';
import type { McpUpstreamManager } from './services/upstreams/base.js';

type InvalidationBus = ReturnType<typeof createInvalidationBus>;

export interface CacheSyncDeps {
  readonly store: SplicedockStore;
  readonly dbTarget: string;
  readonly config: SplicedockConfig;
  readonly toolRegistry: ToolRegistry;
  readonly toolService: ToolService;
  readonly profileRegistry: ProfileRegistry;
  readonly upstreams: McpUpstreamManager;
  /** Broker whose local per-profile state is dropped when a sibling deletes a profile. */
  readonly credentials: CredentialBroker;
}

/** Cross-replica cache invalidation (a no-op on SQLite). Order matters: record
 *  the DB digests and start listening BEFORE the initial load, so a change
 *  committed by a sibling during startup is picked up by the first reconcile
 *  or a bus message instead of falling in the gap. */
export async function createCacheSync(deps: CacheSyncDeps): Promise<{ invalidationBus: InvalidationBus; cacheSync: CacheSync }> {
  const { store, config } = deps;
  const invalidationBus = createInvalidationBus({
    dbTarget: deps.dbTarget,
    isPostgres: store.isPostgres,
    publishVia: (channel, payload) => store.notify(channel, payload),
  });
  const cacheSync = new CacheSync({
    reloadTools: async () => {
      await resyncRuntimeTools(store, deps.toolRegistry, deps.toolService, logger, config.server.cli_whitelist);
      await deps.upstreams.syncFromStore();
    },
    reloadProfiles: () => resyncRuntimeProfiles(store, deps.profileRegistry, logger, yamlManifestCodec),
    invalidatePolicy: tool => invalidatePolicyForTool(tool ?? '*'),
    fingerprint: () => store.runtimeFingerprint(),
    hasProfile: name => deps.profileRegistry.getProfile(name) !== undefined,
    listProfiles: () => deps.profileRegistry.getAllProfiles().map(p => p.name),
    // This replica's own state only (cache, mint records, and a provider revoke of
    // what it minted itself): the replica that served the delete purged the shared
    // store, so this never calls deletePrefix.
    forgetProfile: name => deps.credentials.forgetProfile(name),
    log: logger,
  });
  if (store.isPostgres) {
    await cacheSync.prime();
    cacheSync.attach(invalidationBus);
    await invalidationBus.start();
  }
  return { invalidationBus, cacheSync };
}
