export interface McpCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
