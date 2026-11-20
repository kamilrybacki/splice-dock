import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileService } from '../../../src/application/profiles/profile-service.js';
import { ProfileRegistry } from '../../../src/application/registry/profile-registry.js';
import { ToolRegistry } from '../../../src/application/registry/tool-registry.js';
import type { RegistryEntry } from '../../../src/application/registry/tool-registry.js';

function makeEntry(id: string): RegistryEntry {
  return {
    id,
    driver: 'http',
    source: 'file',
    config: { type: 'http', name: id, namespace: 'ns', description: 'desc', method: 'GET', url: 'http://example.com', params: [], auth: { type: 'none' } },
    mcpDef: { name: id, description: `desc-${id}`, inputSchema: { type: 'object' } },
  };
}

describe('ProfileService', () => {
  let profileRegistry: ProfileRegistry;
  let toolRegistry: ToolRegistry;
  let service: ProfileService;

  beforeEach(() => {
    profileRegistry = new ProfileRegistry();
    toolRegistry = new ToolRegistry();
    service = new ProfileService(profileRegistry, toolRegistry);
  });

  it('returns empty array for unknown profile', () => {
    expect(service.getToolsForProfile('nonexistent')).toEqual([]);
  });

  it('returns tools matching exact pattern', () => {
    toolRegistry.addFileTool(makeEntry('jira__get_issue'));
    toolRegistry.addFileTool(makeEntry('github__list_prs'));
    profileRegistry.addFileProfile('dev', { tools: ['jira__get_issue'] });
    const tools = service.getToolsForProfile('dev');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('jira__get_issue');
  });

  it('supports glob patterns', () => {
    toolRegistry.addFileTool(makeEntry('jira__get_issue'));
    toolRegistry.addFileTool(makeEntry('jira__create_issue'));
    toolRegistry.addFileTool(makeEntry('github__list_prs'));
    profileRegistry.addFileProfile('jira-only', { tools: ['jira__*'] });
    const tools = service.getToolsForProfile('jira-only');
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toContain('jira__get_issue');
    expect(tools.map(t => t.name)).toContain('jira__create_issue');
  });

  it('supports multiple patterns in a profile', () => {
    toolRegistry.addFileTool(makeEntry('jira__get_issue'));
    toolRegistry.addFileTool(makeEntry('github__list_prs'));
    toolRegistry.addFileTool(makeEntry('slack__send_message'));
    profileRegistry.addFileProfile('mixed', { tools: ['jira__*', 'github__*'] });
    const tools = service.getToolsForProfile('mixed');
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).not.toContain('slack__send_message');
  });

  it('isToolAllowedForProfile returns true for matching tool', () => {
    profileRegistry.addFileProfile('p', { tools: ['jira__*'] });
    expect(service.isToolAllowedForProfile('p', 'jira__get_issue')).toBe(true);
  });

  it('isToolAllowedForProfile returns false for non-matching tool', () => {
    profileRegistry.addFileProfile('p', { tools: ['jira__*'] });
    expect(service.isToolAllowedForProfile('p', 'github__list_prs')).toBe(false);
  });

  it('isToolAllowedForProfile returns false for unknown profile', () => {
    expect(service.isToolAllowedForProfile('nonexistent', 'tool-x')).toBe(false);
  });
});
