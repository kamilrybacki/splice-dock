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
    const forgetProfile = vi.fn<(name: string) => void | Promise<void>>();
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

describe('CacheSync purge by registry diff (missed delete notification)', () => {
  function withListedRegistry(initial: string[]) {
    const registry = new Set(initial);
    const forgetProfile = vi.fn<(name: string) => void | Promise<void>>();
    const warn = vi.fn();
    const fingerprint = vi.fn<() => Promise<RuntimeFingerprint>>().mockResolvedValue(fp());
    const { sync, deps } = makeSync({
      hasProfile: (name: string) => registry.has(name),
      listProfiles: () => [...registry],
      forgetProfile,
      fingerprint,
      log: { info: () => {}, warn },
    });
    return { registry, forgetProfile, warn, fingerprint, sync, deps };
  }

  it('the periodic reconcile purges a profile removed while the keyed message was missed', async () => {
    const { registry, forgetProfile, fingerprint, sync, deps } = withListedRegistry(['worker', 'other']);
    await sync.prime();
    // A sibling deletes the profile; this replica never receives the message.
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('worker'); });
    fingerprint.mockResolvedValue(fp('t1', 'p2'));

    await sync.reconcile();

    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
    expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker');
  });

  it('a resync purges a removed profile', async () => {
    const { registry, forgetProfile, sync, deps } = withListedRegistry(['worker']);
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('worker'); });
    const bus = new FakeBus();
    sync.attach(bus);

    await bus.resync();

    expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker');
  });

  it('forgets once for a keyed delete message, not once per mechanism', async () => {
    const { registry, forgetProfile, sync, deps } = withListedRegistry(['worker']);
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('worker'); });

    await sync.applyMessage(fromSibling('profiles', 'worker'));

    expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker');
  });

  it('does not purge profiles that are still present, even when others are added', async () => {
    const { registry, forgetProfile, sync, deps } = withListedRegistry(['worker']);
    deps.reloadProfiles.mockImplementation(async () => { registry.add('new'); });

    await sync.applyMessage(fromSibling('profiles', 'new'));

    expect(forgetProfile).not.toHaveBeenCalled();
  });

  it('purges a profile whose delete reload failed once the retry succeeds', async () => {
    const { registry, forgetProfile, fingerprint, sync, deps } = withListedRegistry(['worker']);
    await sync.prime();
    fingerprint.mockResolvedValue(fp('t1', 'p2'));
    deps.reloadProfiles.mockRejectedValueOnce(new Error('db down'));
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('worker'); });

    await sync.applyMessage(fromSibling('profiles', 'worker'));
    await vi.waitFor(() => expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker'));
  });

  it('stays fail-open and warns when listing profiles throws', async () => {
    const warn = vi.fn();
    const forgetProfile = vi.fn();
    const { sync, deps } = makeSync({
      listProfiles: () => { throw new Error('registry broken'); },
      forgetProfile,
      log: { info: () => {}, warn },
    });

    await expect(sync.applyMessage(fromSibling('profiles', 'worker'))).resolves.toBeUndefined();

    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
    expect(forgetProfile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'cache sync: listing profiles failed, skipping local credential purge',
      { error: 'registry broken' },
    );
  });

  it('logs a warning when the purge throws or rejects, and does not reject', async () => {
    const { registry, forgetProfile, warn, sync, deps } = withListedRegistry(['a', 'b']);
    deps.reloadProfiles.mockImplementation(async () => { registry.clear(); });
    forgetProfile.mockImplementation((name: string) => {
      if (name === 'a') throw new Error('boom');
      return Promise.reject(new Error('revoke down'));
    });

    await expect(sync.applyMessage(fromSibling('profiles'))).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('cache sync: local credential purge failed', { profile: 'a', error: 'boom' });
      expect(warn).toHaveBeenCalledWith('cache sync: local credential purge failed', { profile: 'b', error: 'revoke down' });
    });
  });

  it('does not wait for a slow purge before finishing the reload', async () => {
    const { registry, forgetProfile, sync, deps } = withListedRegistry(['worker']);
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('worker'); });
    forgetProfile.mockReturnValue(new Promise<void>(() => {}));

    await expect(sync.applyMessage(fromSibling('profiles', 'worker'))).resolves.toBeUndefined();
    expect(forgetProfile).toHaveBeenCalledTimes(1);
  });
});

describe('CacheSync purge by profile identity (delete and recreate under one name)', () => {
  /** name -> creation stamp: a recreate keeps the name but gets a new stamp. */
  function withIdentities(initial: Record<string, number>) {
    const registry = new Map(Object.entries(initial));
    const forgetProfile = vi.fn<(name: string) => void | Promise<void>>();
    const warn = vi.fn();
    const { sync, deps } = makeSync({
      listProfiles: () => [...registry.keys()],
      profileIdentity: (name: string) => registry.get(name),
      forgetProfile,
      log: { info: () => {}, warn },
    });
    return { registry, forgetProfile, warn, sync, deps };
  }

  it('forgets a profile that was deleted and recreated under the same name', async () => {
    const { registry, forgetProfile, sync, deps } = withIdentities({ worker: 100, other: 100 });
    // This replica missed both messages: the registry now holds a new "worker".
    deps.reloadProfiles.mockImplementation(async () => { registry.set('worker', 200); });

    await sync.applyMessage(fromSibling('profiles'));

    expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker');
  });

  it('does not forget a profile whose identity is unchanged (a plain update)', async () => {
    const { forgetProfile, sync, deps } = withIdentities({ worker: 100 });
    deps.reloadProfiles.mockImplementation(async () => undefined);

    await sync.applyMessage(fromSibling('profiles', 'worker'));

    expect(forgetProfile).not.toHaveBeenCalled();
  });

  it('forgets a recreated profile once even for a keyed message', async () => {
    const { registry, forgetProfile, sync, deps } = withIdentities({ worker: 100 });
    deps.reloadProfiles.mockImplementation(async () => { registry.set('worker', 200); });

    await sync.applyMessage(fromSibling('profiles', 'worker'));

    expect(forgetProfile).toHaveBeenCalledExactlyOnceWith('worker');
  });

  it('forgets a deleted profile and a recreated one in the same reload', async () => {
    const { registry, forgetProfile, sync, deps } = withIdentities({ gone: 1, again: 1, kept: 1 });
    deps.reloadProfiles.mockImplementation(async () => { registry.delete('gone'); registry.set('again', 2); });

    await sync.applyMessage(fromSibling('profiles'));

    expect(forgetProfile.mock.calls.map(c => c[0]).sort()).toEqual(['again', 'gone']);
  });

  it('does not treat a profile with no recorded identity as recreated', async () => {
    const registry = new Map<string, number | undefined>([['legacy', undefined]]);
    const forgetProfile = vi.fn<(name: string) => void | Promise<void>>();
    const { sync, deps } = makeSync({
      listProfiles: () => [...registry.keys()],
      profileIdentity: (name: string) => registry.get(name),
      forgetProfile,
    });
    deps.reloadProfiles.mockImplementation(async () => { registry.set('legacy', 5); });

    await sync.applyMessage(fromSibling('profiles'));

    expect(forgetProfile).not.toHaveBeenCalled();
  });

  it('still works with name-only listing when profileIdentity is not wired', async () => {
    const { sync, deps } = makeSync({ listProfiles: () => ['a'], forgetProfile: vi.fn() });
    await expect(sync.applyMessage(fromSibling('profiles'))).resolves.toBeUndefined();
    expect(deps.reloadProfiles).toHaveBeenCalledTimes(1);
  });
});
