import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProfileService } from '../../../src/application/profiles/profile-service.js';
import { ToolRegistry } from '../../../src/application/registry/tool-registry.js';
import { ProfileRegistry } from '../../../src/application/registry/profile-registry.js';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      setRequestHandler: vi.fn(),
      connect: vi.fn(),
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: 'ListToolsRequestSchema',
  CallToolRequestSchema: 'CallToolRequestSchema',
}));

vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => ({
  SSEServerTransport: vi.fn(),
}));

// Import after mocking
const { buildMcpServer } = await import('../../../src/adapters/inbound/mcp/server.js');
const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');

describe('buildMcpServer', () => {
  let profileService: ProfileService;
  let toolReg: ToolRegistry;
  let profileReg: ProfileRegistry;

  beforeEach(() => {
    toolReg = new ToolRegistry();
    profileReg = new ProfileRegistry();
    profileReg.addFileProfile('coding', { tools: ['github__*'] });
    toolReg.addFileTool({
      id: 'github__search',
      driver: 'http',
      source: 'file',
      config: { type: 'http', name: 'search', namespace: 'github', description: 'Search', method: 'GET', url: 'https://x.com', params: [], auth: { type: 'none' } },
      mcpDef: { name: 'github__search', description: 'Search', inputSchema: { type: 'object' } },
    });
    profileService = new ProfileService(profileReg, toolReg);
  });

  afterEach(() => vi.clearAllMocks());

  it('creates a Server and registers ListTools and CallTool handlers', () => {
    buildMcpServer('coding', profileService, new Map());
    const MockedServer = vi.mocked(Server);
    const instance = MockedServer.mock.results[0].value;
    expect(instance.setRequestHandler).toHaveBeenCalledTimes(2);
  });

  it('returns a Server instance', () => {
    const server = buildMcpServer('coding', profileService, new Map());
    expect(server).toBeDefined();
  });
});
