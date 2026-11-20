import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';

export interface StubTool {
  name: string;
  description: string;
  response: string;
}

export interface StubUpstream {
  port: number;
  /** host:port string suitable for service_dns + port use */
  host: string;
  /** Legacy field kept for compatibility */
  url: string;
  teardown(): Promise<void>;
}

export async function createStubUpstream(tools: StubTool[]): Promise<StubUpstream> {
  const app = express();
  app.use(express.json());

  // Stateless Streamable HTTP endpoint — one transport per request
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    const mcpServer = new Server(
      { name: 'stub-upstream', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object' as const, properties: {} },
      })),
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = tools.find(t => t.name === req.params.name);
      if (!tool) {
        return { content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: tool.response }] };
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Also handle GET /mcp for SSE streaming (required for Streamable HTTP spec)
  app.get('/mcp', async (req, res) => {
    res.status(405).json({ error: 'Method Not Allowed' });
  });

  app.delete('/mcp', async (req, res) => {
    res.status(405).json({ error: 'Method Not Allowed' });
  });

  const httpServer: HttpServer = createServer(app);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as { port: number }).port;

  return {
    port,
    host: `127.0.0.1`,
    url: `http://127.0.0.1:${port}/mcp`,
    async teardown() {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        httpServer.close(err => (err ? reject(err) : resolve())),
      );
    },
  };
}
