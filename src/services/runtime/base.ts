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
      profiles: coalesce(async () => { await deps.reloadProfiles(); }, (e) => this.reloadFailed('profiles', e)),
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
    await this.reloadKind(msg.kind === 'tools' ? 'tools' : 'profiles');
  }

  async reloadAll(): Promise<void> {
    await Promise.all([this.reloadKind('tools'), this.reloadKind('profiles'), this.reloadKind('policy')]);
  }

  /**
   * Bus/resync-driven reload. The fingerprint is taken BEFORE reloading so the
   * baseline never claims newer state than was actually loaded; on failure the
   * kind is marked stale and a reconcile runs now instead of at the next tick.
   */
  private async reloadKind(kind: Kind): Promise<void> {
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
