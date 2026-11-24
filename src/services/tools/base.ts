import type { ToolRegistry } from './registry.js';
import type { McpToolDef } from '../../contracts/internal/mcp/tool.js';
import type { HttpToolConfig, CliToolConfig, CliPassthroughToolConfig } from '../../config/types.js';

export interface ToolDefinitions {
  buildMcpDefForHttpTool(config: HttpToolConfig): McpToolDef;
  buildMcpDefForCliTool(config: CliToolConfig): McpToolDef;
  buildMcpDefsForCliPassthroughTool(config: CliPassthroughToolConfig): McpToolDef[];
}

export class ToolService implements ToolDefinitions {
  constructor(private readonly tools: ToolRegistry) {}

  buildMcpDefForHttpTool(config: HttpToolConfig): McpToolDef {
    const id = `${config.namespace}__${config.name}`;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const param of config.params) {
      properties[param.name] = param.format === 'json'
        ? { type: 'object', description: `${param.in} parameter (JSON value)` }
        : { type: 'string', description: `${param.in} parameter` };
      if (param.required) required.push(param.name);
    }
    return {
      name: id,
      description: config.description,
      inputSchema: {
        type: 'object',
        properties,
        required: required.length ? required : undefined,
      },
    };
  }

  buildMcpDefForCliTool(config: CliToolConfig): McpToolDef {
    const id = `${config.namespace}__${config.name}`;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const param of config.params) {
      properties[param.name] = {
        type: 'string',
        description: param.default !== undefined ? `(default: ${param.default})` : undefined,
      };
      if (param.required) required.push(param.name);
    }
    return {
      name: id,
      description: config.description,
      inputSchema: {
        type: 'object',
        properties,
        required: required.length ? required : undefined,
      },
    };
  }

  // One cli_passthrough config produces two tools: __help for capability discovery
  // and __run for invocation. Claude calls __help first, reads the CLI's own help
  // text, then invokes __run with a typed args array (no shell parsing).
  buildMcpDefsForCliPassthroughTool(config: CliPassthroughToolConfig): McpToolDef[] {
    const deny = config.deny_subcommands.length
      ? ` Denied subcommands: ${config.deny_subcommands.join(', ')}.`
      : '';
    return [
      {
        name: `${config.name}__help`,
        description: `${config.description} — fetch help text to discover subcommands and flags. Call this before __run when unsure of available options.`,
        inputSchema: {
          type: 'object',
          properties: {
            subcommand: {
              type: 'string',
              description: 'Optional subcommand path (e.g. "pr create"). Leave empty for top-level help.',
            },
          },
        },
      },
      {
        name: `${config.name}__run`,
        description: `${config.description} — execute with a typed argv array (no shell parsing). Use __help first to learn subcommands. For approval-gated operations supply approval_context: one or two sentences explaining why this conversation needs the operation.${deny}`,
        inputSchema: {
          type: 'object',
          properties: {
            approval_context: { type: 'string', maxLength: 500, description: 'Why this operation is needed in this conversation (one or two sentences).' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Argv passed to the CLI as individual tokens, e.g. ["pr", "create", "--title", "My PR"].',
            },
            cwd: {
              type: 'string',
              description: 'Working directory for the command. Pass the current project/repo path so workspace-aware tools (git context, local config, file arguments) resolve correctly. Omit to use the splicedock process cwd.',
            },
          },
          required: ['args'],
        },
      },
    ];
  }
}
