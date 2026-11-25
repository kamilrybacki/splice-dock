import { logger } from '../../common/logger.js';
import type { CredentialProviderConfig, CredentialStorageConfig } from '../../config/types.js';
import type {
  CredentialAdapters, CredentialBroker, CredentialProvider, CredentialStore, MintedCredential, MintContext, MintTarget,
  StoredCredential, StoredCredentialEntry,
} from './base.js';
import { credentialCacheKey, credentialEntryPath, parseCredentialEntryPath, profileKeyPrefix, sanitizePathSegment } from './keys.js';
import { RevokeRetrier } from './revoke-retry.js';

const MAX_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_TTL_MS = 86_400_000;
// Replicas share the store but not a clock; an entry a writer capped exactly at
// its cap must not look over-long to a reader whose clock runs slightly behind.
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
/** First backoff window after a failed mint; doubles on each consecutive failure. */
export const MINT_BACKOFF_BASE_MS = 1_000;
/** Ceiling for the backoff window. Jitter only ever shortens a window, never exceeds this. */
export const MINT_BACKOFF_MAX_MS = 60_000;
/** Largest fraction of a window that jitter may remove, so retries do not align. */
const MINT_BACKOFF_JITTER_RATIO = 0.25;

/** Raised instead of calling the provider while a key is backing off after a failed mint. */
export class CredentialMintBackoffError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('credential_mint_backoff');
    this.name = 'CredentialMintBackoffError';
  }
}

interface MintFailure {
  /** Consecutive failed mints for the key; reset by a successful mint. */
  failures: number;
  /** Epoch ms before which the provider is not called again. */
  until: number;
}

/** A credential that can be revoked at its provider, with the context the provider needs. */
interface RevocableCredential {
  readonly ctx: MintContext;
  readonly stored: StoredCredential;
}

/** What this replica remembers of a credential it minted. */
interface MintRecord extends RevocableCredential {
  /** Where the credential was written in the store; undefined when the write failed. */
  readonly path: string | undefined;
}

/** Outcome of deleting one store entry only if it still holds the expected value. */
type RemoveOutcome = 'removed' | 'absent' | 'failed';

interface CacheEntry {
  value: string;
  expiresAt: number | undefined;
  provider: string;
  ttlMs: number;
}


export interface CredentialBrokerConfig {
  providers: Record<string, CredentialProviderConfig>;
  storage: CredentialStorageConfig;
}

/**
 * Build a broker from config. Every instance owns its caches, single-flight map,
 * backoff state and providers; nothing is shared through module state, so the
 * composition root decides how many exist and who gets which.
 * Providers are instantiated per declared `credential_providers` entry.
 */
export function createCredentialBroker(config: CredentialBrokerConfig, adapters: CredentialAdapters): CredentialBroker {
  const providers = new Map<string, CredentialProvider>();
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    providers.set(name, adapters.provider(providerConfig));
  }
  return new MintingCredentialBroker(new Map(Object.entries(config.providers)), providers, adapters.store(config.storage));
}

class MintingCredentialBroker implements CredentialBroker {
  /** L1 the request path reads; L2 is `store`, chosen by the composition root. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Single-flight: one mint per key however many callers race for it. */
  private readonly inflight = new Map<string, Promise<string>>();
  /**
   * Negative cache: keys whose last mint failed, same key as L1. Holds no error
   * object (a provider error may echo command output), only the retry state.
   */
  private readonly mintFailures = new Map<string, MintFailure>();
  /**
   * Per-profile generation, bumped by every forget/revoke of that profile. A mint
   * or store read that began under an older generation must not write to L1,
   * `minted`, the backoff map or the shared store afterwards, or the cleanup would
   * be undone. Entries are never removed: resetting one to 0 would let a stale
   * capture match again. One small integer per profile name is the cost.
   */
  private readonly generations = new Map<string, number>();
  /** Mint contexts kept only so a profile deletion can revoke at the provider. */
  private readonly minted = new Map<string, MintRecord>();
  /** Background retries of provider revokes that failed. */
  private readonly retrier = new RevokeRetrier();

  constructor(
    private readonly providerConfigs: ReadonlyMap<string, CredentialProviderConfig>,
    private readonly providers: ReadonlyMap<string, CredentialProvider>,
    private readonly store: CredentialStore,
  ) {}

  async resolve(providerName: string, target: MintTarget): Promise<string> {
    if (target.profile === '') throw new Error('credential_identity_missing');
    // Before the cache, single-flight and store: an unauthenticated session shares
    // keys with untagged bearer tokens of the same profile.
    if (target.authenticated !== true) throw new Error('credential_identity_unauthenticated');
    const providerConfig = this.providerConfigs.get(providerName);
    const provider = this.providers.get(providerName);
    if (!providerConfig || !provider) throw new Error('unknown_credential_provider');

    const key = credentialCacheKey(providerName, target);
    const cached = this.cache.get(key);
    if (cached && isFresh(cached)) return cached.value;

    // After the identity checks and the L1 hit: a fresh credential is still served
    // while the key is backing off, but a failed mint is not retried early.
    this.assertNotBackingOff(key);

    const running = this.inflight.get(key);
    if (running) return running;

    const work = (async (): Promise<string> => {
      // Captured before any await: a forget/revoke that lands while this call is
      // reading the store or minting makes the result stale (see `isCurrent`).
      const generation = this.generation(target.profile);
      const stored = await this.readStored(providerName, providerConfig, target, generation);
      if (stored !== undefined) return stored;
      return this.mintAndStore(key, providerName, provider, providerConfig, target, generation);
    })();
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  async revokeProfile(profile: string): Promise<void> {
    // Local state first (synchronously, see `dropLocalState`). The shared store is
    // listed before it is purged: the entries are the only record of credentials a
    // replica that has since restarted minted, and they are gone after the purge.
    const own = this.dropLocalState(profile);
    const deleteStartedAt = Date.now();
    const listed = await this.listStored(profile);
    if (listed === undefined) {
      // Purging what could not be listed would delete the only record of those
      // credentials without revoking them, so nothing else is touched now. The
      // listing is retried in the background (see `cleanUpStored`).
      const revoked = await this.revokeAll(await this.ownToRevoke(own));
      this.retrier.retry(() => this.cleanUpStored(profile, deleteStartedAt, revoked), {
        provider: '*', profile, operation: 'credential store cleanup',
      });
      return;
    }
    await this.purgeListed(profile, listed);
    await this.revokeAll([...own, ...listed.flatMap(entry => this.rebuildRevocable(profile, entry))]);
  }

  async forgetProfile(profile: string): Promise<void> {
    const own = this.dropLocalState(profile);
    await this.revokeAll(await this.ownToRevoke(own));
  }

  /**
   * The mint records this replica still has to revoke itself. The serving replica
   * deletes, one by one, exactly the entries it listed, and revokes each of them; so
   * an entry of ours that is gone (or now holds another value) was listed and revoked
   * there. One that is still present was written after that listing, or the listing
   * has not happened yet: it is deleted here and revoked here. When both replicas race
   * on the same entry a credential may be revoked twice, never zero times. A record
   * whose store write failed, or whose entry cannot be checked, is revoked too.
   */
  private async ownToRevoke(own: readonly MintRecord[]): Promise<MintRecord[]> {
    const pending: MintRecord[] = [];
    for (const record of own) {
      if (record.path === undefined) {
        pending.push(record);
        continue;
      }
      const outcome = await this.removeIfUnchanged(record.path, record.stored.value, record.ctx.profile);
      if (outcome !== 'absent') pending.push(record);
    }
    return pending;
  }

  /**
   * Background retry after the serving replica could not list the store. Revokes and
   * deletes only entries issued before the delete started: a later entry may belong to
   * a profile recreated under the same name since. Entries a sibling minted while the
   * delete ran are handled by that sibling's `forgetProfile`. Throws when the listing
   * fails again, so the retrier tries once more.
   */
  private async cleanUpStored(profile: string, deleteStartedAt: number, revoked: Set<string>): Promise<void> {
    const entries = await this.store.listPrefix(sanitizePathSegment(profile));
    const old = entries.filter(entry => issuedAt(entry.credential) <= deleteStartedAt);
    await this.purgeListed(profile, old);
    await this.revokeAll(old.flatMap(entry => this.rebuildRevocable(profile, entry)), revoked);
  }

  /**
   * Forget everything this replica holds for a profile and return its mint records.
   * Synchronous, so two concurrent forgets cannot both see (and revoke) the same
   * record, and a mint that resolves while the revokes are running already sees the
   * new generation.
   */
  private dropLocalState(profile: string): MintRecord[] {
    this.generations.set(profile, this.generation(profile) + 1);
    // Match on the key prefix: a replica that only read the credential from the
    // shared store has an L1 entry but no `minted` record, and a failed mint has
    // backoff state but neither.
    const prefix = profileKeyPrefix(profile);
    const own: MintRecord[] = [];
    for (const [key, record] of [...this.minted]) {
      if (key.startsWith(prefix)) own.push(record);
    }
    for (const map of [this.cache, this.minted, this.mintFailures] as ReadonlyArray<Map<string, unknown>>) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
    return own;
  }

  /** Every entry the shared store holds for the profile, or undefined (logged) when the listing failed. */
  private async listStored(profile: string): Promise<StoredCredentialEntry[] | undefined> {
    try {
      return await this.store.listPrefix(sanitizePathSegment(profile));
    } catch (err) {
      logger.warn('credential store listing failed', { profile, error_class: errorClass(err) });
      return undefined;
    }
  }

  /**
   * Delete exactly the listed entries, each only while it still holds the listed
   * value. Not a prefix delete: an entry written after the listing must stay, so the
   * replica that wrote it can tell it was never revoked (see `ownToRevoke`).
   */
  private async purgeListed(profile: string, entries: readonly StoredCredentialEntry[]): Promise<void> {
    let removed = 0;
    for (const entry of entries) {
      if (await this.removeIfUnchanged(entry.path, entry.credential.value, profile) === 'removed') removed += 1;
    }
    if (removed > 0) logger.info('purged profile credentials', { profile, removed });
  }

  /** Delete a store entry only if it still holds `value`. A failure is logged without the path or value. */
  private async removeIfUnchanged(path: string, value: string, profile: string): Promise<RemoveOutcome> {
    try {
      const current = await this.store.get(path);
      if (current?.value !== value) return 'absent';
      await this.store.delete(path);
      return 'removed';
    } catch (err) {
      logger.warn('credential store purge failed', { profile, error_class: errorClass(err) });
      return 'failed';
    }
  }

  /**
   * The context a provider needs to revoke a stored entry, rebuilt from its path and
   * value. Exact for the profile, provider and the unsanitized parts; backend and
   * agent are as sanitized as they were stored. An entry that cannot be rebuilt is
   * skipped (it is still purged) and logged without its path or value.
   */
  private rebuildRevocable(profile: string, entry: StoredCredentialEntry): RevocableCredential[] {
    const parsed = parseCredentialEntryPath(entry.path);
    const config = this.providerConfigs.get(entry.credential.provider);
    const reason =
      parsed === undefined || parsed.profile !== sanitizePathSegment(profile) ? 'unrecognised_path'
        : config === undefined ? 'unknown_provider'
          : undefined;
    if (reason !== undefined || parsed === undefined || config === undefined) {
      logger.warn('skipped unrevocable credential store entry', { profile, reason: reason ?? 'unrecognised_path' });
      return [];
    }
    const ctx: MintContext = {
      profile, agent: parsed.agent, backend: parsed.backend, authenticated: false, tokenId: null,
      provider: entry.credential.provider, config,
    };
    return [{ ctx, stored: entry.credential }];
  }

  /**
   * Revoke each distinct credential once, in order, skipping those already in `seen`.
   * Earlier entries carry the exact mint context, so they win a tie. Returns `seen`,
   * now holding every credential revoked (or attempted) here.
   */
  private async revokeAll(candidates: readonly RevocableCredential[], seen = new Set<string>()): Promise<Set<string>> {
    for (const { ctx, stored } of candidates) {
      // Identity is provider + value; held in memory only, never logged.
      const identity = `${stored.provider}\u0000${stored.value}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      await this.revokeAtProvider(ctx, stored);
    }
    return seen;
  }

  close(): void {
    this.retrier.close();
  }

  private generation(profile: string): number {
    return this.generations.get(profile) ?? 0;
  }

  /** False once the profile was forgotten/revoked after `generation` was captured. */
  private isCurrent(profile: string, generation: number): boolean {
    return this.generation(profile) === generation;
  }

  /**
   * Rejected instead of returning the secret: the caller's profile was deleted while
   * its call was in flight, and a credential that is being revoked is no use to it.
   * Reuses `credential_unavailable`, the code every caller already maps.
   */
  private staleResult(): Error {
    return new Error('credential_unavailable', { cause: new Error('profile_credentials_revoked') });
  }

  /** Best effort: a provider that cannot revoke, or fails to, never blocks the local cleanup. */
  private async revokeAtProvider(ctx: MintContext, stored: StoredCredential): Promise<void> {
    const provider = this.providers.get(stored.provider);
    const revoke = provider?.revoke?.bind(provider);
    if (!revoke) return;
    const attempt = (): Promise<void> => revoke(ctx, stored);
    try {
      await attempt();
    } catch (err) {
      // The provider's error text may echo what it was asked to revoke, so only its class is logged.
      logger.warn('credential provider revoke failed', {
        provider: stored.provider,
        profile: ctx.profile,
        error_class: errorClass(err),
      });
      // Detached: the retries run on unref'd timers and are never awaited.
      this.retrier.retry(attempt, { provider: stored.provider, profile: ctx.profile });
    }
  }

  /**
   * A mint resolved after its profile was forgotten: nothing was cached or recorded.
   * Delete the shared-store entry if the write already happened, and revoke the
   * credential at the provider.
   */
  private async discardStaleMint(ctx: MintContext, stored: StoredCredential, storedPath: string | undefined): Promise<void> {
    if (storedPath !== undefined) {
      try {
        await this.store.delete(storedPath);
      } catch (err) {
        logger.warn('credential store cleanup failed after revoke', {
          profile: ctx.profile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.revokeAtProvider(ctx, stored);
    logger.info('discarded credential minted while its profile was being deleted', { profile: ctx.profile, provider: ctx.provider });
  }

  private async readStored(
    providerName: string,
    providerConfig: CredentialProviderConfig,
    target: MintTarget,
    generation: number,
  ): Promise<string | undefined> {
    let stored: StoredCredential | undefined;
    try {
      stored = await this.store.get(credentialEntryPath(providerName, target));
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
    // The profile was deleted while the read was in flight: whatever it returned
    // may be the entry the delete just purged, so it must not reach L1.
    if (!this.isCurrent(target.profile, generation)) throw this.staleResult();
    if (!stored || stored.value === '') return undefined;
    // Every value this broker writes carries an expiry; an entry without one is
    // foreign or corrupt, so remint rather than trust it indefinitely.
    if (stored.expiresAt === undefined) return undefined;
    // Every value this broker writes lives at most max_ttl from the moment it was
    // minted, and records that lifetime as ttlMs. Judge the lifetime it was issued
    // with (independent of any clock), so an old entry that merely has little time
    // left still fails a cap it was never allowed to exceed. Entries written
    // before the cap existed or under a looser one are reminted: capping them at
    // now + max_ttl would move their deadline forward on every restart.
    const maxMs = maxTtlMs(providerConfig);
    const issuedLifetime = stored.ttlMs;
    const remaining = stored.expiresAt - Date.now();
    // An entry that records no lifetime cannot be shown to respect the cap.
    if (issuedLifetime === undefined || issuedLifetime > maxMs || remaining > maxMs + CLOCK_SKEW_TOLERANCE_MS) {
      logger.warn('credential store entry exceeds max_ttl; reminting', {
        provider: providerName,
        profile: target.profile,
        backend: target.backend,
        expires_at: stored.expiresAt,
        max_ttl_seconds: maxMs / 1000,
      });
      return undefined;
    }
    const entry: CacheEntry = {
      value: stored.value,
      expiresAt: stored.expiresAt,
      provider: providerName,
      ttlMs: issuedLifetime,
    };
    if (!isFresh(entry)) return undefined;
    this.cache.set(credentialCacheKey(providerName, target), entry);
    return stored.value;
  }

  private async mintAndStore(
    key: string,
    providerName: string,
    provider: CredentialProvider,
    providerConfig: CredentialProviderConfig,
    target: MintTarget,
    generation: number,
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
      if (this.isCurrent(target.profile, generation)) this.recordMintFailure(key);
      throw new Error('credential_unavailable', { cause: err });
    }
    const now = Date.now();
    const reportedExpiresAt = mintedCredential.expiresAt ?? now + ttlMs(providerConfig);
    const maxMs = maxTtlMs(providerConfig);
    const expiresAt = Math.min(reportedExpiresAt, now + maxMs);
    if (expiresAt < reportedExpiresAt) {
      logger.warn('credential lifetime capped', {
        provider: providerName,
        profile: target.profile,
        agent: target.agent,
        backend: target.backend,
        token_id: target.tokenId,
        reported_expires_at: reportedExpiresAt,
        expires_at: expiresAt,
        max_ttl_seconds: maxMs / 1000,
      });
    }
    const lifetime = Math.max(0, expiresAt - now);
    const stored: StoredCredential = {
      value: mintedCredential.secret,
      expiresAt,
      ttlMs: lifetime,
      provider: providerName,
      ...(mintedCredential.metadata !== undefined && { metadata: mintedCredential.metadata }),
    };
    // The profile was forgotten while the provider was minting: the credential is
    // not cached, recorded or written to the shared store, and is revoked instead.
    if (!this.isCurrent(target.profile, generation)) {
      await this.discardStaleMint(ctx, stored, undefined);
      throw this.staleResult();
    }
    const storedPath = credentialEntryPath(providerName, target);
    let written = false;
    try {
      await this.store.put(storedPath, stored);
      written = true;
    } catch (err) {
      // Degrade to memory-only: the credential works here, it just will not be
      // reused after a restart or by another replica.
      logger.warn('credential store write failed; continuing in-memory', {
        provider: providerName,
        profile: target.profile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Re-checked after the write: a forget during `store.put` already ran its purge
    // before the entry existed, so the entry is deleted here.
    if (!this.isCurrent(target.profile, generation)) {
      await this.discardStaleMint(ctx, stored, written ? storedPath : undefined);
      throw this.staleResult();
    }
    this.mintFailures.delete(key);
    this.cache.set(key, {
      value: mintedCredential.secret,
      expiresAt,
      provider: providerName,
      // Actual lifetime, not the configured one: a provider may report a shorter
      // expiry than `ttl_seconds`.
      ttlMs: lifetime,
    });
    this.minted.set(key, { ctx, stored, path: written ? storedPath : undefined });
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

  private assertNotBackingOff(key: string): void {
    const failure = this.mintFailures.get(key);
    if (!failure) return;
    const now = Date.now();
    if (now < failure.until) throw new CredentialMintBackoffError(failure.until - now);
    // Past the window the provider may be called again; the streak is kept so the
    // next failure backs off for longer, unless the key has been quiet for so long
    // that the streak is no longer evidence of anything.
    if (now - failure.until > MINT_BACKOFF_MAX_MS) this.mintFailures.delete(key);
  }

  private recordMintFailure(key: string): void {
    const now = Date.now();
    // Keys are not revisited after a profile or agent goes away, so sweep streaks
    // that expired long ago instead of letting them accumulate.
    for (const [other, failure] of this.mintFailures) {
      if (now - failure.until > MINT_BACKOFF_MAX_MS) this.mintFailures.delete(other);
    }
    const failures = (this.mintFailures.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(MINT_BACKOFF_MAX_MS, MINT_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 30));
    const jittered = Math.round(delay * (1 - MINT_BACKOFF_JITTER_RATIO * Math.random()));
    this.mintFailures.set(key, { failures, until: now + jittered });
  }
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

/** Upper bound on a credential's lifetime. Configs built without the schema fall back to the default. */
function maxTtlMs(config: CredentialProviderConfig | undefined): number {
  const seconds = config?.type === 'command' ? config.max_ttl_seconds : undefined;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_MAX_TTL_MS;
}

/** When a stored entry was issued, by its writer's clock; -Infinity when it records no lifetime (treated as old). */
function issuedAt(credential: StoredCredential): number {
  if (credential.expiresAt === undefined || credential.ttlMs === undefined) return Number.NEGATIVE_INFINITY;
  return credential.expiresAt - credential.ttlMs;
}

/** An error's class name, safe to log where its message might not be. */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
