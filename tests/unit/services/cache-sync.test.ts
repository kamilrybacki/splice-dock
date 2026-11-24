import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheSync, coalesce } from '../../../src/services/runtime/base.js';
import type { RuntimeFingerprint } from '../../../src/services/database/adapters/store.js';
import type { InvalidationBus, InvalidationMessage, MessageHandler, ResyncHandler } from '../../../src/contracts/outbound/invalidation-bus.js';

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
