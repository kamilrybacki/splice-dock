// Admin routes for cli_passthrough policy management. Mounts under the
// auth-gated plugin scope so every endpoint requires either the Bearer
// Authorization header or the WebUI session cookie.

import type { FastifyInstance } from 'fastify';

import type { SplicedockConfig, CliPassthroughToolConfig, CliToolPolicy } from '../../../../config/types.js';
import { cliToolPolicySchema } from '../../../../config/schema.js';
import { compilePolicy, evaluatePolicy, PolicyCompileError } from '../../../../domain/policy/cli-policy.js';
import type { PolicyStore } from '../../../../application/policy/policy-store.js';

function findCliTool(config: SplicedockConfig, name: string): CliPassthroughToolConfig | null {
  for (const tool of config.tools) {
    if (tool.type === 'cli_passthrough' && tool.name === name) return tool;
  }
  return null;
}

export function registerPolicyRoutes(
  app: FastifyInstance,
  config: SplicedockConfig,
  policyStore: PolicyStore,
  // Known profile names; scoped overrides are only accepted for these.
  profileNames: () => string[] = () => [],
): void {
  /** Resolve ?profile=: undefined = all profiles; null = rejected (reply sent). */
  function scopeOf(req: { query: unknown }, reply: { code(n: number): { send(b: unknown): void } }): string | undefined | null {
    const raw = (req.query as Record<string, string | undefined> | undefined)?.profile;
    if (raw === undefined || raw === '') return undefined;
    if (!profileNames().includes(raw)) {
      reply.code(404).send({ error: { code: 'unknown_profile', message: `profile '${raw}' not found` } });
      return null;
    }
    return raw;
  }

  /** Per-tool effective policy summary (file + override + effective). */
  app.get('/api/v1/policies', async (_req, reply) => {
    const out = [];
    for (const tool of config.tools) {
      if (tool.type !== 'cli_passthrough') continue;
      out.push(await policyStore.view(tool));
    }
    reply.send({ data: out });
  });

  app.get<{ Params: { name: string } }>('/api/v1/policies/:name', async (req, reply) => {
    const tool = findCliTool(config, req.params.name);
    if (!tool) {
      reply.code(404).send({ error: { code: 'not_found', message: `cli_passthrough '${req.params.name}' not found` } });
      return;
    }
    reply.send({ data: await policyStore.view(tool) });
  });

  app.put<{
    Params: { name: string };
    Body: { policy: unknown; updated_by?: string };
  }>('/api/v1/policies/:name', async (req, reply) => {
    const tool = findCliTool(config, req.params.name);
    if (!tool) {
      reply.code(404).send({ error: { code: 'not_found', message: `cli_passthrough '${req.params.name}' not found` } });
      return;
    }
    const scope = scopeOf(req, reply);
    if (scope === null) return;
    const parsed = cliToolPolicySchema.safeParse(req.body?.policy);
    if (!parsed.success) {
      reply.code(400).send({ error: { code: 'invalid_policy', message: parsed.error.message } });
      return;
    }
    const opts = { command: tool.command, knownSubcommands: tool.known_subcommands };
    try {
      if (scope) {
        await policyStore.setProfileOverride(tool.name, scope, parsed.data as CliToolPolicy, req.body?.updated_by ?? null, opts);
      } else {
        await policyStore.setOverride(tool.name, parsed.data as CliToolPolicy, req.body?.updated_by ?? null, opts);
      }
    } catch (err) {
      if (err instanceof PolicyCompileError) {
        reply.code(400).send({ error: { code: 'invalid_policy', message: err.message } });
        return;
      }
      throw err;
    }
    reply.send({ data: await policyStore.view(tool) });
  });

  app.delete<{ Params: { name: string } }>('/api/v1/policies/:name', async (req, reply) => {
    const tool = findCliTool(config, req.params.name);
    if (!tool) {
      reply.code(404).send({ error: { code: 'not_found', message: `cli_passthrough '${req.params.name}' not found` } });
      return;
    }
    const scope = scopeOf(req, reply);
    if (scope === null) return;
    const existed = scope
      ? await policyStore.deleteProfileOverride(tool.name, scope)
      : await policyStore.deleteOverride(tool.name);
    reply.send({ data: { cleared: existed, ...await policyStore.view(tool) } });
  });

  /**
   * Dry-run: evaluate an argv against either the effective policy for this
   * tool, or a caller-supplied inline policy (useful for "preview before
   * save"). Returns the deny rule + message on hit; { ok: true } otherwise.
   */
  app.post<{
    Params: { name: string };
    Body: { argv: unknown; policy?: unknown };
  }>('/api/v1/policies/:name/dry-run', async (req, reply) => {
    const tool = findCliTool(config, req.params.name);
    if (!tool) {
      reply.code(404).send({ error: { code: 'not_found', message: `cli_passthrough '${req.params.name}' not found` } });
      return;
    }
    const scope = scopeOf(req, reply);
    if (scope === null) return;
    const argv = req.body?.argv;
    if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) {
      reply.code(400).send({ error: { code: 'invalid_argv', message: "'argv' must be string[]" } });
      return;
    }

    let policyForRun: CliToolPolicy | undefined;
    if (req.body?.policy !== undefined) {
      const parsed = cliToolPolicySchema.safeParse(req.body.policy);
      if (!parsed.success) {
        reply.code(400).send({ error: { code: 'invalid_policy', message: parsed.error.message } });
        return;
      }
      policyForRun = parsed.data as CliToolPolicy;
    } else {
      policyForRun = await policyStore.effective(tool, scope);
    }

    try {
      const compiled = compilePolicy(policyForRun, { command: tool.command, knownSubcommands: tool.known_subcommands });
      const decision = evaluatePolicy(argv as string[], compiled);
      reply.send({ data: decision });
    } catch (err) {
      if (err instanceof PolicyCompileError) {
        reply.code(400).send({ error: { code: 'invalid_policy', message: err.message } });
        return;
      }
      throw err;
    }
  });
}
