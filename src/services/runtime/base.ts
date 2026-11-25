// Keeps this replica's in-process caches (runtime tool registry, profile
// registry, compiled-policy cache) in step with the shared database.
//
// Two triggers, one mechanism:
//   1. the invalidation bus (fast path): a sibling replica committed a change;
//   2. a periodic reconcile (safety net, default 30s): compare cheap digests of
//      the DB state and reload whatever differs, so a lost NOTIFY, a listener
//      outage or a failed publish self-heals.
//
// Reloads are re-reads of the database, never trusting message content, and
// are coalesced per kind so overlapping triggers cannot apply an older
// snapshot after a newer one.

import type { InvalidationBus, InvalidationMessage } from '../../contracts/outbound/invalidation/bus.js';
import type { RuntimeFingerprint } from '../../contracts/outbound/repositories.js';

export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;

export interface CacheSyncLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface CacheSyncDeps {
  readonly reloadTools: () => Promise<unknown>;
  readonly reloadProfiles: () => Promise<unknown>;
  /** Clear cached compiled policy for `tool` (all of it if the cache is global). */
  readonly invalidatePolicy: (tool?: string) => void;
  readonly fingerprint: () => Promise<RuntimeFingerprint>;
  readonly log: CacheSyncLog;
  readonly reconcileIntervalMs?: number;
  /** Whether a profile still exists in this replica's registry (after a reload). */
  readonly hasProfile?: (name: string) => boolean;
  /** Names of the profiles currently in this replica's registry. */
  readonly listProfiles?: () => string[];
  /**
   * Drop this replica's own per-profile state (e.g. credentials) for a profile that
   * no longer exists: called after any `profiles` reload (bus message, resync or
   * reconcile) that made a name disappear, and after a keyed message for a missing
   * profile. May be async; it is not awaited, so a slow provider cannot stall a
   * reload, and a rejection is logged. Must not do the shared cleanup: the replica
   * that served the delete already did it.
   */
  readonly forgetProfile?: (name: string) => void | Promise<void>;
}

type Kind = keyof RuntimeFingerprint;

const EMPTY_FINGERPRINT: RuntimeFingerprint = { tools: '', profiles: '', policy: '' };
/** Never equals a real digest: forces the next reconcile to reload that kind. */
const STALE = '\u0000stale';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `fn` so that calls arriving while it runs trigger exactly one more run
 * afterwards. Resolves to whether the final run succeeded. Never rejects.
 */
export function coalesce(fn: () => Promise<void>, onError: (err: unknown) => void): () => Promise<boolean> {
  let running: Promise<boolean> | null = null;
  let pending = false;
  const loop = async (): Promise<boolean> => {
    let ok: boolean;
    do {
      pending = false;
      try {
        await fn();
        ok = true;
      } catch (err) {
        ok = false;
        onError(err);
      }
    } while (pending);
    return ok;
  };
  return () => {
    if (running) {
      pending = true;
      return running;
    }
    running = loop().finally(() => { running = null; });
    return running;
  };
}

export class CacheSync {
  private readonly reloaders: Record<Kind, () => Promise<boolean>>;
  private readonly intervalMs: number;
  private baseline: RuntimeFingerprint | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly deps: CacheSyncDeps) {
    this.intervalMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.reloaders = {
      tools: coalesce(async () => { await deps.reloadTools(); }, (e) => this.reloadFailed('tools', e)),
      profiles: coalesce(() => this.reloadProfilesAndPurge(), (e) => this.reloadFailed('profiles', e)),
      policy: coalesce(async () => { deps.invalidatePolicy(); }, (e) => this.reloadFailed('policy', e)),
    };
  }

  /** Subscribe to the bus: remote changes reload one kind, a resync reloads all. */
  attach(bus: InvalidationBus): void {
    bus.onMessage((msg) => this.applyMessage(msg));
    bus.onResync(() => this.reloadAll());
  }

  /**
   * Record the DB digests. Call BEFORE the initial load: a write that lands
   * between this and the load then shows up as a diff on the first tick
   * instead of being missed.
   */
  async prime(): Promise<void> {
    try {
      this.baseline = await this.deps.fingerprint();
    } catch (err) {
      this.deps.log.warn('cache sync prime failed — first reconcile will reload everything', { error: errMsg(err) });
    }
  }

  async applyMessage(msg: InvalidationMessage): Promise<void> {
    if (msg.kind === 'policy') {
      // The policy cache is keyed by config object, not tool name, so a keyed
      // invalidation clears it wholesale (same as the local path).
      this.deps.invalidatePolicy(msg.key);
      return;
    }
    if (msg.kind === 'tools') {
      await this.reloadKind('tools');
      return;
    }
    const reloaded = await this.reloadKind('profiles');
    if (msg.key) this.forgetIfDeleted(msg.key, reloaded);
  }

  /**
   * Fallback for a replica without `listProfiles`: after a keyed `profiles` message
   * has been applied, drop this replica's local credential state if the profile is gone. An update leaves the profile in the
   * registry, so its credentials stay. Fails open: a problem is logged, never thrown.
   */
  private forgetIfDeleted(profile: string, reloaded: boolean): void {
    const { hasProfile, forgetProfile, listProfiles } = this.deps;
    // With `listProfiles` wired, the reload itself diffs the registry and forgets the
    // profile (and does so again on the retry if this reload failed), so a keyed
    // check would only repeat it.
    if (listProfiles || !hasProfile || !forgetProfile) return;
    if (!reloaded) {
      // Without a fresh registry we cannot tell a delete from an update. The
      // retry reconcile reloads profiles but carries no key, so this is best effort.
      this.deps.log.warn('cache sync: profile reload failed, skipping local credential purge', { profile });
      return;
    }
    try {
      if (hasProfile(profile)) return;
    } catch (err) {
      this.deps.log.warn('cache sync: local credential purge failed', { profile, error: errMsg(err) });
      return;
    }
    this.forget(profile);
  }

  /**
   * Reload the profile registry and forget every profile that disappeared from it.
   * Runs inside the coalesced profiles reloader, so the bus, the resync and the
   * periodic reconcile all purge, including when the keyed message was lost. The
   * reload's own failure is rethrown (it marks the kind stale and retries); a
   * problem in the purge itself is only logged.
   */
  private async reloadProfilesAndPurge(): Promise<void> {
    const before = this.snapshotProfiles();
    await this.deps.reloadProfiles();
    if (before === null) return;
    const after = this.snapshotProfiles();
    if (after === null) return;
    for (const name of before) {
      if (!after.has(name)) this.forget(name);
    }
  }

  private snapshotProfiles(): Set<string> | null {
    const { listProfiles, forgetProfile } = this.deps;
    if (!listProfiles || !forgetProfile) return null;
    try {
      return new Set(listProfiles());
    } catch (err) {
      this.deps.log.warn('cache sync: listing profiles failed, skipping local credential purge', { error: errMsg(err) });
      return null;
    }
  }

  /** Fire and forget, fail open: neither a throw nor a rejection escapes. */
  private forget(profile: string): void {
    const { forgetProfile } = this.deps;
    if (!forgetProfile) return;
    const warn = (err: unknown): void => {
      this.deps.log.warn('cache sync: local credential purge failed', { profile, error: errMsg(err) });
    };
    try {
      void Promise.resolve(forgetProfile(profile)).catch(warn);
    } catch (err) {
      warn(err);
    }
  }

  async reloadAll(): Promise<void> {
    await Promise.all([this.reloadKind('tools'), this.reloadKind('profiles'), this.reloadKind('policy')]);
  }

  /**
   * Bus/resync-driven reload. The fingerprint is taken BEFORE reloading so the
   * baseline never claims newer state than was actually loaded; on failure the
   * kind is marked stale and a reconcile runs now instead of at the next tick.
   * Resolves to whether the reload succeeded.
   */
  private async reloadKind(kind: Kind): Promise<boolean> {
    let before: RuntimeFingerprint | null = null;
    try {
      before = await this.deps.fingerprint();
    } catch (err) {
      this.deps.log.warn('cache sync: fingerprint before reload failed', { kind, error: errMsg(err) });
    }
    const ok = await this.reloaders[kind]();
    // A null baseline means "reload everything on the next tick" already.
    if (ok && before && this.baseline) {
      this.baseline = { ...this.baseline, [kind]: before[kind] };
    } else if (!ok) {
      if (this.baseline) this.baseline = { ...this.baseline, [kind]: STALE };
      void this.reconcile();
    }
    return ok;
  }

  /** Start the unref'd reconcile poll. Idempotent. */
  startReconcile(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.reconcile(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One reconcile pass. Exposed for tests; never rejects. */
  async reconcile(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.reconcileOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    let current: RuntimeFingerprint;
    try {
      current = await this.deps.fingerprint();
    } catch (err) {
      this.deps.log.warn('cache reconcile: fingerprint failed', { error: errMsg(err) });
      return;
    }
    const kinds = (['tools', 'profiles', 'policy'] as const).filter(
      (k) => this.baseline === null || this.baseline[k] !== current[k],
    );
    if (kinds.length === 0) return;
    this.deps.log.info('cache reconcile: drift detected, reloading', { kinds });
    const results = await Promise.all(kinds.map(async (k) => [k, await this.reloaders[k]()] as const));
    // Only advance the baseline for kinds that reloaded; a failed one is
    // retried on the next tick instead of being forgotten.
    const base: RuntimeFingerprint = this.baseline ?? EMPTY_FINGERPRINT;
    const next = { ...base };
    for (const [k, ok] of results) if (ok) next[k] = current[k];
    this.baseline = next;
  }

  private reloadFailed(kind: Kind, err: unknown): void {
    this.deps.log.warn('cache reload failed', { kind, error: errMsg(err) });
  }
}
