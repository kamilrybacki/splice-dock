import { resolveBoundProfile } from '../../../src/services/mcp/base.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../../src/services/mcp/adapters/express/server.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { logger } from '../../../src/common/logger.js';

afterEach(() => vi.restoreAllMocks());

async function callEcho(agent: string | undefined, clientName = 'test-client', version = '9.9.9') {
  const toolReg = new ToolRegistry();
  toolReg.addFileTool({
    id: 'echo', driver: 'http', source: 'file',
    config: { type: 'http', name: 'echo', namespace: 'x', description: 'e', method: 'GET', url: 'http://127.0.0.1:1', params: [], auth: { type: 'none' } },
    mcpDef: { name: 'echo', description: 'e', inputSchema: { type: 'object' } },
  });
  const profiles = new ProfileRegistry();
  profiles.addFileProfile('ops', { tools: ['*'] });
  const server = buildMcpServer('ops', new ProfileService(profiles, toolReg), new Map(), toolReg, [], undefined, undefined, agent);
  const client = new Client({ name: clientName, version });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  await client.callTool({ name: 'echo', arguments: { secret: 'ARGVALUE' } }).catch(() => {});
  await client.close();
  const call = info.mock.calls.find(c => c[0] === 'tool call');
  return call?.[1] as Record<string, unknown>;
}

describe('tool call log identity', () => {
  it('logs the token agent label', async () => {
    expect((await callEcho('claude-code'))).toMatchObject({ profile: 'ops', agent: 'claude-code' });
  });
  it('falls back to the profile name without an agent label', async () => {
    expect((await callEcho(undefined))).toMatchObject({ profile: 'ops', agent: 'ops' });
  });
  it('logs sanitised client / client_version, never args', async () => {
    const f = await callEcho('a', 'my\nclient', 'v'.repeat(100));
    expect(f).toMatchObject({ client: 'myclient', client_version: 'v'.repeat(64) });
    expect(JSON.stringify(f)).not.toContain('ARGVALUE');
  });
});

describe('resolveBoundProfile agent', () => {
  it('carries agent from the lookup', async () => {
    const r = await resolveBoundProfile('Bearer x', () => ({ profile: 'ops', id: 'i', agent: 'agent-a' }));
    expect(r.agent).toBe('agent-a');
  });
  it('agent is null for NULL label and undefined for string lookup', async () => {
    expect((await resolveBoundProfile('Bearer x', () => ({ profile: 'ops', id: 'i', agent: null }))).agent).toBeNull();
    expect((await resolveBoundProfile('Bearer x', () => 'ops')).agent).toBeUndefined();
  });
});
