import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheSync, coalesce } from '../../../src/services/runtime/base.js';
import type { RuntimeFingerprint } from '../../../src/services/database/adapters/store.js';
import type { InvalidationBus, InvalidationMessage, MessageHandler, ResyncHandler } from '../../../src/contracts/outbound/invalidation/bus.js';

const quiet = { info: () => {}, warn: () => {} };
const fp = (tools = 't1', profiles = 'p1', policy = 'o1'): RuntimeFingerprint => ({ tools, profiles, policy });

class FakeBus implements InvalidationBus {
  readonly replicaId = 'self';
  messages: MessageHandler[] = [];
  resyncs: ResyncHandler[] = [];
  onMessage(h: MessageHandler): void { this.messages.push(h); }
  onResync(h: ResyncHandler): void { this.resyncs.push(h); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async publish(): Promise<void> {}
  emit(m: InvalidationMessage): void { for (const h of this.messages) void h(m); }
  async resync(): Promise<void> { for (const h of this.resyncs) await h(); }
}

function makeSync(overrides: Partial<ConstructorParameters<typeof CacheSync>[0]> = {}) {
  const deps = {
    reloadTools: vi.fn(async () => {}),
    reloadProfiles: vi.fn(async () => {}),
    invalidatePolicy: vi.fn(),
    fingerprint: vi.fn(async () => fp()),
    log: quiet,
    reconcileIntervalMs: 1000,
    ...overrides,
  };
  return { sync: new CacheSync(deps), deps };
}

describe('coalesce', () => {
  it('runs once more (not N times) for calls made while running, and never overlaps', async () => {
    let active = 0; let maxActive = 0; let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = coalesce(async () => {
      active += 1; maxActive = Math.max(maxActive, active); runs += 1;
      if (runs === 1) await gate;
      active -= 1;
    }, () => {});
    const first = run();
    const burst = [run(), run(), run()];
    release();
    await Promise.all([first, ...burst]);
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('reports failure as false and reports the error', async () => {
    const onError = vi.fn();
    const run = coalesce(async () => { throw new Error('x'); }, onError);
    await expect(run()).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('CacheSync bus wiring', () => {
  it('maps message kinds to the matching reload / invalidate', async () => {
    const { sync, deps } = makeSync();
    const bus = new FakeBus();
    sync.attach(bus);

    await sync.applyMessage({ kind: 'tools', key: 'x', origin: 'B' });
    expect(deps.reloadTools).toHaveBeenCalledTimes(1);
    expect(deps.reloadProfiles).not.toHaveBeenCalled();

    await sync.applyMessage({ kind: 'profiles', origin: 'B' });
    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);

    await sync.applyMessage({ kind: 'policy', key: 'gh__run', origin: 'B' });
    expect(deps.invalidatePolicy).toHaveBeenCalledWith('gh__run');
  });

  it('a resync reloads tools and profiles and clears the policy cache', async () => {
    const { sync, deps } = makeSync();
    const bus = new FakeBus();
    sync.attach(bus);
    await bus.resync();
    expect(deps.reloadTools).toHaveBeenCalledTimes(1);
    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
    expect(deps.invalidatePolicy).toHaveBeenCalledTimes(1);
  });

  it('a failing reload is contained (does not reject)', async () => {
    const { sync } = makeSync({ reloadTools: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(sync.applyMessage({ kind: 'tools', origin: 'B' })).resolves.toBeUndefined();
  });
});

describe('CacheSync baseline and failure handling', () => {
  it('a bus-driven reload advances the baseline so reconcile does not reload again', async () => {
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockResolvedValue(fp());
    const { sync, deps } = makeSync({ fingerprint });
    await sync.prime();
    fingerprint.mockResolvedValue(fp('t2'));
    await sync.applyMessage({ kind: 'tools', origin: 'B' });
    expect(deps.reloadTools).toHaveBeenCalledTimes(1);
    await sync.reconcile();
    expect(deps.reloadTools).toHaveBeenCalledTimes(1);
  });

  it('takes the fingerprint before reloading, so a write during the reload is still detected', async () => {
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockResolvedValue(fp());
    const { sync, deps } = makeSync({
      fingerprint,
      reloadTools: vi.fn(async () => { fingerprint.mockResolvedValue(fp('t3')); }),
    });
    await sync.prime();
    await sync.applyMessage({ kind: 'tools', origin: 'B' });
    await sync.reconcile();
    expect(deps.reloadTools).toHaveBeenCalledTimes(2);
  });

  it('reconciles immediately when a bus-driven reload fails', async () => {
    const reloadTools = vi.fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(undefined);
    const { sync } = makeSync({ reloadTools });
    await sync.prime();
    await sync.applyMessage({ kind: 'tools', origin: 'B' });
    await vi.waitFor(() => expect(reloadTools).toHaveBeenCalledTimes(2));
  });
});

describe('CacheSync reconcile', () => {
  it('does nothing when the fingerprint matches the primed baseline', async () => {
    const { sync, deps } = makeSync();
    await sync.prime();
    await sync.reconcile();
    expect(deps.reloadTools).not.toHaveBeenCalled();
    expect(deps.reloadProfiles).not.toHaveBeenCalled();
    expect(deps.invalidatePolicy).not.toHaveBeenCalled();
  });

  it('reloads only the kinds that changed', async () => {
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockResolvedValue(fp());
    const { sync, deps } = makeSync({ fingerprint });
    await sync.prime();

    fingerprint.mockResolvedValue(fp('t2'));
    await sync.reconcile();
    expect(deps.reloadTools).toHaveBeenCalledTimes(1);
    expect(deps.reloadProfiles).not.toHaveBeenCalled();
    expect(deps.invalidatePolicy).not.toHaveBeenCalled();

    fingerprint.mockResolvedValue(fp('t2', 'p1', 'o2'));
    await sync.reconcile();
    expect(deps.invalidatePolicy).toHaveBeenCalledTimes(1);
    expect(deps.reloadTools).toHaveBeenCalledTimes(1); // baseline advanced past t2
  });

  it('reloads everything on the first tick when priming failed', async () => {
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockRejectedValueOnce(new Error('down')).mockResolvedValue(fp());
    const { sync, deps } = makeSync({ fingerprint });
    await sync.prime();
    await sync.reconcile();
    expect(deps.reloadTools).toHaveBeenCalledTimes(1);
    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
    expect(deps.invalidatePolicy).toHaveBeenCalledTimes(1);
  });

  it('keeps the old baseline when the fingerprint query fails', async () => {
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockResolvedValue(fp());
    const { sync, deps } = makeSync({ fingerprint });
    await sync.prime();
    fingerprint.mockRejectedValueOnce(new Error('down'));
    await expect(sync.reconcile()).resolves.toBeUndefined();
    expect(deps.reloadTools).not.toHaveBeenCalled();
  });

  it('retries a kind whose reload failed instead of advancing the baseline', async () => {
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockResolvedValue(fp());
    const reloadTools = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('db blip')).mockResolvedValue(undefined);
    const { sync } = makeSync({ fingerprint, reloadTools });
    await sync.prime();
    fingerprint.mockResolvedValue(fp('t2'));

    await sync.reconcile();
    expect(reloadTools).toHaveBeenCalledTimes(1);
    await sync.reconcile();
    expect(reloadTools).toHaveBeenCalledTimes(2);
    await sync.reconcile();
    expect(reloadTools).toHaveBeenCalledTimes(2); // converged
  });
});

describe('CacheSync timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls on the interval until stopped, and start is idempotent', async () => {
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockResolvedValue(fp());
    const { sync } = makeSync({ fingerprint });
    sync.startReconcile();
    sync.startReconcile();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fingerprint).toHaveBeenCalledTimes(3);

    sync.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprint).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restart after stop()', async () => {
    const { sync } = makeSync();
    sync.stop();
    sync.startReconcile();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A message as another replica would publish it. */
const fromSibling = (kind: InvalidationMessage['kind'], key?: string): InvalidationMessage => ({ kind, key, origin: 'sibling' });

describe('CacheSync local purge for a deleted profile', () => {
  /** Registry stand-in: `reloadProfiles` applies the sibling's change to this set. */
  function withRegistry(initial: string[]) {
    const registry = new Set(initial);
    const forgetProfile = vi.fn<(name: string) => void>();
    const warn = vi.fn();
    const { sync, deps } = makeSync({
      hasProfile: (name: string) => registry.has(name),
      forgetProfile,
      log: { info: () => {}, warn },
    });
    return { registry, forgetProfile, warn, sync, deps };
  }

  it('forgets the profile once the reload shows it is gone', async () => {
    const { registry, forgetProfile, sync, deps } = withRegistry(['worker']);
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('worker'); });

    await sync.applyMessage(fromSibling('profiles', 'worker'));

    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
    expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker');
  });

  it('keeps credentials when the profile was updated and still exists', async () => {
    const { forgetProfile, sync, deps } = withRegistry(['worker']);

    await sync.applyMessage(fromSibling('profiles', 'worker'));

    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
    expect(forgetProfile).not.toHaveBeenCalled();
  });

  it('does nothing for an unkeyed profiles message', async () => {
    const { forgetProfile, sync } = withRegistry([]);
    await sync.applyMessage(fromSibling('profiles'));
    expect(forgetProfile).not.toHaveBeenCalled();
  });

  it('does not purge for tools or policy messages', async () => {
    const { forgetProfile, sync } = withRegistry([]);
    await sync.applyMessage(fromSibling('tools', 'worker'));
    await sync.applyMessage(fromSibling('policy', 'worker'));
    expect(forgetProfile).not.toHaveBeenCalled();
  });

  it('skips the purge and warns when the profiles reload failed', async () => {
    const { forgetProfile, warn, sync, deps } = withRegistry([]);
    deps.reloadProfiles.mockRejectedValue(new Error('db down'));

    await expect(sync.applyMessage(fromSibling('profiles', 'worker'))).resolves.toBeUndefined();

    expect(forgetProfile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'cache sync: profile reload failed, skipping local credential purge',
      { profile: 'worker' },
    );
  });

  it('logs a warning and does not reject when the purge throws', async () => {
    const { forgetProfile, warn, sync } = withRegistry([]);
    forgetProfile.mockImplementation(() => { throw new Error('boom'); });

    await expect(sync.applyMessage(fromSibling('profiles', 'worker'))).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'cache sync: local credential purge failed',
      { profile: 'worker', error: 'boom' },
    );
  });

  it('works end to end through the bus', async () => {
    const { registry, forgetProfile, sync, deps } = withRegistry(['worker']);
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('worker'); });
    const bus = new FakeBus();
    sync.attach(bus);

    bus.emit(fromSibling('profiles', 'worker'));
    await vi.waitFor(() => expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker'));
  });

  it('is inert when the purge callbacks are not wired', async () => {
    const { sync, deps } = makeSync();
    await expect(sync.applyMessage(fromSibling('profiles', 'worker'))).resolves.toBeUndefined();
    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
  });
});
