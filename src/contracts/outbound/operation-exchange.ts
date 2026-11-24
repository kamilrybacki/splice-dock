import type { CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ObservedOperation =
  | { driver: 'cli' | 'cli_passthrough'; command: string; argv: readonly string[]; cwd: string; approvalContext?: string }
  | { driver: 'mcp_proxy'; url: string; method: 'tools/call'; params: { name: string; arguments: Record<string, unknown> } };

export type OperationExchange = (
  operation: ObservedOperation,
  invoke: () => Promise<CompatibilityCallToolResult>,
) => Promise<CompatibilityCallToolResult>;
