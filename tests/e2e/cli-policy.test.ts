// tests/e2e/cli-policy.test.ts
//
// End-to-end coverage of the cli_passthrough policy engine: boot splicedock's
// real MCP express app in-process (no upstream bridge needed), connect with
// an MCP SDK client over SSE, and exercise __run with a configured policy.
//
// Why E2E and not unit:
//   - covers the wiring from MCP tool call → ToolRegistry → ToolService
//     → server.ts dispatch → cli-passthrough-wrapper.ts → cli-policy.ts
//   - confirms that policy denials surface as proper isError responses to the
//     MCP client, not internal exceptions
//   - confirms that the legacy top-level `deny_subcommands` field still bites
//     when consumed through the normal HTTP path
//
// Uses the system `echo` binary so the test has no docker/bridge dependency.
//
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ToolRegistry } from '../../src/services/tools/registry.js';
import { ProfileRegistry } from '../../src/services/profiles/registry.js';
import { ProfileService } from '../../src/services/profiles/base.js';
import { ToolService } from '../../src/services/tools/base.js';
import { createMcpExpressApp } from '../../src/services/mcp/adapters/express/server.js';
import type { CliPassthroughToolConfig } from '../../src/config/types.js';

const TOOL_NAME = 'echo_pass';
const RUN_TOOL = `${TOOL_NAME}__run`;

const echoPolicyConfig: CliPassthroughToolConfig = {
  type: 'cli_passthrough',
  name: TOOL_NAME,
  description: 'Echo passthrough — used by cli-policy E2E to exercise the policy engine',
  command: 'echo',
  deny_subcommands: [],
  env: [],
  timeout_ms: 5_000,
  policy: {
    allow_subcommands: ['hello', 'world'],
    deny_args: ['--token'],
    deny_args_regex: ['^--secret='],
    max_args: 32,
    on_violation: 'deny',
    audit: true,
  },
};

const echoLegacyConfig: CliPassthroughToolConfig = {
  type: 'cli_passthrough',
  name: 'echo_legacy',
  description: 'Echo passthrough using only the legacy top-level deny_subcommands',
  command: 'echo',
  deny_subcommands: ['secret'],
  env: [],
  timeout_ms: 5_000,
};

let mcpServer: Server | null = null;
let splicedockUrl = '';

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'e2e-cli-policy', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${splicedockUrl}/mcp?profile=default`));
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

describe('E2E cli-policy — live MCP HTTP path', () => {
  beforeAll(async () => {
    const toolRegistry = new ToolRegistry();
    const profileRegistry = new ProfileRegistry();
    const toolService = new ToolService();

    for (const cfg of [echoPolicyConfig, echoLegacyConfig]) {
      const defs = toolService.buildMcpDefsForCliPassthroughTool(cfg);
      for (const def of defs) {
        toolRegistry.addFileTool({
          id: def.name,
          driver: 'cli_passthrough',
          source: 'file',
          config: cfg,
          mcpDef: def,
        });
      }
    }

    profileRegistry.addFileProfile('default', { tools: ['*'] });
    const profileService = new ProfileService(profileRegistry, toolRegistry);

    const app = createMcpExpressApp(
      profileService,
      toolRegistry,
      new Map(),
      // cli_whitelist must contain the executable name, otherwise the wrapper
      // short-circuits before policy evaluation.
      ['echo'],
    );

    mcpServer = createServer(app);
    await new Promise<void>(resolve => mcpServer!.listen(0, '127.0.0.1', resolve));
    const addr = mcpServer.address() as { port: number };
    splicedockUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    if (mcpServer) {
      await new Promise<void>((resolve, reject) => {
        mcpServer!.close(err => (err ? reject(err) : resolve()));
      });
      mcpServer = null;
    }
  });

  // -------------------------------------------------------------------------
  // allow_subcommands
  // -------------------------------------------------------------------------
  it('allows a subcommand in allow_subcommands', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['hello', 'world'] },
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result).trim()).toBe('hello world');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('denies a subcommand not in allow_subcommands', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['goodbye'] },
      });
      expect(result.isError).toBe(true);
      const txt = textOf(result);
      expect(txt).toContain('Denied by policy.allow_subcommands');
      expect(txt).not.toContain("goodbye");
    } finally {
      await client.close();
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // deny_args (substring)
  // -------------------------------------------------------------------------
  it('denies an argv that contains a substring on the deny_args list', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['hello', '--token=abc'] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Denied by policy.deny_args');
    } finally {
      await client.close();
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // deny_args_regex
  // -------------------------------------------------------------------------
  it('denies an argv that matches a deny_args_regex pattern', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: ['hello', '--secret=hunter2'] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Denied by policy.deny_args_regex');
    } finally {
      await client.close();
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // max_args
  // -------------------------------------------------------------------------
  it('denies argv longer than max_args', async () => {
    const client = await connectClient();
    try {
      const long = Array.from({ length: 50 }, (_, i) => `tok${i}`);
      const result = await client.callTool({
        name: RUN_TOOL,
        arguments: { args: long },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Denied by policy.max_args');
    } finally {
      await client.close();
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Legacy top-level deny_subcommands (backward compatibility)
  // -------------------------------------------------------------------------
  it('honors legacy top-level deny_subcommands via the live MCP path', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: 'echo_legacy__run',
        arguments: { args: ['secret', 'foo'] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Denied by policy.deny_subcommands');
    } finally {
      await client.close();
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // __help is unaffected by policy
  // -------------------------------------------------------------------------
  it('__help bypasses policy and returns help output', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: `${TOOL_NAME}__help`,
        arguments: {},
      });
      // `echo --help` succeeds on coreutils, fails on busybox. Either way the
      // policy must NOT be the reason: if there is an error, it must not be
      // a policy denial.
      const txt = textOf(result);
      expect(txt).not.toContain('Denied by policy');
    } finally {
      await client.close();
    }
  }, 30_000);
});
