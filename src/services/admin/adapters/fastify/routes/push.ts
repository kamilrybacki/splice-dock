// Web Push subscription endpoints for the admin PWA. Mounted in the auth-gated
// scope, so cookie-authenticated POSTs also need the CSRF header. All routes
// 404 when VAPID keys are not configured.

import type { FastifyInstance } from 'fastify';

import type { PushSubscriptionStore } from '../../../../database/adapters/push-store.js';
import { parseSubscription, type PushNotifier } from '../../../../approvals/adapters/web-push/notifier.js';

const DISABLED = { error: { code: 'push_disabled', message: 'Web Push is not configured' } };

export function registerPushRoutes(
  app: FastifyInstance,
  store: PushSubscriptionStore,
  notifier: PushNotifier | undefined,
): void {
  app.get('/api/v1/push/vapid-public-key', async (_req, reply) =>
    notifier ? reply.send({ publicKey: notifier.publicKey }) : reply.code(404).send(DISABLED));

  app.post('/api/v1/push/subscribe', async (req, reply) => {
    if (!notifier) return reply.code(404).send(DISABLED);
    const sub = parseSubscription(req.body);
    if (!sub) return reply.code(400).send({ error: 'invalid subscription' });
    await store.upsert(sub);
    return reply.send({ ok: true });
  });

  app.post<{ Body: { endpoint?: unknown } }>('/api/v1/push/unsubscribe', async (req, reply) => {
    if (!notifier) return reply.code(404).send(DISABLED);
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) return reply.code(400).send({ error: 'invalid endpoint' });
    await store.remove(endpoint);
    return reply.send({ ok: true });
  });
}
