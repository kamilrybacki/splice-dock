/**
 * Gateway-owned result of a tool call. Structurally compatible with the MCP
 * SDK's call-tool result, but defined here so the domain does not import it.
 */
export type ToolContentBlock = { type: string; [key: string]: unknown };

export interface ToolResult {
  content?: ToolContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}
