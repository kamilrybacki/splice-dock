import type { McpToolDef } from '../../contracts/internal/mcp-tool.js';
import type { CompatibilityCallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export const codeModeDef: Tool = {
  name: 'code_mode__execute',
  description: 'Execute an async JavaScript workflow. Use tools.list(), tools.search(query), and await tools.call(name, args). Return only the data needed. Every call uses your profile and normal approvals. No filesystem, network, or timers. Limits: 50 calls, 4 concurrent, 30 seconds, 64 KiB result. Operations are never replayed automatically; completed side effects survive errors/timeouts.',
  inputSchema: { type: 'object', properties: { code: { type: 'string', maxLength: 65536 } }, required: ['code'], additionalProperties: false },
};

export interface CodeExecutor {
  (
    code: string,
    catalog: () => McpToolDef[],
    dispatch: (name: string, args: Record<string, unknown>) => Promise<CompatibilityCallToolResult>,
    signal?: AbortSignal,
  ): Promise<CompatibilityCallToolResult>;
}
