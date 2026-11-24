import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationExchange } from '../../../../contracts/outbound/operation/exchange.js';
import type { ToolResult } from '../../../../contracts/outbound/tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { resolveAuthValue } from '../../../secrets/adapters/vault/resolver.js';
import { resolveCredentialSource } from '../../../secrets/adapters/resolution.js';
import type { McpProxyToolConfig } from '../../../../config/types.js';
import type { McpToolDef } from '../../../tools/registry.js';
import { retry } from '../../../../common/retry.js';
import { PACKAGE_VERSION } from '../../../../common/version.js';
import type { McpCallResult } from '../../../../contracts/internal/mcp/result.js';
export type { McpCallResult } from '../../../../contracts/internal/mcp/result.js';

/** Who is connecting to the upstream; a minted credential is minted per identity. */
export interface DriverIdentity {
  profile: string;
  agent: string | null;
}

/**
 * Build the auth headers an mcp_proxy upstream needs, from its `auth` config.
 * Upstreams that require a Bearer/Basic/custom header (e.g. a service reached directly on a custom port)
 * would otherwise need a caddy sidecar to inject the credential — with this the
 * proxy sends it directly. Returns {} for `auth: none`.
 *
 * `from:` bindings resolve to the same value for every caller; `mint:` ones go
 * through the credential broker for THIS profile/agent, so two profiles never
 * share an upstream identity.
 */
export async function buildAuthHeaders(
  auth: McpProxyToolConfig['auth'] | undefined,
  identity: DriverIdentity,
  backend: string,
): Promise<Record<string, string>> {
  // `auth` is undefined only for configs built outside zod (defaults apply the
  // literal { type: 'none' } in production); treat both as "no auth".
  if (!auth || auth.type === 'none') return {};
  const target = { profile: identity.profile, agent: identity.agent, backend };
  if (auth.type === 'bearer') {
    return { Authorization: `Bearer ${await resolveCredentialSource(auth.token, target)}` };
  }
  if (auth.type === 'basic') {
    const username = await resolveAuthValue(auth.username.from);
    const password = await resolveAuthValue(auth.password.from);
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  }
  if (auth.type === 'header') {
    return { [auth.name]: await resolveCredentialSource(auth.value, target) };
  }
  return {};
}

/** True when any part of this auth comes from the credential broker. Only then
 *  can the value change under a live connection and require a fresh session. */
function usesMintedCredential(auth: McpProxyToolConfig['auth'] | undefined): boolean {
  if (!auth) return false;
  if (auth.type === 'bearer') return 'mint' in auth.token;
  if (auth.type === 'header') return 'mint' in auth.value;
  return false;
}

/** Hash of the resolved headers. The values themselves are never kept here. */
export function authFingerprint(headers: Record<string, string>): string {
  const canonical = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Cache key for a shared driver map. A profile with its own credential needs a
 * separate upstream connection — a driver carries exactly one credential set,
 * so sharing it across profiles would send the wrong identity. Profiles without
 * an override keep the bare backend name and share the tool-level connection.
 * The NUL separator cannot appear in a tool or profile name.
 */
export const DRIVER_KEY_SEPARATOR = '\u0000';

export function proxyDriverKey(namespace: string, profile?: string): string {
  return profile === undefined ? namespace : `${namespace}${DRIVER_KEY_SEPARATOR}${profile}`;
}

/** Backend name from a driver cache key, for status/listing callers. */
export function proxyDriverNamespace(key: string): string {
  return key.split(DRIVER_KEY_SEPARATOR)[0]!;
}

export class McpProxyDriver {
  private readonly reviewedCall = new AsyncLocalStorage<{ url: string; params: { name: string; arguments: Record<string, unknown> }; sent: boolean }>();
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private toolDefs: McpToolDef[] = [];
  private knownTools = new Set<string>();
  /** Fingerprint of the headers this session was opened with (minted auth only). */
  private authFingerprint: string | null = null;

  constructor(
    private readonly config: McpProxyToolConfig,
    private readonly pinnedPodIp?: string,
    private readonly identity: DriverIdentity = { profile: '', agent: null },
  ) {}

  async connect(): Promise<void> {
    const host = this.pinnedPodIp ?? this.config.service_dns;
    const client = new Client({ name: 'splicedock', version: PACKAGE_VERSION }, { capabilities: {} });
    const hasAuth = this.config.auth !== undefined && this.config.auth.type !== 'none';
    // The upstream child is spawned per HTTP session and reads its credential
    // from the initialize request, so the session is bound to one credential
    // value. Remember which one, to notice a rotation (see callTool).
    if (usesMintedCredential(this.config.auth)) {
      this.authFingerprint = authFingerprint(await buildAuthHeaders(this.config.auth, this.identity, this.config.name));
    } else {
      this.authFingerprint = null;
    }
    // Resolve on every transport request, including reconnects and retries.
    const authenticatedFetch: typeof fetch = async (input, init) => {
      const reviewed = this.reviewedCall.getStore();
      if (reviewed) {
        const destination = input instanceof Request ? input.url : String(input);
        const rpc = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (reviewed.sent || destination !== reviewed.url || init?.method !== 'POST' ||
            rpc?.method !== 'tools/call' || JSON.stringify(rpc.params) !== JSON.stringify(reviewed.params)) {
          throw Error('Unexpected transport request during Code Mode replay');
        }
        reviewed.sent = true;
      }
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(await buildAuthHeaders(this.config.auth, this.identity, this.config.name))) headers.set(name, value);
      return fetch(input, { ...init, headers, ...(reviewed ? { redirect: 'error' as const } : {}) });
    };

    if (this.config.transport === 'sse') {
      // SSE transport: supergateway-style GET /sse stream.
      // Close and wait briefly on error so supergateway has time to process the
      // SSE stream teardown — rapid retry otherwise opens a second connection
      // while the first is still live, crashing supergateway with
      // "Already connected to a transport".
      const sseUrl = new URL(`http://${host}:${this.config.port}/sse`);
      const transport = hasAuth
        ? new SSEClientTransport(sseUrl, {
            fetch: authenticatedFetch,
            eventSourceInit: { fetch: authenticatedFetch },
          })
        : new SSEClientTransport(sseUrl);
      this.transport = transport;
      try {
        await client.connect(transport);
        this.client = client;
        await this.refreshTools();
      } catch (err) {
        try { await transport.close(); } catch { /* ignore */ }
        this.transport = null;
        await new Promise(res => setTimeout(res, 1500));
        throw err;
      }
      return;
    }

    const url = new URL(`http://${host}:${this.config.port}/mcp`);
    this.transport = new StreamableHTTPClientTransport(url, { fetch: authenticatedFetch });
    try {
      await client.connect(this.transport);
      this.client = client;
      await this.refreshTools();
    } catch (err) {
      try { await this.transport.close(); } catch { /* ignore */ }
      this.transport = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try { await this.client?.close(); } catch { /* best-effort */ }
    this.client = null;
    this.transport = null;
    this.toolDefs = [];
    this.knownTools.clear();
    this.authFingerprint = null;
  }

  getToolDefs(): McpToolDef[] { return this.toolDefs; }

  /** Returns the cached tool definitions. Useful for refresh-service callers that connect, list, then disconnect. */
  async listTools(): Promise<McpToolDef[]> { return this.toolDefs; }

  async callReviewedTool(namespacedName: string, args: Record<string, unknown>, exchange: OperationExchange, signal: AbortSignal): Promise<ToolResult> {
    const name = namespacedName.replace(`${this.config.name}__`, '');
    const client = this.client;
    if (this.config.transport === 'sse' || !client || !this.knownTools.has(name)) {
      return { content: [{ type: 'text', text: 'Code Mode requires a connected Streamable HTTP upstream' }], isError: true };
    }
    const host = this.pinnedPodIp ?? this.config.service_dns;
    const url = new URL(`http://${host}:${this.config.port}/mcp`).href;
    const params = { name, arguments: args };
    return exchange({ driver: 'mcp_proxy', url, method: 'tools/call', params }, async () => {
      signal.throwIfAborted();
      if (this.client !== client || await this.mintedCredentialRotated() || this.client !== client) {
        throw Error('MCP session changed before reviewed call');
      }
      const context = { url, params, sent: false };
      const result = await this.reviewedCall.run(context, () => client.callTool(params, undefined, { signal }));
      if (!context.sent) throw Error('MCP reviewed call did not reach the checked transport');
      return result as ToolResult;
    });
  }

  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const originalName = namespacedName.replace(`${this.config.name}__`, '');
    if (!this.knownTools.has(originalName)) {
      return { content: [{ type: 'text', text: `Tool '${originalName}' not found on upstream '${this.config.name}'` }], isError: true };
    }
    if (!this.client) {
      // The persistent transport was torn down (e.g. the upstream pod rolled while
      // this proxy was idle) and nothing re-established it in the background. The
      // post-error reconnect below only fires once a call has been attempted, so a
      // null client would otherwise wedge this upstream until the whole process is
      // restarted. Reconnect on demand; only report "not connected" if that fails.
      try {
        await this.connect();
      } catch {
        return { content: [{ type: 'text', text: `Proxy '${this.config.name}' is not connected` }], isError: true };
      }
    }
    // A minted credential has refreshed since this session opened: the upstream
    // child still holds the old value, so re-open the session before calling.
    if (await this.mintedCredentialRotated()) {
      await this.disconnect();
      try {
        await this.connect();
      } catch {
        return { content: [{ type: 'text', text: `Proxy '${this.config.name}' is not connected` }], isError: true };
      }
    }

    const max = this.config.retry?.max_attempts ?? 1;
    const backoff = this.config.retry?.backoff_ms ?? 500;
    try {
      return await retry(max, backoff, async () => {
        const result = await this.client!.callTool({ name: originalName, arguments: args });
        return result as McpCallResult;
      });
    } catch {
      // The upstream session can drop out from under the cached client. An idle SSE
      // EventSource closes silently (next POST → 503 "No active SSE connection"), and a
      // stateful Streamable HTTP upstream that restarts or expires its session returns
      // 404 `session_not_found`. Either way the cached client is dead — reconnect once
      // and retry so a single upstream blip doesn't wedge the tool until the driver is
      // recreated. Applies to BOTH transports: it was previously SSE-only, which left
      // `streamable_http` upstreams (e.g. an upstream that hands out per-session ids) permanently stuck on `session_not_found`.
      try { await this.client?.close(); } catch { /* ignore */ }
      this.client = null;
      this.transport = null;
      await this.connect();
      return await this.client!.callTool({ name: originalName, arguments: args }) as McpCallResult;
    }
  }

  private async mintedCredentialRotated(): Promise<boolean> {
    if (usesMintedCredential(this.config.auth) === false || this.authFingerprint === null) return false;
    const current = authFingerprint(await buildAuthHeaders(this.config.auth, this.identity, this.config.name));
    return current !== this.authFingerprint;
  }

  private async refreshTools(): Promise<void> {
    if (!this.client) return;
    const { tools } = await this.client.listTools();
    this.knownTools.clear();
    const namespaceHint = this.config.description ? `[${this.config.name}: ${this.config.description}] ` : '';
    this.toolDefs = tools.map(tool => {
      this.knownTools.add(tool.name);
      return {
        name: `${this.config.name}__${tool.name}`,
        description: `${namespaceHint}${tool.description ?? ''}`.trim() || undefined,
        inputSchema: tool.inputSchema as McpToolDef['inputSchema'],
      };
    });
  }
}
