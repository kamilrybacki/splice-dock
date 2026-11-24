import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TransportInvalidationBus,
  NoopInvalidationBus,
  createInvalidationBus,
  parseInvalidation,
  encodeInvalidation,
  type BusTransport,
  type BusConnection,
} from '../../../src/services/database/adapters/invalidation-bus.js';

const quiet = { info: () => {}, warn: () => {} };

class FakeTransport implements BusTransport {
  published: string[] = [];
  listens = 0;
  failNextListens = 0;
  failPublish = false;
  private onPayload: ((p: string) => void) | null = null;
  private onClose: ((e?: Error) => void) | null = null;
  closed = 0;

  async listen(onPayload: (p: string) => void, onClose: (e?: Error) => void): Promise<BusConnection> {
    this.listens += 1;
    if (this.failNextListens > 0) {
      this.failNextListens -= 1;
      throw new Error('connect refused');
    }
    this.onPayload = onPayload;
    this.onClose = onClose;
    return { close: async () => { this.closed += 1; } };
  }
  async publish(payload: string): Promise<void> {
    if (this.failPublish) throw new Error('db down');
    this.published.push(payload);
  }
  deliver(payload: string): void { this.onPayload?.(payload); }
  drop(err?: Error): void { this.onClose?.(err); }
}

function makeBus(t: FakeTransport, replicaId = 'A') {
  return new TransportInvalidationBus({ transport: t, replicaId, backoffInitialMs: 10, backoffMaxMs: 40, log: quiet });
}

describe('parseInvalidation', () => {
  it('accepts a well-formed message, with and without key', () => {
    expect(parseInvalidation('{"kind":"tools","origin":"r1"}')).toEqual({ kind: 'tools', origin: 'r1' });
    expect(parseInvalidation('{"kind":"policy","key":"gh__run","origin":"r1"}')).toEqual({ kind: 'policy', key: 'gh__run', origin: 'r1' });
  });

  it.each([
    ['non-string', 42],
    ['empty', ''],
    ['not json', 'tools'],
    ['json null', 'null'],
    ['json array', '[{"kind":"tools","origin":"x"}]'],
    ['unknown kind', '{"kind":"admin","origin":"r1"}'],
    ['non-string kind', '{"kind":1,"origin":"r1"}'],
    ['missing origin', '{"kind":"tools"}'],
    ['empty origin', '{"kind":"tools","origin":""}'],
    ['non-string origin', '{"kind":"tools","origin":7}'],
    ['non-string key', '{"kind":"tools","key":5,"origin":"r1"}'],
    ['oversized origin', JSON.stringify({ kind: 'tools', origin: 'o'.repeat(129) })],
    ['oversized key', JSON.stringify({ kind: 'tools', key: 'k'.repeat(257), origin: 'r1' })],
    ['oversized payload', JSON.stringify({ kind: 'tools', origin: 'r1', pad: 'x'.repeat(3000) })],
  ])('rejects %s', (_label, raw) => {
    expect(parseInvalidation(raw)).toBeNull();
  });

  it('drops unknown extra fields from the parsed message', () => {
    expect(parseInvalidation('{"kind":"tools","origin":"r1","evil":"x"}')).toEqual({ kind: 'tools', origin: 'r1' });
  });

  it('round-trips through encodeInvalidation', () => {
    const msg = { kind: 'profiles' as const, key: 'ops', origin: 'r9' };
    expect(parseInvalidation(encodeInvalidation(msg))).toEqual(msg);
  });
});

describe('TransportInvalidationBus', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('delivers messages from other replicas and ignores its own origin', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t, 'A');
    const seen: unknown[] = [];
    bus.onMessage((m) => { seen.push(m); });
    await bus.start();

    t.deliver(encodeInvalidation({ kind: 'tools', key: 'x', origin: 'A' }));
    t.deliver(encodeInvalidation({ kind: 'tools', key: 'x', origin: 'B' }));
    expect(seen).toEqual([{ kind: 'tools', key: 'x', origin: 'B' }]);
    await bus.stop();
  });

  it('ignores malformed payloads without invoking handlers or throwing', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t);
    const handler = vi.fn();
    bus.onMessage(handler);
    await bus.start();
    expect(() => t.deliver('{"kind":"nope","origin":"B"}')).not.toThrow();
    expect(() => t.deliver('not json at all')).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    await bus.stop();
  });

  it('keeps delivering when one handler throws', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t);
    const second = vi.fn();
    bus.onMessage(() => { throw new Error('boom'); });
    bus.onMessage(second);
    await bus.start();
    t.deliver(encodeInvalidation({ kind: 'policy', origin: 'B' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toHaveBeenCalledTimes(1);
    await bus.stop();
  });

  it('publishes a payload carrying its own replica id', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t, 'A');
    await bus.publish('profiles', 'ops');
    expect(JSON.parse(t.published[0]!)).toEqual({ kind: 'profiles', key: 'ops', origin: 'A' });
  });

  it('drops an over-long key rather than producing an unparseable payload', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t, 'A');
    await bus.publish('tools', 'k'.repeat(1000));
    expect(parseInvalidation(t.published[0])).toEqual({ kind: 'tools', origin: 'A' });
  });

  it('does not reject when the publish fails (write already committed)', async () => {
    const t = new FakeTransport();
    t.failPublish = true;
    const bus = makeBus(t);
    await expect(bus.publish('tools', 'x')).resolves.toBeUndefined();
  });

  it('does not request a resync on a clean first connect', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t);
    const resync = vi.fn();
    bus.onResync(resync);
    await bus.start();
    expect(resync).not.toHaveBeenCalled();
    await bus.stop();
  });

  it('reconnects with backoff after the connection drops and then requests a full resync', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t);
    const resync = vi.fn();
    bus.onResync(resync);
    await bus.start();
    expect(t.listens).toBe(1);

    t.drop(new Error('terminating connection'));
    expect(resync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(t.listens).toBe(2);
    expect(resync).toHaveBeenCalledTimes(1);

    // Delivery works on the new connection.
    const handler = vi.fn();
    bus.onMessage(handler);
    t.deliver(encodeInvalidation({ kind: 'tools', origin: 'B' }));
    expect(handler).toHaveBeenCalledTimes(1);
    await bus.stop();
  });

  it('retries a failed first connect and resyncs once it succeeds', async () => {
    const t = new FakeTransport();
    t.failNextListens = 2;
    const bus = makeBus(t);
    const resync = vi.fn();
    bus.onResync(resync);
    await bus.start();
    expect(t.listens).toBe(1);
    expect(resync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(t.listens).toBe(3);
    expect(resync).toHaveBeenCalledTimes(1);
    await bus.stop();
  });

  it('stop() cancels pending retries and closes the connection', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t);
    await bus.start();
    t.drop();
    await bus.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.listens).toBe(1);

    const t2 = new FakeTransport();
    const bus2 = makeBus(t2);
    await bus2.start();
    await bus2.stop();
    expect(t2.closed).toBe(1);
    await bus2.stop(); // idempotent
    expect(t2.closed).toBe(1);
  });

  it('ignores a close event that arrives after stop()', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t);
    await bus.start();
    await bus.stop();
    t.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.listens).toBe(1);
  });
});

describe('TransportInvalidationBus races', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reconnects when the listener closes during a slow resync', async () => {
    const t = new FakeTransport();
    const bus = makeBus(t);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let resyncs = 0;
    bus.onResync(async () => { resyncs += 1; if (resyncs === 1) await gate; });
    await bus.start();
    t.drop(); // first connection dies
    await vi.advanceTimersByTimeAsync(50); // reconnect #2, resync now blocked
    expect(t.listens).toBe(2);
    t.drop(); // dies while the resync is still running
    await vi.advanceTimersByTimeAsync(100);
    expect(t.listens).toBe(3); // retry timer must not be swallowed by a `connecting` guard
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(resyncs).toBe(2);
    await bus.stop();
  });

  it('does not keep a connection that closed before listen() resolved', async () => {
    let calls = 0;
    const closes: number[] = [];
    const transport: BusTransport = {
      async listen(_onPayload, onClose) {
        calls += 1;
        const n = calls;
        if (n === 1) onClose(new Error('died right after LISTEN'));
        return { close: async () => { closes.push(n); } };
      },
      async publish() {},
    };
    const bus = makeBus(transport as FakeTransport);
    const resync = vi.fn();
    bus.onResync(resync);
    await bus.start();
    expect(closes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(2);
    expect(resync).toHaveBeenCalledTimes(1);
    await bus.stop();
    expect(closes).toEqual([1, 2]);
  });

  it('ignores close events from a stale connection generation', async () => {
    const closers: Array<(e?: Error) => void> = [];
    let calls = 0;
    const transport: BusTransport = {
      async listen(_p, onClose) { calls += 1; closers.push(onClose); return { close: async () => {} }; },
      async publish() {},
    };
    const bus = makeBus(transport as FakeTransport);
    await bus.start();
    closers[0]!(); // gen 1 drops
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(2);
    closers[0]!(); // duplicate/late close from gen 1 must not tear down gen 2
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
    await bus.stop();
  });
});

describe('createInvalidationBus', () => {
  it('returns a no-op bus off Postgres', async () => {
    const bus = createInvalidationBus({ dbTarget: ':memory:', isPostgres: false, publishVia: async () => { throw new Error('unused'); } });
    expect(bus).toBeInstanceOf(NoopInvalidationBus);
    await expect(bus.start()).resolves.toBeUndefined();
    await expect(bus.publish('tools', 'x')).resolves.toBeUndefined();
    await expect(bus.stop()).resolves.toBeUndefined();
  });
});
