// R2: approvals require an authenticated profile token.
//
// Every tokenless `?profile=` caller used to share one identity
// (LEGACY_QUERY_TOKEN_ID), so an approval requested by one such caller could be
// consumed by any other. Requesting or consuming an approval now requires a
// bearer profile token, whatever require_profile_token says. The legacy path is
// refused with rule `approval_requires_profile_token` and counted in metrics.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { ToolService } from '../../../src/services/tools/base.js';
import { createMcpExpressApp, setApprovalWaitHandler } from '../../../src/services/mcp/adapters/express/server.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService, argvHash } from '../../../src/services/approvals/base.js';
import { setApprovalHookFactory, setApprovalSettler, setPolicyDecisionSink } from '../../../src/services/tools/adapters/cli/passthrough.js';
import { createPrometheusMetrics } from '../../../src/services/metrics/adapters/prometheus/index.js';
import { hashProfileToken } from '../../../src/services/authentication/base.js';
import { LEGACY_QUERY_TOKEN_ID } from '../../../src/common/request/context.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

const TOOL = 'echo_approval';
const RUN = `${TOOL}__run`;
const ARGV = ['undo', 'foo'];
const OPS_TOKEN = 'placeholder-ops-token';
// A second, distinct token for the same profile.
const OPS_TOKEN_2 = 'placeholder-ops-token-2';

const cfg: CliPassthroughToolConfig = {
  type: 'cli_passthrough',
  name: TOOL,
  description: 'echo with an approval-gated subcommand',
  command: 'echo',
  deny_subcommands: [],
  env: [],
  timeout_ms: 5_000,
  policy: { approval_subcommand_paths: [['undo']], max_args: 32, on_violation: 'deny', audit: false },
};

let http: Server | null = null;
let base = '';
let store: SplicedockStore;
let approvals: ApprovalService;
let metrics: ReturnType<typeof createPrometheusMetrics>;

beforeEach(async () => {
  const toolReg = new ToolRegistry();
  for (const def of new ToolService().buildMcpDefsForCliPassthroughTool(cfg)) {
    toolReg.addFileTool({ id: def.name, driver: 'cli_passthrough', source: 'file', config: cfg, mcpDef: def });
  }
  const profileReg = new ProfileRegistry();
  profileReg.addFileProfile('default', { tools: ['*'] });
  profileReg.addFileProfile('ops', { tools: ['*'] });
  const profiles = new ProfileService(profileReg, toolReg);

  metrics = createPrometheusMetrics();
  store = await SplicedockStore.open(':memory:');
  approvals = new ApprovalService({
    store,
    ttlMs: 60_000,
    sweepIntervalMs: 0,
    onEvent: (tool, event) => metrics.approvals.inc({ tool, event }),
  });
  setApprovalHookFactory((tool, { cwd }) => approvals.makeHook(tool, cwd));
  setApprovalSettler(approvals);
  setPolicyDecisionSink(e => metrics.policyDecisions.inc(e as unknown as Record<string, string>));

  const app = createMcpExpressApp(profiles, toolReg, new Map(), ['echo'], {
    lookupProfileByToken: t => (t === OPS_TOKEN || t === OPS_TOKEN_2 ? 'ops' : null),
    metrics,
  });
  http = createServer(app);
  await new Promise<void>(r => http!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});

afterEach(async () => {
  setApprovalWaitHandler(undefined);
  setApprovalHookFactory(null);
  setApprovalSettler(null);
  setPolicyDecisionSink(null);
  approvals.stop();
  if (http) await new Promise<void>(r => http!.close(() => r()));
  http = null;
});

/** One MCP call as either a tokenless ?profile= caller or a bearer caller. */
async function run(who: { query: string } | { bearer: string }): Promise<{ isError: boolean; text: string }> {
  const url = new URL(`${base}/mcp${'query' in who ? `?profile=${who.query}` : ''}`);
  const requestInit = 'bearer' in who ? { headers: { Authorization: `Bearer ${who.bearer}` } } : undefined;
  const client = new Client({ name: 'r2-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  try {
    const res = await client.callTool({ name: RUN, arguments: { args: ARGV } });
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('');
    return { isError: Boolean(res.isError), text };
  } finally {
    await client.close();
  }
}

async function counter(name: string, labels: Record<string, string>): Promise<number> {
  const text = await metrics.registry.metrics();
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  // Sum every series matching the labels (other labels, e.g. profile, may differ).
  return text
    .split('\n')
    .filter(l => l.startsWith(`${name}{`) && want.every(w => l.includes(w)))
    .reduce((sum, l) => sum + Number(l.split(' ').pop()), 0);
}

describe('approval flows require an authenticated profile token (HTTP)', () => {
  it('two tokenless ?profile= callers are refused with a clear code; nothing is created', async () => {
    const a = await run({ query: 'default' });
    const b = await run({ query: 'ops' });
    for (const r of [a, b]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain('approval_requires_profile_token');
      expect(r.text).not.toMatch(/approval id/);
    }
    expect(await approvals.list({})).toHaveLength(0);
    expect(await counter('splicedock_approvals_total', { tool: TOOL, event: 'identity_refused' })).toBe(2);
    expect(
      await counter('splicedock_policy_decisions_total', {
        tool: TOOL,
        decision: 'deny',
        rule: 'approval_requires_profile_token',
      }),
    ).toBe(2);
  }, 30_000);

  it('an approved row bound to the shared legacy identity is not consumed by a tokenless caller', async () => {
    const now = Date.now();
    await store.insertApproval({
      id: 'legacy-row',
      tool: TOOL,
      argv_hash: argvHash(TOOL, realpathSync(process.cwd()), ARGV),
      argv_json: JSON.stringify(ARGV),
      rule: 'approval_subcommand_paths',
      matched: 'undo',
      requested_at: now,
      expires_at: now + 60_000,
      profile: 'default',
      token_id: LEGACY_QUERY_TOKEN_ID,
      cwd: realpathSync(process.cwd()),
    });
    expect(await approvals.approve('legacy-row', 'tester')).toBe(true);

    const r = await run({ query: 'default' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('approval_requires_profile_token');
    expect(r.text).not.toContain('undo foo');
    expect((await approvals.get('legacy-row'))?.status).toBe('approved');
  }, 30_000);

  it('a bearer caller can request and consume; a tokenless caller cannot take its approval', async () => {
    const first = await run({ bearer: OPS_TOKEN });
    expect(first.isError).toBe(true);
    expect(first.text).toContain('Approval required');
    const pending = await approvals.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.profile).toBe('ops');
    expect(await approvals.approve(pending[0]!.id, 'tester')).toBe(true);

    // Same profile, different token: the approval is bound to the requesting token.
    const other = await run({ bearer: OPS_TOKEN_2 });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('Approval required');
    expect((await approvals.get(pending[0]!.id))?.status).toBe('approved');

    // Same profile, no token: refused, the approval stays for its owner.
    const thief = await run({ query: 'ops' });
    expect(thief.isError).toBe(true);
    expect(thief.text).toContain('approval_requires_profile_token');
    expect((await approvals.get(pending[0]!.id))?.status).toBe('approved');

    const ok = await run({ bearer: OPS_TOKEN });
    expect(ok.isError).toBe(false);
    expect(ok.text.trim()).toBe('undo foo');
    expect((await approvals.get(pending[0]!.id))?.status).toBe('consumed');
  }, 30_000);
});


describe('approval wait HTTP cancellation',()=>{
  it('aborts the wait handler when the HTTP client disconnects',async ()=>{
    let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    let stopped!:()=>void;
    const aborted=new Promise<void>(resolve=>{stopped=resolve;});
    setApprovalWaitHandler((_id,_timeout,_caller,signal)=>new Promise((_resolve,reject)=>{
      signal!.addEventListener('abort',()=>{stopped();reject(new Error('aborted'));},{once:true});
      started();
    }));
    const controller=new AbortController();
    const request=fetch(`${base}/mcp`,{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${OPS_TOKEN}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'approvals__wait',arguments:{id:'fixture',timeout_s:120}}})}).catch(()=>undefined);
    await ready;controller.abort();await aborted;await request;
  });
});

describe('approval wait HTTP errors', () => {
  it('reports the wait limit while hiding missing and foreign approvals', async () => {
    setApprovalWaitHandler(async (id, timeout, caller, signal) => await approvals.wait(id, timeout, caller, signal));
    const owner = { profile: 'ops', tokenId: `tok-${hashProfileToken(OPS_TOKEN).slice(0,16)}`, authenticated: true };
    const input = { argv: ARGV, rule: 'approval_subcommands' as const, matched: 'undo' };
    const id = (await approvals.makeHook(TOOL, '/workspace', owner)(input)).id!;
    const wait = async (id: string, timeout_s: number) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approvals__wait', arguments: { id, timeout_s } } }),
      });
      return response.text();
    };
    const controller = new AbortController();
    const waits = Promise.allSettled([
      approvals.wait(id, 120, owner, controller.signal),
      approvals.wait(id, 120, owner, controller.signal),
    ]);
    try {
      const limited = await wait(id, 120);
      expect(limited).toContain('too many concurrent waits for this token (max 2); retry later');
      expect(limited).toContain('"isError":true');
      controller.abort();
      await waits;
      const foreignId = (await approvals.makeHook(TOOL, '/workspace', { ...owner, tokenId: 'foreign' })(input)).id!;
      for (const hiddenId of ['missing', foreignId]) {
        const hidden = await wait(hiddenId, 0);
        expect(hidden).toContain('approval not found');
        expect(hidden).toContain('"isError":true');
      }
    } finally {
      controller.abort();
      await waits;
    }
  });
});
