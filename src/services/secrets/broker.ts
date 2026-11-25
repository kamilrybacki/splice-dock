import { logger } from '../../common/logger.js';
import type { CredentialProviderConfig, CredentialStorageConfig } from '../../config/types.js';
import { MemoryCredentialStore } from './memory/store.js';
import type { CredentialAdapters, CredentialProvider, CredentialStore, MintedCredential, MintContext, StoredCredential } from './base.js';

/** Who a credential is minted for. Part of every cache and storage key. */
export interface MintTarget {
  profile: string;
  agent: string | null;
  backend: string;
  /** Caller presented a valid profile-token bearer. Not part of any key. */
  authenticated: boolean;
  /** Non-secret token id, audit only. Not part of any key. */
  tokenId: string | null;
}

const KEY_SEPARATOR = '\u0000';
const MAX_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TTL_MS = 3_600_000;
const PATH_SAFE = /[^A-Za-z0-9_.-]/g;

interface CacheEntry {
  value: string;
  expiresAt: number | undefined;
  provider: string;
  ttlMs: number;
}

let providerConfigs = new Map<string, CredentialProviderConfig>();
let providers = new Map<string, CredentialProvider>();
let store: CredentialStore = new MemoryCredentialStore();
/** L1 the request path reads; L2 is `store`, chosen by the composition root. */
const cache = new Map<string, CacheEntry>();
/** Single-flight: one mint per key however many callers race for it. */
const inflight = new Map<string, Promise<string>>();
/** Mint contexts kept only so a profile deletion can revoke at the provider. */
const minted = new Map<string, { ctx: MintContext; stored: StoredCredential }>();

/**
 * Build the broker from config. Call once at startup, before serving requests.
 * Providers are instantiated per declared `credential_providers` entry.
 */
export function configureCredentialBroker(config: {
  providers: Record<string, CredentialProviderConfig>;
  storage: CredentialStorageConfig;
}, adapters: CredentialAdapters): void {
  providerConfigs = new Map(Object.entries(config.providers));
  providers = new Map();
  for (const [name, providerConfig] of providerConfigs) {
    providers.set(name, adapters.provider(providerConfig));
  }
  store = adapters.store(config.storage);
  resetCredentialCache();
}

/** Drop cached credentials. Test hook; not called on the request path. */
export function resetCredentialCache(): void {
  cache.clear();
  inflight.clear();
  minted.clear();
}

/** Forget configured providers and the store as well. Test hook. */
export function resetCredentialBroker(): void {
  providerConfigs = new Map();
  providers = new Map();
  store = new MemoryCredentialStore();
  resetCredentialCache();
}

/** Current value for (provider, profile, agent, backend), minting only when needed. */
export async function resolveMintedCredential(providerName: string, target: MintTarget): Promise<string> {
  if (target.profile === '') throw new Error('credential_identity_missing');
  // Before the cache, single-flight and store: an unauthenticated session shares
  // keys with untagged bearer tokens of the same profile.
  if (target.authenticated !== true) throw new Error('credential_identity_unauthenticated');
  const providerConfig = providerConfigs.get(providerName);
  const provider = providers.get(providerName);
  if (!providerConfig || !provider) throw new Error('unknown_credential_provider');

  const key = cacheKey(providerName, target);
  const cached = cache.get(key);
  if (cached && isFresh(cached)) return cached.value;

  const running = inflight.get(key);
  if (running) return running;

  const work = (async (): Promise<string> => {
    const stored = await readStored(providerName, target);
    if (stored !== undefined) return stored;
    return mintAndStore(key, providerName, provider, providerConfig, target);
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

/** Best-effort revocation when a profile is deleted: provider revoke, then purge storage. */
export async function revokeProfileCredentials(profile: string): Promise<void> {
  for (const [key, entry] of [...minted]) {
    if (entry.ctx.profile !== profile) continue;
    const provider = providers.get(entry.stored.provider);
    if (provider?.revoke) {
      try {
        await provider.revoke(entry.ctx, entry.stored);
      } catch {
        // Best effort: the local entry goes regardless.
      }
    }
    minted.delete(key);
    cache.delete(key);
  }
  try {
    const removed = await store.deletePrefix(sanitize(profile));
    if (removed > 0) logger.info('purged profile credentials', { profile, removed });
  } catch (err) {
    logger.warn('credential store purge failed', { profile, error: err instanceof Error ? err.message : String(err) });
  }
}

async function readStored(providerName: string, target: MintTarget): Promise<string | undefined> {
  let stored: StoredCredential | undefined;
  try {
    stored = await store.get(entryPath(providerName, target));
  } catch (err) {
    // A read failure must not silently remint on every call, but a broken store
    // must not break credentials either — mint and cache in memory.
    logger.warn('credential store read failed; minting instead', {
      profile: target.profile,
      backend: target.backend,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!stored || stored.value === '') return undefined;
  // Every value this broker writes carries an expiry; an entry without one is
  // foreign or corrupt, so remint rather than trust it indefinitely.
  if (stored.expiresAt === undefined) return undefined;
  const entry: CacheEntry = {
    value: stored.value,
    expiresAt: stored.expiresAt,
    provider: providerName,
    // Fall back to the remaining lifetime only for entries written before
    // ttl_ms was persisted.
    ttlMs: stored.ttlMs ?? Math.max(0, stored.expiresAt - Date.now()),
  };
  if (!isFresh(entry)) return undefined;
  cache.set(cacheKey(providerName, target), entry);
  return stored.value;
}

async function mintAndStore(
  key: string,
  providerName: string,
  provider: CredentialProvider,
  providerConfig: CredentialProviderConfig,
  target: MintTarget,
): Promise<string> {
  const ctx: MintContext = { ...target, provider: providerName, config: providerConfig };
  let mintedCredential: MintedCredential;
  try {
    mintedCredential = await provider.mint(ctx);
  } catch (err) {
    logger.warn('credential mint failed', {
      provider: providerName,
      profile: target.profile,
      agent: target.agent,
      backend: target.backend,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error('credential_unavailable', { cause: err });
  }
  const ttl = ttlMs(providerConfig);
  const expiresAt = mintedCredential.expiresAt ?? Date.now() + ttl;
  const lifetime = Math.max(0, expiresAt - Date.now());
  const stored: StoredCredential = {
    value: mintedCredential.secret,
    expiresAt,
    ttlMs: lifetime,
    provider: providerName,
    ...(mintedCredential.metadata !== undefined && { metadata: mintedCredential.metadata }),
  };
  try {
    await store.put(entryPath(providerName, target), stored);
  } catch (err) {
    // Degrade to memory-only: the credential works here, it just will not be
    // reused after a restart or by another replica.
    logger.warn('credential store write failed; continuing in-memory', {
      provider: providerName,
      profile: target.profile,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  cache.set(key, {
    value: mintedCredential.secret,
    expiresAt,
    provider: providerName,
    // Actual lifetime, not the configured one: a provider may report a shorter
    // expiry than `ttl_seconds`.
    ttlMs: lifetime,
  });
  minted.set(key, { ctx, stored });
  logger.info('credential minted', {
    provider: providerName,
    profile: target.profile,
    agent: target.agent,
    backend: target.backend,
    token_id: target.tokenId,
    expires_at: expiresAt,
  });
  return mintedCredential.secret;
}

function isFresh(entry: CacheEntry): boolean {
  if (entry.expiresAt === undefined) return false;
  // Refresh at 10% of the lifetime early, capped at a minute so long-lived
  // tokens are not refreshed far too eagerly.
  const skew = Math.min(MAX_REFRESH_SKEW_MS, Math.floor(entry.ttlMs / 10));
  return entry.expiresAt - Date.now() > skew;
}

function ttlMs(config: CredentialProviderConfig | undefined): number {
  return config?.type === 'command' ? config.ttl_seconds * 1000 : DEFAULT_TTL_MS;
}

function cacheKey(providerName: string, target: MintTarget): string {
  return [target.profile, target.agent ?? '', target.backend, providerName].join(KEY_SEPARATOR);
}

function entryPath(providerName: string, target: MintTarget): string {
  const segments = [target.profile, target.backend, target.agent ?? '_', providerName].map(sanitize);
  return segments.join('/');
}

function sanitize(segment: string): string {
  return segment.replace(PATH_SAFE, '_');
}
