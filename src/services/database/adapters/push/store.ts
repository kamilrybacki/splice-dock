// Web Push subscriptions registered from the admin PWA. One row per browser
// push endpoint; re-subscribing the same endpoint replaces its keys.

import type { SqlDb } from '../../base.js';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class PushSubscriptionStore {
  constructor(private readonly db: SqlDb) {}

  async upsert(sub: PushSubscriptionRecord, now: number = Date.now()): Promise<void> {
    await this.db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now);
  }

  async remove(endpoint: string): Promise<void> {
    await this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    const rows = await this.db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at').all() as
      { endpoint: string; p256dh: string; auth: string }[];
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }
}
