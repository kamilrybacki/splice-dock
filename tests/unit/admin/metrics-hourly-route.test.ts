import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { ADMIN_SESSION_COOKIE } from '../../../src/services/admin/adapters/fastify/auth.js';
import { registerWebUiRoutes } from '../../../src/services/admin/adapters/fastify/web.js';
import type { WebUiOptions } from '../../../src/services/admin/adapters/fastify/web/types.js';

const TOKEN = 'hourly-route-placeholder';
const cookie = `${ADMIN_SESSION_COOKIE}=${TOKEN}`;
let app: ReturnType<typeof Fastify> | undefined;

async function get(extra: Partial<WebUiOptions>) {
  app = Fastify({ logger: false });
  const opts = {
    expectedToken: TOKEN,
    snapshot: async () => ({ policies: [], recent_denies: [], metrics: [] }),
    detail: async () => null,
    auditList: async () => [],
    metricsList: async () => [{ tool: 't', total: 3, allow: 3, deny: 0, rule_denies: 0, last_ts: 1 }],
    approvalsList: async () => [],
    approvalDetail: async () => null,
    ...extra,
  } as unknown as WebUiOptions;
  registerWebUiRoutes(app, opts);
  await app.ready();
  return (await app.inject({ method: 'GET', url: '/admin/metrics', headers: { cookie } })).body;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('/admin/metrics hourly wiring', () => {
  it('renders real hours when the provider returns history', async () => {
    const startTs = Date.UTC(2026, 0, 2, 10);
    const body = await get({ metricsHourly: () => ({ buckets: [1, 2, 3], startTs, lastInProgress: true }) });
    expect(body).not.toContain('Hourly history unavailable');
    expect(body).toContain('10:00');
  });

  it('keeps the unavailable notice when the provider returns null', async () => {
    expect(await get({ metricsHourly: () => null })).toContain('Hourly history unavailable');
  });

  it('keeps the unavailable notice when no provider is given', async () => {
    expect(await get({})).toContain('Hourly history unavailable');
  });
});
