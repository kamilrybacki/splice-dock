import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { buildAdminAuthHook, CSRF_HEADER, ADMIN_SESSION_COOKIE } from '../../../src/adapters/inbound/admin/auth.js';
import { migratePushSubscriptions } from '../../../src/adapters/outbound/persistence/migrations/push-subscriptions.js';
import { PushSubscriptionStore } from '../../../src/adapters/outbound/persistence/push-store.js';
import { createPushNotifier, parseSubscription, vapidFromEnv, type PushSender } from '../../../src/adapters/outbound/push/notifier.js';
import { registerPushRoutes } from '../../../src/adapters/inbound/admin/routes/push.js';
import { sqliteDb } from "../../helpers/sqlite.js";

const KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const AUTH = 'tBHItJI5svbpez7KI4CCXg';
const sub = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') => ({ endpoint, keys: { p256dh: KEY, auth: AUTH } });
const VAPID = { publicKey: 'pub-placeholder', privateKey: 'priv-placeholder', subject: 'https://admin.example.test' };

async function store() {
  const db = new Database(':memory:');
  await migratePushSubscriptions(sqliteDb(db));
  return new PushSubscriptionStore(sqliteDb(db));
}

describe('parseSubscription', () => {
  it('accepts a well-formed subscription on a known push service', () => {
    expect(parseSubscription(sub())).toEqual(sub());
    expect(parseSubscription(sub('https://web.push.apple.com/QGx'))).not.toBeNull();
    expect(parseSubscription(sub('https://updates.push.services.mozilla.com/wpush/v2/x'))).not.toBeNull();
  });
  it.each([
    ['http scheme', sub('http://fcm.googleapis.com/fcm/send/abc')],
    ['unknown host', sub('https://evil.example.com/x')],
    ['loopback', sub('https://127.0.0.1/x')],
    ['host suffix trick', sub('https://fcm.googleapis.com.evil.test/x')],
    ['userinfo', sub('https://user@fcm.googleapis.com/x')],
    ['custom port', sub('https://fcm.googleapis.com:8443/x')],
    ['too long', sub('https://fcm.googleapis.com/' + 'a'.repeat(2048))],
    ['bad key', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'not base64!', auth: AUTH } }],
    ['missing keys', { endpoint: 'https://fcm.googleapis.com/x' }],
    ['not an object', 'nope'],
  ])('rejects %s', (_n, body) => {
    expect(parseSubscription(body)).toBeNull();
  });
});

describe('vapidFromEnv', () => {
  it('is undefined unless all three values are set', () => {
    expect(vapidFromEnv({})).toBeUndefined();
    expect(vapidFromEnv({ SPLICEDOCK_VAPID_PUBLIC_KEY: 'a', SPLICEDOCK_VAPID_PRIVATE_KEY: 'b' })).toBeUndefined();
    expect(vapidFromEnv({ SPLICEDOCK_VAPID_PUBLIC_KEY: 'a', SPLICEDOCK_VAPID_PRIVATE_KEY: 'b', SPLICEDOCK_VAPID_SUBJECT: 'https://x.test' }))
      .toEqual({ publicKey: 'a', privateKey: 'b', subject: 'https://x.test' });
  });
  it('rejects a non-https subject', () => {
    expect(vapidFromEnv({ SPLICEDOCK_VAPID_PUBLIC_KEY: 'a', SPLICEDOCK_VAPID_PRIVATE_KEY: 'b', SPLICEDOCK_VAPID_SUBJECT: 'mailto:x@y.z' })).toBeUndefined();
  });
});

describe('PushSubscriptionStore', () => {
  it('upserts by endpoint, lists and removes', async () => {
    const s = await store();
    await s.upsert(sub(), 1);
    await s.upsert(sub(), 2);
    await s.upsert(sub('https://web.push.apple.com/y'), 3);
    expect(await s.list()).toHaveLength(2);
    await s.remove('https://web.push.apple.com/y');
    expect((await s.list()).map((x) => x.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/abc']);
  });
});

describe('push notifier', () => {
  it('sends a generic payload with no approval id, TTL bounded by expiry, high urgency', async () => {
    const s = await store(); await s.upsert(sub(), 1);
    const send = vi.fn<PushSender>().mockResolvedValue(undefined);
    const n = createPushNotifier({ store: s, vapid: VAPID, send, now: () => 1_000 });
    await n.notify({ id: 'secret-id-1234', tool: 'kubectl', expires_at: 61_000 });
    expect(send).toHaveBeenCalledTimes(1);
    const [target, payload, opts] = send.mock.calls[0]!;
    expect(target).toEqual(sub());
    const body = JSON.parse(payload);
    expect(body).toEqual({ title: 'Approval needed', body: 'kubectl', url: '/admin/swipe' });
    expect(payload).not.toContain('secret-id-1234');
    expect(opts).toMatchObject({ TTL: 60, urgency: 'high', vapidDetails: VAPID });
  });

  it('prunes subscriptions the push service reports gone', async () => {
    const s = await store(); await s.upsert(sub(), 1); await s.upsert(sub('https://web.push.apple.com/y'), 1);
    const send = vi.fn<PushSender>().mockImplementation(async (t) => {
      if (t.endpoint.includes('apple')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    await createPushNotifier({ store: s, vapid: VAPID, send }).notify({ id: 'x', tool: 't', expires_at: Date.now() + 60_000 });
    expect(await s.list()).toHaveLength(1);
  });

  it('keeps subscriptions on transient errors and never throws', async () => {
    const s = await store(); await s.upsert(sub(), 1);
    const send = vi.fn<PushSender>().mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
    await expect(createPushNotifier({ store: s, vapid: VAPID, send }).notify({ id: 'x', tool: 't', expires_at: Date.now() + 60_000 })).resolves.toBeUndefined();
    expect(await s.list()).toHaveLength(1);
  });

  it('skips already-expired approvals', async () => {
    const s = await store(); await s.upsert(sub(), 1);
    const send = vi.fn<PushSender>();
    await createPushNotifier({ store: s, vapid: VAPID, send, now: () => 5_000 }).notify({ id: 'x', tool: 't', expires_at: 4_000 });
    expect(send).not.toHaveBeenCalled();
  });
});

let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function build(enabled = true) {
  const s = await store();
  const notifier = enabled ? createPushNotifier({ store: s, vapid: VAPID, send: vi.fn<PushSender>() }) : undefined;
  app = Fastify({ logger: false });
  app.decorateRequest('adminIdentity', undefined);
  await app.register(async (authed) => {
    authed.addHook('preHandler', buildAdminAuthHook('legacy-placeholder', []));
    registerPushRoutes(authed, s, notifier);
  });
  return s;
}
const cookie = { cookie: `${ADMIN_SESSION_COOKIE}=legacy-placeholder` };

describe('push routes', () => {
  it('serves the public key when enabled and 404 when disabled', async () => {
    await build();
    const r = await app!.inject({ method: 'GET', url: '/api/v1/push/vapid-public-key', headers: cookie });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ publicKey: 'pub-placeholder' });
    await app!.close();
    await build(false);
    expect((await app!.inject({ method: 'GET', url: '/api/v1/push/vapid-public-key', headers: cookie })).statusCode).toBe(404);
  });

  it('requires auth', async () => {
    await build();
    expect((await app!.inject({ method: 'GET', url: '/api/v1/push/vapid-public-key' })).statusCode).toBe(401);
  });

  it('rejects a cookie POST without the CSRF header', async () => {
    const s = await build();
    const r = await app!.inject({ method: 'POST', url: '/api/v1/push/subscribe', headers: cookie, payload: sub() });
    expect(r.statusCode).toBe(403);
    expect(await s.list()).toHaveLength(0);
  });

  it('subscribes and unsubscribes with session + CSRF', async () => {
    const s = await build();
    const h = { ...cookie, [CSRF_HEADER]: '1' };
    expect((await app!.inject({ method: 'POST', url: '/api/v1/push/subscribe', headers: h, payload: sub() })).statusCode).toBe(200);
    expect(await s.list()).toHaveLength(1);
    expect((await app!.inject({ method: 'POST', url: '/api/v1/push/unsubscribe', headers: h, payload: { endpoint: sub().endpoint } })).statusCode).toBe(200);
    expect(await s.list()).toHaveLength(0);
  });

  it('400s an invalid subscription and 404s subscribe when disabled', async () => {
    await build();
    const h = { ...cookie, [CSRF_HEADER]: '1' };
    expect((await app!.inject({ method: 'POST', url: '/api/v1/push/subscribe', headers: h, payload: sub('https://evil.example.com/x') })).statusCode).toBe(400);
    await app!.close();
    await build(false);
    expect((await app!.inject({ method: 'POST', url: '/api/v1/push/subscribe', headers: h, payload: sub() })).statusCode).toBe(404);
  });
});
