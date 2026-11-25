// Tools dashboard page — KPI strip, searchable tool table with sparklines,
// and a recent-denies table.
//
// Returns the inner body for /admin/ (between <main>...</main>); the caller
// is responsible for HEAD, NAV, and FOOT.
//
// All user-controlled values are HTML-escaped via the components helpers.
// Client-side filtering is implemented with Alpine.js using a `data-tool`
// attribute, avoiding any embedding of tool names into JS string literals.

import { escapeHtml, pill, kpi, card, spark } from '../components.js';
import { formatDenyBasis, formatDenyRate, formatNumber, renderGeneratedAt, renderTime } from '../format.js';
import { ADD_TOOL_STYLES, ADD_TOOL_ALPINE } from './tools/add/assets.js';

interface ToolRow {
  tool: string;
  file_policy: unknown;
  override: unknown;
  effective: unknown;
}

interface Metric {
  tool: string;
  total: number;
  allow: number;
  deny: number;
  /** Optional 24 hourly buckets covering the past 24h. Empty/absent when unavailable. */
  buckets_24h?: number[];
}

interface DenyEntry {
  ts: number;
  tool: string;
  rule?: string;
}

export interface ToolsViewInput {
  policies: ToolRow[];
  recent_denies: DenyEntry[];
  metrics: Metric[];
  /** Caller passes the pending approvals count; 0 if approvals are not wired. */
  pending_approvals_count?: number;
  /** Current time in ms; injected so output is deterministic in tests. */
  now?: number;
}

const SHOW_DENIES_HREF = '/admin/audit?decision=deny';

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function topDenyRuleLabel(denies: DenyEntry[]): string {
  if (denies.length === 0) return '—';
  const counts = new Map<string, number>();
  for (const d of denies) {
    const rule = d.rule;
    if (!rule) continue;
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  if (counts.size === 0) return '—';
  let bestRule = '';
  let bestCount = 0;
  for (const [rule, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestRule = rule;
    }
  }
  return `${bestRule} (${bestCount})`;
}

function renderKpiStrip(view: ToolsViewInput, now: number): string {
  const totalCalls24h = sum(view.metrics.flatMap((m) => m.buckets_24h ?? []));
  const hasBuckets = view.metrics.some((m) => (m.buckets_24h?.length ?? 0) > 0);

  // Calls KPI: when buckets are plumbed, this is a genuine 24h window.
  // Otherwise, fall back to all-time totals with a relabeled KPI so we
  // don't silently fabricate a "24h" claim.
  const callsLabel = hasBuckets ? 'calls, last 24 h' : 'total calls';
  const callsValue = hasBuckets ? totalCalls24h : sum(view.metrics.map((m) => m.total));

  // Denies: only all-time `deny` counters are available per-tool, so this
  // is intentionally labelled "total denies" to stay honest.
  const totalDenies = sum(view.metrics.map((m) => m.deny));
  const totalCalls = sum(view.metrics.map((m) => m.total));

  const callsHint = hasBuckets ? 'sum of the last 24 hourly buckets' : 'cumulative since process start';
  const blockedHint =
    totalCalls > 0 ? `${formatDenyRate(totalDenies, totalCalls)} · ${formatDenyBasis(totalDenies, totalCalls)}` : 'No calls yet';

  const cells = [
    kpi(callsLabel, formatNumber(callsValue), callsHint, 'kpi-primary'),
    kpi('Blocked by policy', formatNumber(totalDenies), blockedHint, 'kpi-primary'),
    kpi('tools', formatNumber(view.policies.length)),
    kpi('pending approvals', formatNumber(view.pending_approvals_count ?? 0)),
    kpi('top deny rule', topDenyRuleLabel(view.recent_denies), 'Most frequent rule in the last 50 denies'),
  ].join('\n');
  const scope = hasBuckets
    ? 'CLI calls · calls from the last 24 hourly buckets; denies cumulative since process start'
    : 'CLI calls · cumulative counters since process start';
  return `<p class="metrics-scope">${scope} · generated ${renderGeneratedAt(now)}.</p>
<div class="kpi-strip">${cells}</div>
<p class="metrics-actions"><a href="${SHOW_DENIES_HREF}">Show denies</a> in the audit log</p>`;
}

function renderToolRow(p: ToolRow, m: Metric | undefined): string {
  const policyPill = p.override ? pill('override', 'override') : pill('file', 'file');
  // Missing bucket data draws no sparkline (not a line of zeros).
  const sparkHtml = spark(m?.buckets_24h, { width: 24 });
  const total = m?.total ?? 0;
  const allow = m?.allow ?? 0;
  const deny = m?.deny ?? 0;
  const toolEsc = escapeHtml(p.tool);
  // Filtering reads the tool name from the row's data-tool attribute via
  // $el.dataset.tool — that avoids embedding user-controlled text into an
  // Alpine expression where attribute-decoded entities could break parsing.
  return `<tr data-tool="${toolEsc}" x-show="!q || $el.dataset.tool.toLowerCase().includes(q.toLowerCase())">
        <td><a href="/admin/tools/${toolEsc}">${toolEsc}</a></td>
        <td>${policyPill}</td>
        <td class="spark-cell">${sparkHtml}</td>
        <td class="num">${escapeHtml(formatNumber(total))}</td>
        <td class="num">${escapeHtml(formatNumber(allow))}</td>
        <td class="num">${escapeHtml(formatNumber(deny))}</td>
      </tr>`;
}

function renderToolsCard(view: ToolsViewInput): string {
  const metricsByTool = new Map(view.metrics.map((m) => [m.tool, m]));
  const rows = view.policies
    .slice()
    .sort((a, b) => a.tool.localeCompare(b.tool))
    .map((p) => renderToolRow(p, metricsByTool.get(p.tool)))
    .join('');

  const body = view.policies.length === 0
    ? `<p class="muted">no cli_passthrough tools configured</p>`
    : `<div x-data="{ q: '' }">
  <div class="row" style="margin-bottom:var(--gap-sm)">
    <input type="search" placeholder="filter tools..." x-model="q" style="min-width:14rem" />
  </div>
  <div class="table-scroll">
  <table>
    <thead><tr>
      <th>name</th>
      <th>policy</th>
      <th>24h</th>
      <th class="num">total</th>
      <th class="num">allow</th>
      <th class="num">deny</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</div>`;

  return card({ title: 'tools', body });
}

function renderDeniesCard(view: ToolsViewInput, now: number): string {
  const denyRows = view.recent_denies.slice(0, 10).map((d) =>
    `<tr>
      <td class="nowrap">${renderTime(d.ts, now)}</td>
      <td>${escapeHtml(d.tool)}</td>
      <td>${pill(d.rule ?? '')}</td>
    </tr>`,
  ).join('');

  const body = view.recent_denies.length === 0
    ? `<p class="muted">no denies yet</p>`
    : `<div class="table-scroll"><table>
  <thead><tr><th>when</th><th>tool</th><th>rule</th></tr></thead>
  <tbody>${denyRows}</tbody>
</table></div>`;

  return card({ title: 'recent denies', body });
}

// "Add tool" card — typed-fields form for http/cli runtime tools plus a list
// of persisted runtime tools with delete. Entirely client-side: the form POSTs
// to /api/v1/tools (zod-validated server-side) and lists via GET. The markup is
// static; operator input lives only in Alpine state, so no user value is ever
// interpolated into server-rendered HTML.
function renderAddToolCard(): string {
  const body = `<div x-data="addToolForm">
  <noscript><p>Enable JavaScript to use the tool setup wizard.</p></noscript>
  <form class="tool-wizard" novalidate x-cloak @submit.prevent="advance()">
    <ol class="wizard-steps" aria-label="Tool setup steps">
      <template x-for="(label, index) in steps" :key="label">
        <li :aria-current="step === index ? 'step' : null">
          <span x-text="index + 1"></span><span x-text="label"></span>
        </li>
      </template>
    </ol>

    <section x-show="step === 0" aria-labelledby="tool-driver-heading">
      <h3 id="tool-driver-heading" tabindex="-1">Choose a driver</h3>
      <div class="wizard-drivers">
        <label class="wizard-driver">
          <input type="radio" name="tool-driver" value="http" x-model="type" />
          <span><strong>HTTP endpoint</strong><small>Expose one operation from a web API.</small></span>
        </label>
        <label class="wizard-driver">
          <input type="radio" name="tool-driver" value="cli" x-model="type" />
          <span><strong>Fixed CLI command</strong><small>Run a configured executable with an argument template.</small></span>
        </label>
        <label class="wizard-driver">
          <input type="radio" name="tool-driver" value="mcp_proxy" x-model="type" />
          <span><strong>MCP server</strong><small>Proxy every tool of an upstream MCP server (host must be in <code>server.mcp_upstream_allowlist</code>).</small></span>
        </label>
      </div>
      <p class="muted">CLI passthrough is configured in the <a href="https://kamilrybacki.github.io/splice-dock/tools.html#drivers">gateway YAML</a>.</p>
    </section>

    <section x-show="step === 1" aria-labelledby="tool-details-heading">
      <h3 id="tool-details-heading" tabindex="-1">Name your tool</h3>
      <div class="add-tool-grid">
        <div class="field" x-show="type !== 'mcp_proxy'"><label for="new-tool-namespace">Namespace</label><input id="new-tool-namespace" x-model="namespace" placeholder="catalog" /></div>
        <div class="field"><label for="new-tool-name">Name</label><input id="new-tool-name" x-model="name" placeholder="product" /></div>
        <div class="field full"><label for="new-tool-description">Description</label><input id="new-tool-description" x-model="description" placeholder="Look up a product by SKU" /></div>
      </div>
      <p class="muted" x-show="type !== 'mcp_proxy'">MCP name <code x-text="toolId"></code></p>
      <p class="muted" x-show="type === 'mcp_proxy'">Upstream tools appear as <code x-text="(name.trim() || 'name') + '__<tool>'"></code></p>
    </section>

    <section x-show="step === 2" aria-labelledby="tool-config-heading">
      <h3 id="tool-config-heading" tabindex="-1" x-text="type === 'http' ? 'Configure the endpoint' : type === 'mcp_proxy' ? 'Configure the MCP server' : 'Configure the command'"></h3>
      <div class="add-tool-grid" x-show="type === 'mcp_proxy'">
        <div class="field"><label for="new-tool-host">Host (service DNS)</label><input id="new-tool-host" x-model="host" placeholder="my-mcp.tools.svc.cluster.local" /></div>
        <div class="field"><label for="new-tool-port">Port</label><input id="new-tool-port" type="number" min="1" max="65535" x-model.number="port" /></div>
        <div class="field"><label for="new-tool-transport">Transport</label>
          <select id="new-tool-transport" x-model="transport"><option value="streamable_http">Streamable HTTP (/mcp)</option><option value="sse">SSE (/sse)</option></select></div>
        <div class="field"><label for="new-tool-mcp-auth">Authentication</label>
          <select id="new-tool-mcp-auth" x-model="authType"><option value="none">None</option><option value="bearer">Bearer token</option><option value="basic">Basic auth</option><option value="header">Custom header</option></select></div>
        <template x-if="type === 'mcp_proxy' && authType === 'bearer'"><div class="field full">
          <label for="new-tool-mcp-token">Token reference</label><input id="new-tool-mcp-token" x-model="authToken" placeholder="env:UPSTREAM_TOKEN" />
        </div></template>
        <template x-if="type === 'mcp_proxy' && authType === 'basic'"><div class="add-tool-grid full">
          <div class="field"><label>Username reference</label><input x-model="authUser" placeholder="env:API_USER" /></div>
          <div class="field"><label>Password reference</label><input x-model="authPass" placeholder="env:API_PASSWORD" /></div>
        </div></template>
        <template x-if="type === 'mcp_proxy' && authType === 'header'"><div class="add-tool-grid full">
          <div class="field"><label>Header name</label><input x-model="authHeaderName" placeholder="X-Api-Key" /></div>
          <div class="field"><label>Header value reference</label><input x-model="authHeaderValue" placeholder="env:API_KEY" /></div>
        </div></template>
        <p class="muted full">Tools are discovered automatically and refreshed every 10 minutes. Add the resulting <code>name__tool</code> ids to a profile to use them.</p>
      </div>
      <div class="add-tool-grid" x-show="type === 'http'">
        <div class="field"><label for="new-tool-method">Method</label>
          <select id="new-tool-method" x-model="method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></div>
        <div class="field"><label for="new-tool-auth">Authentication</label>
          <select id="new-tool-auth" x-model="authType"><option value="none">None</option><option value="bearer">Bearer token</option><option value="basic">Basic auth</option><option value="header">Custom header</option></select></div>
        <div class="field full"><label for="new-tool-url">Endpoint URL</label><input id="new-tool-url" x-model="url" placeholder="https://api.example.com/products/{sku}" /></div>
        <template x-if="authType === 'bearer'"><div class="field full">
          <label for="new-tool-token-ref">Token reference</label><input id="new-tool-token-ref" x-model="authToken" placeholder="env:CATALOG_API_TOKEN" />
        </div></template>
        <template x-if="authType === 'basic'"><div class="add-tool-grid full">
          <div class="field"><label for="new-tool-user-ref">Username reference</label><input id="new-tool-user-ref" x-model="authUser" placeholder="env:API_USER" /></div>
          <div class="field"><label for="new-tool-pass-ref">Password reference</label><input id="new-tool-pass-ref" x-model="authPass" placeholder="env:API_PASSWORD" /></div>
        </div></template>
        <template x-if="authType === 'header'"><div class="add-tool-grid full">
          <div class="field"><label for="new-tool-header-name">Header name</label><input id="new-tool-header-name" x-model="authHeaderName" placeholder="X-Api-Key" /></div>
          <div class="field"><label for="new-tool-header-ref">Header value reference</label><input id="new-tool-header-ref" x-model="authHeaderValue" placeholder="env:API_KEY" /></div>
        </div></template>
        <p class="muted full" x-show="authType !== 'none'">Use an <code>env:</code> or <code>vault:</code> reference for each credential.</p>
      </div>
      <div class="add-tool-grid" x-show="type === 'cli'">
        <div class="field"><label for="new-tool-command">Executable</label><input id="new-tool-command" x-model="command" placeholder="node" /></div>
        <div class="field"><label for="new-tool-timeout">Timeout (ms)</label><input id="new-tool-timeout" type="number" min="1000" max="300000" x-model.number="timeoutMs" /></div>
        <p class="muted full">The executable must be listed in <code>server.cli_whitelist</code>.</p>
        <div class="field full">
          <label for="new-tool-arg">Command arguments</label>
          <div class="row"><input id="new-tool-arg" x-model="argInput" @keydown.enter.prevent="addArg()" placeholder="--version" /><button type="button" @click="addArg()">Add argument</button></div>
          <div class="row wizard-chips"><template x-for="(arg, i) in args" :key="i"><span class="tag-chip"><span x-text="arg"></span><button type="button" @click="removeArg(i)" aria-label="Remove argument">×</button></span></template></div>
        </div>
      </div>
      <details class="wizard-optional" x-show="type !== 'mcp_proxy'">
        <summary>Parameters and optional settings</summary>
        <div class="field" x-show="type === 'cli'">
          <label for="new-tool-env">Environment variables to pass through</label>
          <div class="row"><input id="new-tool-env" x-model="envInput" @keydown.enter.prevent="addEnv()" placeholder="ENV_NAME" /><button type="button" @click="addEnv()">Add variable</button></div>
          <div class="row wizard-chips"><template x-for="(env, i) in envs" :key="i"><span class="tag-chip"><span x-text="env"></span><button type="button" @click="removeEnv(i)" aria-label="Remove variable">×</button></span></template></div>
        </div>
        <p class="muted">Parameters are inputs the MCP client can provide when it calls this tool.</p>
        <template x-for="(param, index) in params" :key="param._id">
          <div class="param-row">
            <label>Parameter name <input x-model="param.name" placeholder="sku" /></label>
            <label x-show="type === 'http'">Location <select x-model="param.in"><option>query</option><option>path</option><option>body</option><option>header</option></select></label>
            <label>Default <input x-model="param.default" placeholder="Optional" /></label>
            <label class="req-cell"><input type="checkbox" x-model="param.required" /> Required</label>
            <button type="button" @click="removeParam(index)" aria-label="Remove parameter">×</button>
          </div>
        </template>
        <button type="button" @click="addParam()">Add parameter</button>
      </details>
    </section>

    <section x-show="step === 3" aria-labelledby="tool-review-heading">
      <h3 id="tool-review-heading" tabindex="-1">Review and save</h3>
      <dl class="wizard-review">
        <dt>MCP name</dt><dd><code x-text="toolId"></code></dd>
        <dt>Driver</dt><dd x-text="type === 'http' ? 'HTTP endpoint' : type === 'mcp_proxy' ? 'MCP server' : 'Fixed CLI command'"></dd>
        <dt>Description</dt><dd x-text="description.trim()"></dd>
        <dt x-text="type === 'http' ? 'Endpoint' : type === 'mcp_proxy' ? 'Server' : 'Command'"></dt>
        <dd><code x-text="type === 'http' ? method + ' ' + url.trim() : type === 'mcp_proxy' ? host.trim() + ':' + port + ' (' + transport + ')' : [command.trim(), ...args].join(' ')"></code></dd>
        <dt x-show="type !== 'mcp_proxy'">Parameters</dt><dd x-show="type !== 'mcp_proxy'" x-text="params.length"></dd>
      </dl>
      <details class="wizard-optional"><summary>View configuration JSON</summary><pre x-text="step === 3 ? JSON.stringify(_buildConfig(), null, 2) : ''"></pre></details>
      <p class="muted">Add <code x-text="type === 'mcp_proxy' ? name.trim() + '__*' : toolId"></code> to a client’s <a href="/admin/profiles">profile</a> so it can use this tool.</p>
    </section>

    <p class="wizard-error" role="alert" x-show="formError" x-text="formError"></p>
    <div class="wizard-actions">
      <button type="button" @click="back()" x-show="step > 0" :disabled="busy">Back</button>
      <button type="submit" class="primary" :disabled="busy" x-text="step === 3 ? (busy ? 'Saving…' : 'Save tool') : 'Continue'"></button>
    </div>
  </form>

  <div class="runtime-tools" x-cloak>
    <h3>Runtime tools</h3>
    <p role="status" class="add-tool-msg" :class="{ 'wizard-error': msgError }" x-text="msg"></p>
    <template x-if="runtimeTools.length === 0"><p class="muted">No runtime tools yet.</p></template>
    <table class="rt-tools-table" x-show="runtimeTools.length > 0">
      <thead><tr><th>Name</th><th>Driver</th><th>Actions</th></tr></thead>
      <tbody>
        <template x-for="tool in runtimeTools" :key="tool.id">
          <tr><td x-text="tool.id"></td><td x-text="tool.driver"></td><td><button type="button" class="ghost" @click="removeTool(tool.id)">Delete</button></td></tr>
        </template>
      </tbody>
    </table>
  </div>
</div>`;
  return card({ title: 'Add tool', body });
}

export function renderToolsPage(view: ToolsViewInput): string {
  const now = view.now ?? Date.now();
  return `<style>${ADD_TOOL_STYLES}</style>
<h1>Tools</h1>
${renderKpiStrip(view, now)}
${renderToolsCard(view)}
${renderAddToolCard()}
${renderDeniesCard(view, now)}
<script>${ADD_TOOL_ALPINE}</script>`;
}
