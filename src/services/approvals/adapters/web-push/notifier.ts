// Web Push notifier for pending approvals. The payload is deliberately generic
// (tool name + a link to the swipe page): it never carries the approval id or a
// consent link, because push payloads transit third-party push services and
// land on a lock screen. Delivery is best effort and never throws.

import webpush from 'web-push';

import { logger } from '../../../../common/logger.js';
import type { PushSubscriptionRecord, PushSubscriptionStore } from '../../../database/adapters/push-store.js';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushSendOptions {
  TTL: number;
  urgency: 'high';
  topic: string;
  vapidDetails: VapidConfig;
}

export type PushSender = (sub: PushSubscriptionRecord, payload: string, opts: PushSendOptions) => Promise<unknown>;

export interface PendingApprovalInfo {
  id: string;
  tool: string;
  expires_at: number;
}

export interface PushNotifier {
  readonly publicKey: string;
  notify(info: PendingApprovalInfo): Promise<void>;
}

// Only the browser push services we expect; anything else would make the
// server POST to an arbitrary caller-chosen URL (SSRF).
const PUSH_HOSTS: ReadonlyArray<RegExp> = [
  /^fcm\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const MAX_ENDPOINT = 2048;
const MAX_KEY = 256;
const TOPIC = 'splicedock-approval';

function isPushEndpoint(raw: string): boolean {
  if (raw.length > MAX_ENDPOINT) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return PUSH_HOSTS.some((re) => re.test(url.hostname));
}

const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY && B64URL.test(v);

/** Validate an untrusted PushSubscription JSON body; null when unusable. */
export function parseSubscription(body: unknown): PushSubscriptionRecord | null {
  if (!body || typeof body !== 'object') return null;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || !isPushEndpoint(endpoint)) return null;
  if (!keys || typeof keys !== 'object') return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (!isKey(p256dh) || !isKey(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** VAPID config from env; push is disabled (undefined) unless all three are set. */
export function vapidFromEnv(env: NodeJS.ProcessEnv): VapidConfig | undefined {
  const publicKey = env.SPLICEDOCK_VAPID_PUBLIC_KEY;
  const privateKey = env.SPLICEDOCK_VAPID_PRIVATE_KEY;
  const subject = env.SPLICEDOCK_VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject || !subject.startsWith('https://')) return undefined;
  return { publicKey, privateKey, subject };
}

const defaultSender: PushSender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);

function statusOf(err: unknown): number | undefined {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

export function createPushNotifier(opts: {
  store: PushSubscriptionStore;
  vapid: VapidConfig;
  send?: PushSender;
  now?: () => number;
}): PushNotifier {
  const send = opts.send ?? defaultSender;
  const now = opts.now ?? Date.now;
  return {
    publicKey: opts.vapid.publicKey,
    async notify(info) {
      const ttl = Math.floor((info.expires_at - now()) / 1000);
      if (ttl <= 0) return;
      const payload = JSON.stringify({ title: 'Approval needed', body: info.tool, url: '/admin/swipe' });
      const sendOpts: PushSendOptions = { TTL: ttl, urgency: 'high', topic: TOPIC, vapidDetails: opts.vapid };
      let subs: PushSubscriptionRecord[];
      try { subs = await opts.store.list(); } catch (err) {
        logger.warn('push: listing subscriptions failed', { error: (err as Error).message });
        return;
      }
      await Promise.all(subs.map(async (sub) => {
        try {
          await send(sub, payload, sendOpts);
        } catch (err) {
          const status = statusOf(err);
          if (status === 404 || status === 410) {
            try { await opts.store.remove(sub.endpoint); } catch { /* best effort */ }
            logger.info('push: pruned expired subscription', { status });
          } else {
            logger.warn('push: delivery failed', { status });
          }
        }
      }));
    },
  };
}
