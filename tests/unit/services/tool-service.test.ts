import { describe, it, expect, beforeEach } from 'vitest';
import { ToolService } from '../../../src/application/tools/tool-service.js';
import { ToolRegistry } from '../../../src/application/registry/tool-registry.js';
import type { HttpToolConfig, CliToolConfig } from '../../../src/config/types.js';

describe('ToolService', () => {
  let toolRegistry: ToolRegistry;
  let service: ToolService;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    service = new ToolService(toolRegistry);
  });

  describe('buildMcpDefForHttpTool', () => {
    it('builds an MCP def with namespace__name as the tool name', () => {
      const config: HttpToolConfig = {
        type: 'http',
        name: 'get_issue',
        namespace: 'jira',
        description: 'Get a Jira issue',
        method: 'GET',
        url: 'https://jira.example.com/issue/{issueKey}',
        params: [],
        auth: { type: 'none' },
      };
      const def = service.buildMcpDefForHttpTool(config);
      expect(def.name).toBe('jira__get_issue');
      expect(def.description).toBe('Get a Jira issue');
    });

    it('advertises format: json params as objects', () => {
      const config: HttpToolConfig = {
        type: 'http',
        name: 'ask',
        namespace: 'svc',
        description: 'desc',
        method: 'POST',
        url: 'https://api.example.com/v1/systemone',
        params: [
          { name: 'state', in: 'body', required: true },
          { name: 'questions', in: 'body', required: true, format: 'json' },
        ],
        auth: { type: 'none' },
      };
      const def = service.buildMcpDefForHttpTool(config);
      const props = def.inputSchema.properties as Record<string, { type: string }>;
      expect(props.state.type).toBe('string');
      expect(props.questions.type).toBe('object');
    });

    it('maps path params and marks required ones', () => {
      const config: HttpToolConfig = {
        type: 'http',
        name: 'get_issue',
        namespace: 'jira',
        description: 'desc',
        method: 'GET',
        url: 'https://jira.example.com/issue/{issueKey}',
        params: [
          { name: 'issueKey', in: 'path', required: true },
          { name: 'fields', in: 'query', required: false },
        ],
        auth: { type: 'none' },
      };
      const def = service.buildMcpDefForHttpTool(config);
      expect(def.inputSchema.properties).toHaveProperty('issueKey');
      expect(def.inputSchema.properties).toHaveProperty('fields');
      expect(def.inputSchema.required).toContain('issueKey');
      expect(def.inputSchema.required).not.toContain('fields');
    });

    it('omits required array when no required params', () => {
      const config: HttpToolConfig = {
        type: 'http',
        name: 'list_issues',
        namespace: 'jira',
        description: 'desc',
        method: 'GET',
        url: 'https://jira.example.com/issues',
        params: [{ name: 'project', in: 'query', required: false }],
        auth: { type: 'none' },
      };
      const def = service.buildMcpDefForHttpTool(config);
      expect(def.inputSchema.required).toBeUndefined();
    });
  });

  describe('buildMcpDefForCliTool', () => {
    it('builds an MCP def with namespace__name', () => {
      const config: CliToolConfig = {
        type: 'cli',
        name: 'list_files',
        namespace: 'fs',
        description: 'List files in a directory',
        command: 'ls',
        args: ['{path}'],
        params: [{ name: 'path', in: 'query', required: true }],
        timeout_ms: 5000,
        env: [],
        auth: 'none',
      };
      const def = service.buildMcpDefForCliTool(config);
      expect(def.name).toBe('fs__list_files');
      expect(def.description).toBe('List files in a directory');
    });

    it('includes required params and default descriptions', () => {
      const config: CliToolConfig = {
        type: 'cli',
        name: 'run',
        namespace: 'kubectl',
        description: 'Run kubectl',
        command: 'kubectl',
        args: ['{command}'],
        params: [
          { name: 'command', in: 'query', required: true },
          { name: 'namespace', in: 'query', required: false, default: 'default' },
        ],
        timeout_ms: 30000,
        env: [],
        auth: 'none',
      };
      const def = service.buildMcpDefForCliTool(config);
      expect(def.inputSchema.required).toContain('command');
      expect(def.inputSchema.required).not.toContain('namespace');
      const nsProp = def.inputSchema.properties?.['namespace'] as { description?: string };
      expect(nsProp.description).toBe('(default: default)');
    });
  });
});
