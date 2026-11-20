import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { executeWithPreflight } from '../../../src/application/code-mode/preflight.js';
import { callCliTool } from '../../../src/adapters/outbound/drivers/cli-wrapper.js';
import { callReviewedCliPassthrough } from '../../../src/adapters/outbound/drivers/cli-passthrough-wrapper.js';
import { McpProxyDriver } from '../../../src/adapters/outbound/drivers/mcp-proxy.js';
import type { CliToolConfig, CliPassthroughToolConfig } from '../../../src/config/types.js';

describe('Code Mode driver preflight', () => {
  it.each([false, true])('reviews actual CLI argv and only starts the process in enforce=%s', async allowLive => {
    const config: CliToolConfig = {
      type: 'cli', name: 'echo', namespace: 'demo', description: 'demo',
      command: 'node', args: ['-e', 'console.log(process.argv[1])', '{value}'],
      params: [{ name: 'value', in: 'body', required: true }],
      auth: 'none', env: [], timeout_ms: 3000,
    };
    let reviewed = false;
    const result = await executeWithPreflight({
      code: 'return await tools.call("demo__echo", {value:"sample"});', profile: 'test',
      catalog: () => [], allowLive,
      dispatch: (_tool, args, phase, _http, signal, exchange) => {
        if (phase === 'live') expect(reviewed).toBe(true);
        return callCliTool(config, { value: String(args.value) }, ['node'], exchange, signal);
      },
      services: {
        mock: async () => { throw Error('Unexpected HTTP operation'); },
        mockOperation: async request => {
          expect(request).toMatchObject({ driver: 'cli', command: 'node', argv: [...config.args.slice(0, 2), 'sample'] });
          return { content: [{ type: 'text', text: 'simulated output' }] };
        },
        review: async () => { reviewed = true; return true; },
      },
    });
    expect(reviewed).toBe(true);
    expect(!!result.isError).toBe(!allowLive);
    if (allowLive) expect(result.structuredContent).toMatchObject({ result: { content: [{ text: 'sample\n' }] } });
  });

  it('keeps the live passthrough DENY policy after a reviewer allows a simulated command', async () => {
    const config = { type: 'cli_passthrough', name: 'demo', command: 'node', description: 'demo',
      policy: { deny_subcommands: ['fixture'] }, timeout_ms: 3000, env: [] } as CliPassthroughToolConfig;
    let captured: unknown;
    const result = await executeWithPreflight({
      code: 'return await tools.call("demo__run",{args:["fixture"]});', profile: 'test', catalog: () => [],
      allowLive: true,
      dispatch: (_tool, args, _phase, _http, signal, exchange) =>
        callReviewedCliPassthrough(config, 'run', args, ['node'], exchange, signal),
      services: {
        mock: async () => { throw Error('Unexpected HTTP operation'); },
        mockOperation: async request => { captured = request; return { content: [] }; },
        review: async () => true,
      },
    });
    expect(captured).toMatchObject({ driver: 'cli_passthrough', argv: ['fixture'] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Denied by policy.');
  });

  it.each([false, true])('captures the RPC before any upstream tools/call, enforce=%s', async allowLive => {
    const wire: Array<Record<string, unknown>> = [];
    const upstream = createServer(async (req, res) => {
      if (req.method !== 'POST') return res.writeHead(405).end();
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (!('id' in rpc)) return res.writeHead(202).end();
      const data = rpc.method === 'initialize'
        ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } }
        : rpc.method === 'tools/list'
          ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'actual' }] };
      if (rpc.method === 'tools/call') wire.push(rpc.params);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: data }));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture address');
    const driver = new McpProxyDriver({ type: 'mcp_proxy', name: 'demo', service_dns: '127.0.0.1',
      port: address.port, refresh_interval_ms: 60_000 });
    try {
      await driver.connect();
      const result = await executeWithPreflight({
        code: 'return await tools.call("demo__read", { value: 2 });', profile: 'test', catalog: () => [],
        allowLive,
        dispatch: (tool, args, _phase, _http, signal, exchange) => driver.callReviewedTool(tool, args, exchange, signal),
        services: {
          mock: async () => { throw Error('Unexpected HTTP operation'); },
          mockOperation: async request => {
            expect(wire).toEqual([]);
            expect(request).toMatchObject({ driver: 'mcp_proxy', method: 'tools/call',
              url: `http://127.0.0.1:${address.port}/mcp`, params: { name: 'read', arguments: { value: 2 } } });
            return { content: [{ type: 'text', text: 'mock' }] };
          },
          review: async () => { expect(wire).toEqual([]); return true; },
        },
      });
      expect(!!result.isError, JSON.stringify(result)).toBe(!allowLive);
      expect(wire).toEqual(allowLive ? [{ name: 'read', arguments: { value: 2 } }] : []);
    } finally {
      await driver.disconnect();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
