// Cross-replica cache invalidation bus.
//
// With 2+ replicas sharing one Postgres, an admin change on replica A only
// updates A's in-process state (runtime tool registry, profile registry, the
// compiled-policy cache). The bus tells the other replicas to re-read from the
// DB: writers publish `{kind, key?, origin}` on a Postgres NOTIFY channel and
// every replica LISTENs on a dedicated (non-pooled) connection.
//
// Delivery is best-effort by design: NOTIFY is lost while a listener is
// disconnected, so after every reconnect the bus asks its subscribers for a
// full resync, and a separate periodic reconcile (see cache-sync.ts) backstops
// anything else. On SQLite (single instance) the bus is a no-op.
//
// Payloads arrive from the database and are therefore untrusted input: they
// are size-limited and shape-validated before anything acts on them, and are
// never echoed into logs.

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { logger } from '../../../common/logger.js';
import type {
  InvalidationBus,
  InvalidationKind,
  InvalidationMessage,
  MessageHandler,
  ResyncHandler,
} from '../../../contracts/outbound/invalidation-bus.js';
export type {
  InvalidationBus,
  InvalidationKind,
  InvalidationMessage,
  InvalidationPublisher,
  MessageHandler,
  ResyncHandler,
} from '../../../contracts/outbound/invalidation-bus.js';

export const INVALIDATION_CHANNEL = 'splicedock_invalidate';

const KINDS: ReadonlySet<string> = new Set<InvalidationKind>(['tools', 'profiles', 'policy']);
/** Postgres caps a NOTIFY payload at 8000 bytes; stay well below. */
const MAX_PAYLOAD_CHARS = 2048;
const MAX_KEY_CHARS = 256;
const MAX_ORIGIN_CHARS = 128;

const DEFAULT_BACKOFF_INITIAL_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const LISTEN_CONNECT_TIMEOUT_MS = 10_000;

/** Parse an untrusted NOTIFY payload. Returns null for anything malformed. */
export function parseInvalidation(raw: unknown): InvalidationMessage | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PAYLOAD_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { kind, key, origin } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > MAX_ORIGIN_CHARS) return null;
  if (key !== undefined && (typeof key !== 'string' || key.length > MAX_KEY_CHARS)) return null;
  return key === undefined
    ? { kind: kind as InvalidationKind, origin }
    : { kind: kind as InvalidationKind, key, origin };
}

export function encodeInvalidation(msg: InvalidationMessage): string {
  return JSON.stringify(msg);
}

// ---------------------------------------------------------------------------
// Transport seam (faked in unit tests, pg-backed in production)
// ---------------------------------------------------------------------------

export interface BusConnection {
  close(): Promise<void>;
}

export interface BusTransport {
  /**
   * Open a listener. Resolves once LISTEN is active. `onClose` fires at most
   * once if an established connection dies. A rejected promise means the
   * attempt failed and no `onClose` will follow for it.
   */
  listen(onPayload: (payload: string) => void, onClose: (err?: Error) => void): Promise<BusConnection>;
  publish(payload: string): Promise<void>;
}

export interface BusLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface BusOptions {
  readonly transport: BusTransport;
  readonly replicaId?: string;
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
  readonly log?: BusLogger;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TransportInvalidationBus implements InvalidationBus {
  readonly replicaId: string;
  private readonly transport: BusTransport;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly log: BusLogger;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly resyncHandlers: ResyncHandler[] = [];

  private connection: BusConnection | null = null;
  private connectedAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private resyncOnConnect = false;
  private connecting = false;
  private generation = 0;
  private stopped = false;

  constructor(opts: BusOptions) {
    this.transport = opts.transport;
    this.replicaId = opts.replicaId ?? randomUUID();
    this.backoffInitialMs = opts.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.log = opts.log ?? logger;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onResync(handler: ResyncHandler): void {
    this.resyncHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    await this.connect();
  }

  async publish(kind: InvalidationKind, key?: string): Promise<void> {
    // An over-long key is dropped: receivers do a full reload per kind anyway.
    const safeKey = key !== undefined && key.length <= MAX_KEY_CHARS ? key : undefined;
    const msg: InvalidationMessage = safeKey === undefined
      ? { kind, origin: this.replicaId }
      : { kind, key: safeKey, origin: this.replicaId };
    try {
      await this.transport.publish(encodeInvalidation(msg));
    } catch (err) {
      // The DB write already committed; the periodic reconcile will converge
      // the other replicas, so a failed notify must not fail the request.
      this.log.warn('invalidation publish failed', { kind, error: errMsg(err) });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const conn = this.connection;
    this.connection = null;
    if (conn) {
      try {
        await conn.close();
      } catch (err) {
        this.log.warn('invalidation listener close failed', { error: errMsg(err) });
      }
    }
  }

  // -- connection lifecycle -------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.connection) return;
    this.connecting = true;
    // Each attempt owns a generation; close events from older attempts are stale.
    const gen = ++this.generation;
    let assigned = false;
    let closedEarly = false;
    let needResync = false;
    try {
      const conn = await this.transport.listen(
        (payload) => {
          if (gen === this.generation) this.handlePayload(payload);
        },
        (err) => {
          if (gen !== this.generation) return;
          // Died before we stored it: remember, do not let the dead conn be assigned.
          if (!assigned) closedEarly = true;
          else this.handleClose(err);
        },
      );
      if (this.stopped) {
        await conn.close().catch(() => undefined);
        return;
      }
      if (closedEarly) {
        await conn.close().catch(() => undefined);
        this.resyncOnConnect = true;
        this.log.warn('invalidation listener closed during connect');
        this.scheduleReconnect();
        return;
      }
      assigned = true;
      this.connection = conn;
      this.connectedAt = Date.now();
      this.log.info('invalidation listener connected', { replica: this.replicaId });
      needResync = this.resyncOnConnect;
      this.resyncOnConnect = false;
    } catch (err) {
      this.resyncOnConnect = true;
      this.log.warn('invalidation listener connect failed', { error: errMsg(err) });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
    // Outside the `connecting` window: a close during a slow resync must be
    // able to reconnect via its own retry timer.
    if (needResync) await this.runResync();
  }

  private handleClose(err?: Error): void {
    if (this.stopped) return;
    this.connection = null;
    this.resyncOnConnect = true;
    // A connection that stayed up a while earns a fresh backoff; a flapping one
    // keeps escalating instead of hammering the server.
    if (Date.now() - this.connectedAt > this.backoffMaxMs) this.attempts = 0;
    this.log.warn('invalidation listener closed', { error: err ? errMsg(err) : undefined });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const ceiling = Math.min(this.backoffMaxMs, this.backoffInitialMs * 2 ** this.attempts);
    this.attempts += 1;
    const delay = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  // -- inbound --------------------------------------------------------------

  private handlePayload(payload: string): void {
    const msg = parseInvalidation(payload);
    if (!msg) {
      // Never log the payload itself: it is untrusted and may be large.
      this.log.warn('ignoring malformed invalidation payload', { length: payload.length });
      return;
    }
    if (msg.origin === this.replicaId) return;
    for (const handler of this.messageHandlers) void this.invoke(() => handler(msg), 'message', msg.kind);
  }

  private async runResync(): Promise<void> {
    for (const handler of this.resyncHandlers) await this.invoke(() => handler(), 'resync');
  }

  private async invoke(fn: () => void | Promise<void>, what: string, kind?: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.warn('invalidation handler failed', { what, kind, error: errMsg(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// No-op bus (SQLite / single instance)
// ---------------------------------------------------------------------------

export class NoopInvalidationBus implements InvalidationBus {
  readonly replicaId = 'single-instance';
  onMessage(): void {}
  onResync(): void {}
  async start(): Promise<void> {}
  async publish(): Promise<void> {}
  async stop(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Postgres transport
// ---------------------------------------------------------------------------

/**
 * LISTEN runs on its own pg.Client (a pooled connection would be recycled or
 * dropped under us). Publishing goes through `publishVia`, typically the
 * store's pooled `pg_notify`. The DSN is only handed to pg and never logged.
 */
export function createPgTransport(
  dsn: string,
  publishVia: (channel: string, payload: string) => Promise<void>,
): BusTransport {
  return {
    async listen(onPayload, onClose) {
      const client = new pg.Client({
        connectionString: dsn,
        connectionTimeoutMillis: LISTEN_CONNECT_TIMEOUT_MS,
        keepAlive: true,
      });
      let ready = false;
      let ended = false;
      const finish = (err?: Error): void => {
        if (ended) return;
        ended = true;
        client.end().catch(() => undefined);
        if (ready) onClose(err);
      };
      client.on('error', (err) => finish(err));
      client.on('end', () => finish());
      client.on('notification', (msg) => {
        if (msg.channel === INVALIDATION_CHANNEL && typeof msg.payload === 'string') onPayload(msg.payload);
      });
      try {
        await client.connect();
        await client.query(`LISTEN ${INVALIDATION_CHANNEL}`);
      } catch (err) {
        ended = true;
        client.end().catch(() => undefined);
        throw err;
      }
      ready = true;
      return {
        async close() {
          ended = true;
          await client.end();
        },
      };
    },
    publish: (payload) => publishVia(INVALIDATION_CHANNEL, payload),
  };
}

export interface CreateBusOptions {
  /** Postgres DSN, or anything else (SQLite path) for the no-op bus. */
  readonly dbTarget: string;
  readonly isPostgres: boolean;
  readonly publishVia: (channel: string, payload: string) => Promise<void>;
  readonly replicaId?: string;
}

export function createInvalidationBus(opts: CreateBusOptions): InvalidationBus {
  if (!opts.isPostgres) return new NoopInvalidationBus();
  return new TransportInvalidationBus({
    transport: createPgTransport(opts.dbTarget, opts.publishVia),
    replicaId: opts.replicaId,
  });
}
