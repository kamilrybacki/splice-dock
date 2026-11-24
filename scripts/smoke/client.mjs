// End-to-end smoke client for a running gateway started with
// site/examples/quickstart.yaml. Run it from a directory whose node_modules
// contains @modelcontextprotocol/sdk (the image's /app, or the installed
// npm package).
//
//   SPLICEDOCK_ADMIN_TOKEN=... node client.mjs
//
// SD_HOST selects the gateway host (default 127.0.0.1). Exits non-zero on the
// first failed check.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const host = process.env.SD_HOST ?? '127.0.0.1';
const adminToken = process.env.SPLICEDOCK_ADMIN_TOKEN;
if (!adminToken) throw new Error('SPLICEDOCK_ADMIN_TOKEN is required');

const admin = `http://${host}:8789`;
const mcpUrl = new URL(`http://${host}:8788/mcp`);
const MCP_ACCEPT = 'application/json, text/event-stream';
const EXPECTED_TOOLS = ['approvals__wait', 'code_mode__execute', 'demo__version'];

const pass = (message) => console.log('PASS', message);
const fail = (message) => {
  throw new Error(message);
};
const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const healthy = await fetch(`${admin}/api/v1/health`).then((r) => r.ok, () => false);
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail('gateway did not become healthy within 30 s');
}

function rawMcpPost(body, token) {
  const headers = { 'content-type': 'application/json', accept: MCP_ACCEPT };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function issueToken() {
  const response = await fetch(`${admin}/api/v1/profile-tokens`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ profile: 'demo', agent: 'smoke', expires_in_seconds: 600 }),
  });
  if (response.status !== 201) fail(`issue token: HTTP ${response.status}`);
  const { data } = await response.json();
  return data;
}

async function exerciseMcp(token) {
  const client = new Client({ name: 'splicedock-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) fail(`tools/list: ${names.join(',')}`);
    pass(`tools/list: ${names.join(',')}`);

    const direct = await client.callTool({ name: 'demo__version', arguments: {} });
    const version = direct.content?.[0]?.text?.trim() ?? '';
    if (direct.isError || !/^v\d+/.test(version)) fail(`demo__version: ${JSON.stringify(direct)}`);
    pass(`demo__version = ${version}`);

    const code = [
      'const [a, b] = await Promise.all([tools.call("demo__version", {}), tools.call("demo__version", {})]);',
      'return { ok: !a.isError && !b.isError, out: a.content };',
    ].join('\n');
    const codeMode = await client.callTool({ name: 'code_mode__execute', arguments: { code } });
    const codeModeText = JSON.stringify(codeMode.content);
    if (codeMode.isError || !/v\d+\.\d+/.test(codeModeText)) fail(`code_mode__execute: ${codeModeText}`);
    pass('code_mode__execute ran two parallel calls');

    const unknown = await client
      .callTool({ name: 'demo__nope', arguments: {} })
      .catch((error) => ({ isError: true, message: error.message }));
    if (!unknown.isError) fail('unknown tool was not refused');
    pass('unknown tool refused');
  } finally {
    await client.close();
  }
}

async function revokeToken(id, token) {
  const response = await fetch(`${admin}/api/v1/profile-tokens/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ reason: 'manual' }),
  });
  if (response.status !== 204) fail(`revoke: HTTP ${response.status}`);
  pass('token revoked');

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
  };
  const after = await rawMcpPost(initialize, token);
  if (after.status !== 401) fail(`revoked token still accepted: HTTP ${after.status}`);
  pass('revoked token -> 401');
}

async function checkAdminSurface() {
  const metrics = await (await fetch(`${admin}/metrics`)).text();
  const samples = metrics.split('\n').filter((line) => line.startsWith('splicedock_'));
  if (samples.length === 0) fail('/metrics has no splicedock_* samples');
  pass(`/metrics: ${samples.length} splicedock_* samples`);

  const login = await fetch(`${admin}/admin/login`);
  if (login.status !== 200) fail(`/admin/login: HTTP ${login.status}`);
  pass('/admin/login -> 200');

  const home = await fetch(`${admin}/admin/`, { redirect: 'manual' });
  if (home.status !== 302) fail(`/admin/ without a session: HTTP ${home.status}`);
  pass('/admin/ without a session -> 302');

  const brand = await fetch(`${admin}/admin/brand/splicedock-mark.svg`);
  if (brand.status !== 200) fail(`brand asset: HTTP ${brand.status}`);
  pass('brand asset -> 200');

  const noAuth = await fetch(`${admin}/api/v1/profile-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: 'demo' }),
  });
  if (noAuth.status < 400) fail(`admin API without a token: HTTP ${noAuth.status}`);
  pass(`admin API without a token -> ${noAuth.status}`);
}

await waitForHealth();
pass('health');

const anonymous = await rawMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
if (anonymous.status !== 401) fail(`anonymous /mcp: HTTP ${anonymous.status}`);
pass('anonymous /mcp -> 401');

const issued = await issueToken();
pass('profile token issued');
await exerciseMcp(issued.token);
await revokeToken(issued.id, issued.token);
await checkAdminSurface();
console.log('ALL PASS');
