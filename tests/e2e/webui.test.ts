// tests/e2e/webui.test.ts
//
// End-to-end coverage of the admin WebUI:
//   - login form + cookie session
//   - GET /admin/ dashboard renders tool list and recent denies
//   - PUT /api/v1/policies/:name applies an override and survives the live cli call
//   - dry-run endpoint returns a deny decision
//   - audit feed contains the deny that just happened
//
// Boots splicedock's createAdminServer in-process with stub registries +
// a fresh in-memory SQLite store. No upstreams, no docker.
//
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createAdminServer } from '../../src/services/admin/adapters/fastify/server.js';
import { ToolRegistry } from '../../src/services/tools/tool-registry.js';
import { ProfileRegistry } from '../../src/services/profiles/profile-registry.js';
import { ToolService } from '../../src/services/tools/base.js';
import { ProfileService } from '../../src/services/profiles/base.js';
import { SplicedockStore } from '../../src/services/database/adapters/store.js';
import { AuditBuffer } from '../../src/services/audit/base.js';
import { ToolMetrics } from '../../src/services/metrics/base.js';
import { PolicyStore } from '../../src/services/policy/base.js';
import {
  setEffectivePolicyResolver,
  setAuditSink,
  setMetricsSink,
  invalidatePolicyForTool,
  callCliPassthrough,
} from '../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig, SplicedockConfig } from '../../src/config/types.js';

const ADMIN_TOKEN = 'webui-e2e-token';

const echoTool: CliPassthroughToolConfig = {
  type: 'cli_passthrough',
  name: 'echo_pass',
  description: 'echo for webui e2e',
  command: 'echo',
  deny_subcommands: [],
  env: [],
  timeout_ms: 5000,
  policy: {
    max_args: 256,
    on_violation: 'deny' as const,
    audit: false,
    allow_subcommands: ['hello', 'world'],
  },
};

const config: SplicedockConfig = {
  server: {
    port: 0,
    admin_port: 0,
    admin_token_env: 'SPLICEDOCK_WEBUI_TOKEN',
    cli_whitelist: ['echo'],
  },
  profiles: {},
  tools: [echoTool],
} as unknown as SplicedockConfig;

let server: FastifyInstance;
let baseUrl = '';
let policyStore: PolicyStore;
let auditBuffer: AuditBuffer;

beforeAll(async () => {
  process.env['SPLICEDOCK_WEBUI_TOKEN'] = ADMIN_TOKEN;

  const toolRegistry = new ToolRegistry();
  const toolService = new ToolService();
  const profileRegistry = new ProfileRegistry();
  profileRegistry.addFileProfile('default', { tools: ['*'] });
  const profileService = new ProfileService(profileRegistry, toolRegistry);

  // Register the cli_passthrough tool in the registry so the dispatch wiring
  // exists end-to-end. Not strictly needed for the admin-only routes but
  // makes the test reflect a real deployment.
  for (const def of toolService.buildMcpDefsForCliPassthroughTool(echoTool)) {
    toolRegistry.addFileTool({
      id: def.name, driver: 'cli_passthrough', source: 'file',
      config: echoTool, mcpDef: def,
    });
  }

  const store = await SplicedockStore.open(':memory:');
  auditBuffer = new AuditBuffer(100);
  const toolMetrics = new ToolMetrics(store, 0);
  await toolMetrics.start();
  policyStore = new PolicyStore(store);

  setEffectivePolicyResolver(async cfg => await policyStore.effective(cfg));
  policyStore.onChange(invalidatePolicyForTool);
  setAuditSink(entry => auditBuffer.push({ ...entry, ts: Date.now() }));
  setMetricsSink(entry => toolMetrics.record(entry));

  server = await createAdminServer(
    toolRegistry, profileRegistry, toolService, profileService,
    new Map(), config, undefined,
    { auditBuffer, toolMetrics, policyStore },
  );
  await server.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  setEffectivePolicyResolver(null);
  setAuditSink(null);
  setMetricsSink(null);
  await server?.close();
});

let sessionCookie: string | undefined;
async function loginAndGetCookie(): Promise<string> {
  if (sessionCookie) return sessionCookie;
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: ADMIN_TOKEN }).toString(),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('splicedock_admin=');
  sessionCookie = setCookie.split(';')[0]!;
  return sessionCookie; // "splicedock_admin=<value>"
}

describe('WebUI E2E — login + dashboard', () => {
  it('login form rejects an invalid token', async () => {
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'wrong' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
  });

  it('login sets a cookie, dashboard renders the tool', async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${baseUrl}/admin/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('echo_pass');
    expect(html).toContain('tools');
  });

  it('unauthenticated dashboard request redirects to /admin/login', async () => {
    const res = await fetch(`${baseUrl}/admin/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });
});

describe('WebUI E2E — API + policy round-trip', () => {
  it('rejects a cookie-authenticated state-changing request without the CSRF header (403)', async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${baseUrl}/api/v1/policies/echo_pass`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it('PUT /api/v1/policies/echo_pass applies and is visible in dispatch', async () => {
    // Apply a runtime override that *denies* a previously-allowed subcommand.
    const cookie = await loginAndGetCookie();
    const putRes = await fetch(`${baseUrl}/api/v1/policies/echo_pass`, {
      method: 'PUT',
      headers: { cookie, 'x-splicedock-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        policy: {
          max_args: 256,
          on_violation: 'deny',
          audit: false,
          allow_subcommands: ['only-this'],
        },
      }),
    });
    expect(putRes.status).toBe(200);

    // Call the cli wrapper directly with an argv that's allowed by the file
    // policy but denied by the override. The override must take effect
    // without restarting the daemon.
    const result = await callCliPassthrough(
      echoTool, 'run', { args: ['hello'] }, ['echo'],
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Denied by policy.allow_subcommands');
  });

  it('DELETE /api/v1/policies/echo_pass restores the file policy', async () => {
    const cookie = await loginAndGetCookie();
    const delRes = await fetch(`${baseUrl}/api/v1/policies/echo_pass`, {
      method: 'DELETE',
      headers: { cookie, 'x-splicedock-csrf': '1' },
    });
    expect(delRes.status).toBe(200);
    const result = await callCliPassthrough(
      echoTool, 'run', { args: ['hello'] }, ['echo'],
    );
    expect(result.isError).toBeFalsy();
  });

  it('POST /api/v1/policies/echo_pass/dry-run evaluates inline policy', async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${baseUrl}/api/v1/policies/echo_pass/dry-run`, {
      method: 'POST',
      headers: { cookie, 'x-splicedock-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        argv: ['delete', 'pod'],
        policy: { max_args: 256, on_violation: 'deny', audit: false, deny_subcommands: ['delete'] },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { ok: boolean; rule?: string } };
    expect(body.data.ok).toBe(false);
    expect(body.data.rule).toBe('deny_subcommands');
  });
});

describe('WebUI E2E — audit + metrics', () => {
  it('audit list includes the deny we just produced', async () => {
    // Make a deny that we know is observable from the wrapper sink.
    await callCliPassthrough(
      echoTool, 'run', { args: ['definitely-not-allowed'] }, ['echo'],
    );
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${baseUrl}/api/v1/audit?limit=50&decision=deny`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ tool: string; decision: string; rule?: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]!.decision).toBe('deny');
    expect(body.data[0]!.tool).toBe('echo_pass');
  });

  it('GET /metrics is unauthenticated and exposes cli counters', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('splicedock_cli_calls_total{tool="echo_pass"');
  });
  it('logout requires a session and CSRF header', async () => {
    const cookie = await loginAndGetCookie();
    const denied = await fetch(`${baseUrl}/admin/logout`, {
      method: 'POST', headers: { cookie }, redirect: 'manual',
    });
    expect(denied.status).toBe(403);
    const accepted = await fetch(`${baseUrl}/admin/logout`, {
      method: 'POST', headers: { cookie, 'x-splicedock-csrf': '1' }, redirect: 'manual',
    });
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get('set-cookie')).toContain('splicedock_admin=;');
    sessionCookie = undefined;
  });

});
