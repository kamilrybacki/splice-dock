// End-to-end coverage of the approval flow.
//
// Boots splicedock's MCP express app in-process with a cli_passthrough
// tool whose policy uses `on_violation: approval`. Wires a real
// ApprovalService (backed by an in-memory SQLite).
// The harness then:
//   1. Calls the tool with an approval-required argv → expects a pending row
//   2. Approves via ApprovalService.approve()
//   3. Calls again with same argv → expects success (one-shot bypass)
//   4. Calls again with same argv → expects new pending row (one-shot consumed)
//   5. Verifies that an unrelated tool's approval doesn't leak across argv shapes
//
// Uses the system `echo` binary so the test has no docker/bridge dependency.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ToolRegistry } from '../../src/services/tools/tool-registry.js';
import { ProfileRegistry } from '../../src/services/profiles/profile-registry.js';
import { ProfileService } from '../../src/services/profiles/base.js';
import { ToolService } from '../../src/services/tools/base.js';
import { createMcpExpressApp } from '../../src/services/mcp/adapters/express/server.js';
import { SplicedockStore } from '../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../src/services/approvals/base.js';
import { setApprovalHookFactory, setApprovalSettler } from '../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig } from '../../src/config/types.js';

const TOOL_NAME = 'echo_approval';
const RUN_TOOL = `${TOOL_NAME}__run`;

const approvalCfg: CliPassthroughToolConfig = {
  type: 'cli_passthrough',
  name: TOOL_NAME,
  description: 'echo with approval-required subcommand',
  command: 'echo',
  deny_subcommands: [],
  env: [],
  timeout_ms: 5_000,
  policy: {
    approval_subcommand_paths: [['undo']],
    max_args: 32,
    on_violation: 'deny',
    audit: false,
  },
};

let mcpServer: Server | null = null;
let splicedockUrl = '';
let approvalService: ApprovalService;

const E2E_TOKEN = 'placeholder-e2e-token';

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'e2e-approval', version: '1.0.0' }, { capabilities: {} });
  // Approvals require an authenticated profile token (R2); ?profile= callers are refused.
  const transport = new StreamableHTTPClientTransport(new URL(`${splicedockUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('');
}

describe('E2E approval flow — live MCP HTTP path', () => {
  beforeAll(async () => {
    const toolRegistry = new ToolRegistry();
    const profileRegistry = new ProfileRegistry();
    const toolService = new ToolService();

    const defs = toolService.buildMcpDefsForCliPassthroughTool(approvalCfg);
    for (const def of defs) {
      toolRegistry.addFileTool({
        id: def.name,
        driver: 'cli_passthrough',
        source: 'file',
        config: approvalCfg,
        mcpDef: def,
      });
    }

    profileRegistry.addFileProfile('default', { tools: ['*'] });
    const profileService = new ProfileService(profileRegistry, toolRegistry);

    const store = await SplicedockStore.open(':memory:');
    approvalService = new ApprovalService({
      store,
      ttlMs: 60_000,
      sweepIntervalMs: 0,
    });
    setApprovalHookFactory((tool, { cwd }) => approvalService.makeHook(tool, cwd));
    setApprovalSettler(approvalService);

    const app = createMcpExpressApp(profileService, toolRegistry, new Map(), ['echo'], {
      lookupProfileByToken: t => (t === E2E_TOKEN ? 'default' : null),
    });
    mcpServer = createServer(app);
    await new Promise<void>(resolve => mcpServer!.listen(0, '127.0.0.1', resolve));
    const addr = mcpServer.address() as { port: number };
    splicedockUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    setApprovalHookFactory(null);
    setApprovalSettler(null);
    approvalService?.stop();
    if (mcpServer) {
      await new Promise<void>((resolve, reject) => {
        mcpServer!.close(err => (err ? reject(err) : resolve()));
      });
      mcpServer = null;
    }
  });

  it('blocks the first call with a pending-approval message + pending row', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['undo', 'foo'] },
      });
      expect(result.isError).toBe(true);
      const txt = textOf(result);
      expect(txt).toContain('Approval required');
      expect(txt).toMatch(/approval id: [0-9a-f-]+/);
    } finally {
      await client.close();
    }
    expect(await approvalService.list({ status: 'pending' })).toHaveLength(1);
  }, 30_000);

  it('after approving, the same argv succeeds; the second retry is blocked again', async () => {
    const pending = await approvalService.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(await approvalService.approve(pending[0]!.id, 'tester')).toBe(true);

    const client = await connectClient();
    try {
      const ok = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['undo', 'foo'] },
      });
      expect(ok.isError).toBeFalsy();
      expect(textOf(ok).trim()).toBe('undo foo');

      const second = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['undo', 'foo'] },
      });
      expect(second.isError).toBe(true);
      expect(textOf(second)).toContain('Approval required');
    } finally {
      await client.close();
    }

    // First call consumed the previous row; second call created a new pending row.
    const all = await approvalService.list({});
    const consumed = all.filter(r => r.status === 'consumed');
    const stillPending = all.filter(r => r.status === 'pending');
    expect(consumed).toHaveLength(1);
    expect(stillPending).toHaveLength(1);
    expect(consumed[0]!.id).not.toEqual(stillPending[0]!.id);
  }, 30_000);

  it('approval for argv A does not unlock argv B', async () => {
    // Approve all current pending rows for argv ["undo","foo"]
    for (const row of await approvalService.list({ status: 'pending' })) {
      await approvalService.approve(row.id, 'tester');
    }
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['undo', 'bar'] }, // different argv shape
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Approval required');
    } finally {
      await client.close();
    }
  }, 30_000);
});
