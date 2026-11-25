import { toolSchema, type ToolConfig } from './schema.js';

/**
 * Tool-level credentials are resolved without a caller identity, so a `mint:`
 * source is only valid under `profiles.<name>.credentials`. This is the single
 * definition of that rule: the config loader throws the first message, and the
 * runtime/admin parsers (`runtimeToolSchema`) report it as a validation issue,
 * so a definition refused at load time is refused at runtime too.
 */
export interface ToolMintIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** Every minting credential source inside an HTTP auth object, with its field name. */
export function authMintSources(auth: unknown): Array<{ field: string; mint: string }> {
  if (!auth || typeof auth !== 'object') return [];
  const record = auth as Record<string, unknown>;
  if (record['type'] === 'bearer') return mintSource('token', record['token']);
  if (record['type'] === 'header') return mintSource('value', record['value']);
  return [];
}

function mintSource(field: string, source: unknown): Array<{ field: string; mint: string }> {
  if (source && typeof source === 'object' && typeof (source as { mint?: unknown }).mint === 'string') {
    return [{ field, mint: (source as { mint: string }).mint }];
  }
  return [];
}

/** Issues for every tool-level `mint:` in one tool definition (empty when valid). */
export function toolLevelMintIssues(tool: ToolConfig): ToolMintIssue[] {
  if (tool.type === 'mcp_proxy' || tool.type === 'http') {
    return authMintSources(tool.auth).map(({ field, mint }) => ({
      path: ['auth', field],
      message: `tools.${tool.name}.auth.${field}: mint '${mint}' is only valid in profiles.<name>.credentials (tool-level auth is resolved without a profile identity)`,
    }));
  }
  if (tool.type === 'cli_passthrough' && tool.env.some(ref => typeof ref !== 'string' && 'mint' in ref)) {
    return [{
      path: ['env'],
      message: `tools.${tool.name}.env: 'mint' is only valid in profiles.<name>.credentials (tool-level env is resolved at startup, without a profile identity)`,
    }];
  }
  return [];
}

/**
 * `toolSchema` plus the tool-level `mint:` rule, for every path that parses a
 * tool definition outside the config file (admin API, persisted runtime rows).
 */
export const runtimeToolSchema = toolSchema.superRefine((tool, ctx) => {
  for (const issue of toolLevelMintIssues(tool)) {
    ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});
