// Seed the persistent profile catalog from splicedock.yaml, then load and
// resynchronize complete YAML manifests into the in-memory registry.
// After seeding the DB is authoritative: file changes never overwrite UI edits.

import type { RuntimeProfileRepository } from '../../../contracts/outbound/repositories.js';
import type { ProfileRegistry, ProfileInput, ProfileSource } from '../registry.js';
import { profileSchema } from '../../../config/schema.js';
import type { ProfileConfig } from '../../../config/types.js';
import { dumpProfileManifest, parseProfileManifest, type ProfileManifestCodec } from '../manifest.js';
import type { LogFields } from '../../../common/logger.js';

const RESYNC_MAX_ATTEMPTS = 3;

export interface RuntimeProfileLoadSummary {
  loaded: number;
  skipped_reserved: number;
  skipped_invalid: number;
}

interface LoaderLog {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
}

interface CollectedProfile extends ProfileInput {
  name: string;
  source?: ProfileSource;
}

interface CollectedProfiles {
  profiles: CollectedProfile[];
  summary: RuntimeProfileLoadSummary;
}

/** Insert config profiles missing from the catalog. A NULL manifest denotes a
 * legacy tools-only row; for a config collision only that row is overwritten
 * once, preserving the pre-catalog rule that config beat shadowed runtime data. */
export async function seedProfilesFromConfig(
  store: RuntimeProfileRepository,
  configured: Record<string, ProfileConfig>,
  log: LoaderLog,
  codec: ProfileManifestCodec,
): Promise<{ inserted: number; migrated_collisions: number }> {
  const current = new Map((await store.listRuntimeProfiles()).map(row => [row.name, row]));
  const summary = { inserted: 0, migrated_collisions: 0 };
  for (const [name, input] of Object.entries(configured)) {
    if (name === '__no_tools__' || await store.isConfigProfileDeleted(name)) continue;
    const parsed = profileSchema.parse(input);
    const existing = current.get(name);
    if (existing && existing.manifest_yaml !== null) continue;
    const result = await store.saveRuntimeProfile(
      name,
      parsed,
      dumpProfileManifest(codec, parsed),
      'config-seed',
      existing?.revision ?? 0,
      'file',
    );
    if (result.status !== 'ok') continue;
    if (existing) summary.migrated_collisions += 1;
    else summary.inserted += 1;
  }
  log.info('profile catalog seeded from config', { ...summary });
  return summary;
}

async function collectRuntimeProfiles(
  store: RuntimeProfileRepository,
  log: LoaderLog,
  codec: ProfileManifestCodec,
): Promise<CollectedProfiles> {
  const summary: RuntimeProfileLoadSummary = { loaded: 0, skipped_reserved: 0, skipped_invalid: 0 };
  const profiles: CollectedProfile[] = [];

  for (const row of await store.listRuntimeProfiles()) {
    if (row.name === '__no_tools__') {
      summary.skipped_reserved += 1;
      log.warn('catalog profile uses a reserved name — skipping', { name: row.name });
      continue;
    }
    try {
      const profile = row.manifest_yaml === null
        ? profileSchema.parse({ tools: row.tools })
        : parseProfileManifest(codec, row.manifest_yaml, row.name).profile;
      profiles.push({
        name: row.name,
        source: row.origin,
        ...profile,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      });
      summary.loaded += 1;
    } catch (error) {
      summary.skipped_invalid += 1;
      log.warn('catalog profile failed re-validation — skipping', {
        name: row.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { profiles, summary };
}

export async function loadRuntimeProfiles(
  store: RuntimeProfileRepository,
  registry: ProfileRegistry,
  log: LoaderLog,
  codec: ProfileManifestCodec,
): Promise<RuntimeProfileLoadSummary> {
  const { profiles, summary } = await collectRuntimeProfiles(store, log, codec);
  for (const profile of profiles) {
    const { name, ...entry } = profile;
    registry.loadCatalogProfile(name, entry);
  }
  log.info('profile catalog loaded', { ...summary });
  return summary;
}

/** Make the registry exactly mirror the DB, including remote deletes and changes. */
export async function resyncRuntimeProfiles(
  store: RuntimeProfileRepository,
  registry: ProfileRegistry,
  log: LoaderLog,
  codec: ProfileManifestCodec,
): Promise<RuntimeProfileLoadSummary> {
  for (let attempt = 0; attempt < RESYNC_MAX_ATTEMPTS; attempt += 1) {
    const before = registry.mutations;
    const { profiles, summary } = await collectRuntimeProfiles(store, log, codec);
    if (registry.mutations !== before) continue;
    registry.replaceCatalogProfiles(profiles);
    log.info('profile catalog resynced', { ...summary });
    return summary;
  }
  log.warn('profile catalog resync skipped: concurrent local writes');
  return { loaded: 0, skipped_reserved: 0, skipped_invalid: 0 };
}
