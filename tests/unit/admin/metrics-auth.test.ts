import { describe, it, expect, afterEach } from 'vitest';
import { createAdminServer } from '../../../src/services/admin/adapters/fastify/server.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import { ToolService } from '../../../src/services/tools/base.js';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { createPrometheusMetrics } from '../../../src/services/metrics/adapters/prometheus/index.js';
import type { SplicedockConfig } from '../../../src/config/schema.js';

type Admin = Awaited<ReturnType<typeof createAdminServer>>;
let app: Admin | undefined;

async function build(metricsToken?: string): Promise<Admin> {
  process.env['SPLICEDOCK_ADMIN_TOKEN'] = 'admin-test-token';
  if (metricsToken === undefined) delete process.env['SPLICEDOCK_METRICS_TOKEN'];
  else process.env['SPLICEDOCK_METRICS_TOKEN'] = metricsToken;
  const tr = new ToolRegistry();
  const pr = new ProfileRegistry();
  const config = {
    server: {
      port: 0, admin_port: 0, admin_token_env: 'SPLICEDOCK_ADMIN_TOKEN',
      metrics_token_env: 'SPLICEDOCK_METRICS_TOKEN', cli_whitelist: [], require_profile_token: false,
    },
    profiles: {}, tools: [],
  } as SplicedockConfig;
  app = await createAdminServer(tr, pr, new ToolService(tr), new ProfileService(pr, tr), new Map(), config, createPrometheusMetrics());
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env['SPLICEDOCK_METRICS_TOKEN'];
  delete process.env['SPLICEDOCK_ADMIN_TOKEN'];
});

describe('GET /metrics auth', () => {
  it('is unauthenticated when no metrics token is configured', async () => {
    const a = await build();
    expect((await a.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('requires a bearer when a metrics token is configured', async () => {
    const a = await build('scrape-secret');
    expect((await a.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
  });

  it('rejects a wrong token, including one of a different length', async () => {
    const a = await build('scrape-secret');
    for (const t of ['scrape-secreX', 'short', 'scrape-secret-and-more']) {
      const res = await a.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${t}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it('accepts the right token', async () => {
    const a = await build('scrape-secret');
    const res = await a.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer scrape-secret' } });
    expect(res.statusCode).toBe(200);
  });

  it('does not accept the admin token on /metrics when a metrics token is set', async () => {
    const a = await build('scrape-secret');
    const res = await a.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer admin-test-token' } });
    expect(res.statusCode).toBe(401);
  });
});
