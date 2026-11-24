// Cross-replica cache invalidation: the contract application code depends on.
// The Postgres LISTEN/NOTIFY implementation lives in
// services/database/adapters/invalidation-bus.ts.

export type InvalidationKind = 'tools' | 'profiles' | 'policy';

export interface InvalidationMessage {
  readonly kind: InvalidationKind;
  readonly key?: string;
  readonly origin: string;
}

/** What mutating code needs: announce a committed change. Never rejects. */
export interface InvalidationPublisher {
  publish(kind: InvalidationKind, key?: string): Promise<void>;
}

export type MessageHandler = (msg: InvalidationMessage) => void | Promise<void>;
export type ResyncHandler = () => void | Promise<void>;

export interface InvalidationBus extends InvalidationPublisher {
  readonly replicaId: string;
  /** Subscribe to messages from OTHER replicas (own-origin is filtered out). */
  onMessage(handler: MessageHandler): void;
  /** Subscribe to "you may have missed messages, reload everything". */
  onResync(handler: ResyncHandler): void;
  /**
   * Begin listening. Resolves after the first connect attempt; a failed attempt
   * is retried in the background and a resync is requested once it succeeds.
   * Start the bus BEFORE the initial load so no change falls in the gap.
   */
  start(): Promise<void>;
  stop(): Promise<void>;
}
