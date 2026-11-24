// A type alias (not an interface) so it is assignable to open-shaped ToolResult.
export type McpCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};
