import { z } from 'zod';
import {breakerReadonly} from '../domain/policy/breaker-readonly.js';

const authFromSchema = z
  .string()
  .regex(/^(env:|vault:).+/, "Auth 'from' must start with 'env:' or 'vault:'");

const providerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'provider name must be 1-64 chars of [A-Za-z0-9_-]');

// Where one credential value comes from: a static reference (`from`, resolved
// per call) or a minted one (`mint`, a declared credential_providers instance
// asked for a fresh value for this profile/backend). Minting is generic — the
// provider decides how, and the broker owns caching, persistence and revocation.
const credentialSourceSchema = z.union([
  z.object({ from: authFromSchema }).strict(),
  z.object({ mint: providerNameSchema }).strict(),
]);

// Auth for HTTP-shaped upstreams (http tools AND mcp_proxy backends). Defined here,
// above mcpProxyToolSchema, so the proxy schema can attach it. `from` is an env:/vault:
// reference resolved at startup by the auth resolver.
const httpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('bearer'),
    token: credentialSourceSchema,
  }),
  z.object({
    type: z.literal('basic'),
    username: z.object({ from: authFromSchema }),
    password: z.object({ from: authFromSchema }),
  }),
  z.object({
    type: z.literal('header'),
    name: z.string().min(1),
    value: credentialSourceSchema,
  }),
]);

const paramSchema = z.object({
  name: z.string().min(1),
  in: z.enum(['path', 'query', 'body', 'header']).default('query'),
  required: z.boolean().default(false),
  default: z.string().optional(),
  // 'json' body params are parsed and sent as JSON values (objects/arrays), for
  // APIs that take structured bodies. Default is a plain string.
  format: z.enum(['string', 'json']).optional(),
});

const retrySchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
  backoff_ms: z.number().int().min(100).default(500),
});

const mcpProxyToolSchema = z.object({
  type: z.literal('mcp_proxy'),
  name: z.string().min(1),
  service_dns: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(8000),
  // 'streamable_http': POST /mcp via StreamableHTTPClientTransport (mcp-bridge pods).
  // 'sse': GET /sse via SSEClientTransport (supergateway-style pods).
  transport: z.enum(['streamable_http', 'sse']).default('streamable_http'),
  description: z.string().min(1).optional(),
  refresh_interval_ms: z.number().int().min(60_000).default(600_000),
  retry: retrySchema.optional(),
  // Auth to send to the upstream. Most backends are unauthenticated MCP proxies
  // (netpol-protected), but some require a credential the proxy must attach itself —
  // e.g. a service reached directly instead of via a Bearer-injecting sidecar.
  auth: httpAuthSchema.prefault({ type: 'none' }),
});

const httpToolSchema = z.object({
  type: z.literal('http'),
  name: z.string().min(1),
  namespace: z.string().min(1),
  description: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1),
  params: z.array(paramSchema).default([]),
  auth: httpAuthSchema.prefault({ type: 'none' }),
  retry: retrySchema.optional(),
  // Client-side request timeout. Omitted -> 30s (right for most HTTP tools);
  // some tools front a long-running backend — e.g. teammates__consult runs a
  // real LLM agent turn — so it is configurable. The ceiling sits above the
  // teammates consult server's own ~930s timeout so its structured error
  // arrives before the client aborts. Optional (not defaulted) so hand-built
  // configs and existing tools need not set it. Do NOT pair a long timeout with
  // `retry`: the backend starts real work on receipt, so a retry double-runs it.
  timeout_ms: z.number().int().min(1000).max(1_200_000).optional(),
});

const cliToolSchema = z.object({
  type: z.literal('cli'),
  name: z.string().min(1),
  namespace: z.string().min(1),
  description: z.string().min(1),
  command: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'command must be a bare executable name'),
  // args are passed directly to execFile (shell: false) — never interpolated into a shell string
  args: z.array(z.string()).default([]),
  params: z.array(paramSchema).default([]),
  timeout_ms: z.number().int().min(1000).max(300000).default(30000),
  env: z.array(z.string()).default([]),
  auth: z.literal('none').default('none'),
});

// Install instructions executed by splicedock itself at startup (before the MCP server binds).
// The script runs inside the splicedock container as the splicedock user, with:
//   - SPLICEDOCK_BIN on PATH (writable output dir for the binary)
//   - npm_config_prefix=$SPLICEDOCK_BIN (so `npm install -g` targets the writable dir)
//   - user-declared env vars merged in (for URL/version interpolation)
// The script should place an executable named after the tool's `command` field somewhere on PATH
// (typically `$SPLICEDOCK_BIN/<name>` for curl|tar, or `npm install -g <pkg>` for npm packages).
const cliPassthroughInstallSchema = z.object({
  script: z.string().min(1),
  // Extra env vars (for URLs, versions, etc.). Secrets should live in container env via values.yaml
  // extraEnv, not here — these values are visible in the rendered helm manifest.
  env: z.record(z.string(), z.string()).prefault({}),
  // If true, splicedock startup aborts on install failure. Default false: the tool is logged and
  // skipped so the rest of splicedock still serves.
  required: z.boolean().default(false),
  // Installer timeout.
  timeout_ms: z.number().int().min(1000).max(600000).default(120000),
});

// Env var reference — either a bare name (read from splicedock's process env) or an auth
// reference that splicedock resolves at startup from env:/vault: sources.
//
// Examples:
//   GH_TOKEN                                          # bare name, read from process.env
//   { name: GH_TOKEN, from: env:MY_OTHER_VAR }         # rename from another env var
//   { name: GH_TOKEN, from: vault:secret/data/example/github#runner_pat }
const envNameSchema = z.string().min(1).regex(/^[A-Z_][A-Z0-9_]*$/, 'bare env name must be SHOUTY_CASE');

const cliPassthroughEnvRefSchema = z.union([
  envNameSchema,
  z.object({ name: envNameSchema, from: authFromSchema }).strict(),
  z.object({ name: envNameSchema, mint: providerNameSchema }).strict(),
]);

// Fine-grained argv policy for cli_passthrough tools. Exported so admin
// routes can re-validate runtime override payloads. Every field is optional;
// when set, ALL constraints must pass (intersection). Evaluation order is
// deterministic and documented in src/domain/policy/cli-policy.ts.
//
// Backward compatibility: the top-level `deny_subcommands` on
// cli_passthrough is kept and folded into policy.deny_subcommands by the
// config loader. Setting both fields is rejected at validation time.
// `--long-name` or `-x` (single short char).
const flagNameSchema = z
  .string()
  .regex(/^(--[A-Za-z0-9][A-Za-z0-9_.-]*|-[A-Za-z0-9])$/, 'flag must be --long-name or -x');

export const cliToolPolicySchema = z.object({
  // Exact-match allow-list on argv[0]. Mutually exclusive with deny_subcommands.
  allow_subcommands: z.array(z.string().min(1)).max(200).optional(),
  // Exact-match deny on argv[0].
  deny_subcommands: z.array(z.string().min(1)).max(200).optional(),
  // Allowed multi-token paths matched as a prefix against argv. Each entry is
  // a list of consecutive non-flag argv tokens. Example: [["repo","view"]]
  // for `gh repo view ...`. Mutually exclusive with deny_subcommand_paths.
  //
  // Path extraction is tool-aware (src/domain/cli/flag-arity.ts): built-in
  // flag tables for gh and kubectl (by command basename), extended by
  // `value_flags` / `boolean_flags` below. `--flag=value` and `-xVALUE` never
  // consume the next token; a known value flag always does (even `--`); `--`
  // ends flags. A flag whose arity is unknown is read both ways, and the call
  // is denied with rule `ambiguous_argv` when the readings disagree on any
  // path-rule outcome (fail closed).
  allow_subcommand_paths: z.array(z.array(z.string().min(1)).min(1)).max(200).optional(),
  // Deny multi-token argv prefixes. Example: [["repo","delete"]].
  // Same path-extraction caveat as allow_subcommand_paths above.
  deny_subcommand_paths: z.array(z.array(z.string().min(1)).min(1)).max(200).optional(),
  // Substring deny on any single argv element. Cheap, regex-free.
  deny_args: z.array(z.string().min(1)).max(200).optional(),
  // Per-argv-element regex deny (anchored or not — operator's choice).
  // Regexes are compiled by `loader.ts::normalizeCliPassthroughPolicy` at
  // config-load time; invalid patterns fail startup. Avoid nested
  // quantifiers (`(a+)+`) — they invite catastrophic backtracking and run on
  // every hot-path call.
  deny_args_regex: z.array(z.string().min(1)).max(200).optional(),
  // Coarse regex against the whole space-joined argv. Same compile-time
  // validation and backtracking caveat as deny_args_regex.
  deny_argv_regex: z.array(z.string().min(1)).max(50).optional(),
  // Every entry must appear in argv, either as an exact token (`--foo`) or
  // as the prefix of a `flag=value` token (`--foo=bar`). Short flags must be
  // listed verbatim.
  require_args: z.array(z.string().min(1)).max(50).optional(),
  // Any-of group: at least ONE entry from each inner list must appear, using
  // the same exact-or-prefix match as require_args.
  // Useful for "must specify --namespace OR -n".
  require_any_of: z.array(z.array(z.string().min(1)).min(1)).max(20).optional(),
  // Defense against argv-explosion DoS.
  max_args: z.number().int().min(1).max(10000).default(256),
  // Action on rule match.
  //   `deny`     — return error to caller (default; previous behaviour).
  //   `approval` — block but record a pending_approvals row; caller must
  //                retry the same argv after a human approves via the admin
  //                WebUI/API. Approvals are one-shot (consumed on first hit).
  on_violation: z.enum(['deny', 'approval']).default('deny'),
  // Paths whose matches require operator approval instead of running. They
  // must not overlap deny_subcommand_paths (deny always wins, so compilePolicy
  // rejects the overlap). The path-extraction caveat from
  // deny_subcommand_paths applies.
  approval_subcommand_paths: z.array(z.array(z.string().min(1)).min(1)).max(200).optional(),
  // Subcommands whose matches require operator approval (not overlapping deny_subcommands).
  approval_subcommands: z.array(z.string().min(1)).max(200).optional(),
  // Emit a structured log entry on every accepted invocation in addition to
  // the always-on deny log.
  audit: z.boolean().default(false),
  // Flag arity declarations for subcommand-path extraction, merged over the
  // built-in table for the tool's command. Long flags as `--name`, short flags
  // as `-x`. Only list flags whose arity is the same in every subcommand.
  value_flags: z.array(flagNameSchema).max(500).optional(),
  boolean_flags: z.array(flagNameSchema).max(500).optional(),
});

// cli_passthrough exposes any CLI uniformly through two tools per entry:
//   <name>__help(subcommand?)  — runs `<command> [subcommand] --help`
//   <name>__run(args: string[], cwd?: string) — runs `<command> <args>` in cwd (execFile, shell:false)
// Claude discovers the tool's capabilities by reading --help output at session time,
// then invokes __run with a typed array (no shell parsing, no injection risk).
const cliPassthroughToolSchema = z.object({
  type: z.literal('cli_passthrough'),
  name: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/, 'name must be alphanumeric/underscore'),
  description: z.string().min(1),
  // Full path to the executable. Must match an entry in server.cli_whitelist.
  command: z.string().min(1),
  // Legacy top-level deny list — kept for backward compatibility. The loader
  // folds this into `policy.deny_subcommands`. Setting both forms is rejected.
  deny_subcommands: z.array(z.string()).default([]),
  // Fine-grained argv policy (allow/deny lists, regex, require). Optional;
  // when omitted the only constraint is the legacy `deny_subcommands` above.
  policy: cliToolPolicySchema.optional(),
  // Env vars forwarded to install scripts and runtime tool invocations. Bare strings are read
  // from process env; object form uses splicedock's auth resolver (env: / vault:) at startup.
  env: z.array(cliPassthroughEnvRefSchema).default([]),
  timeout_ms: z.number().int().min(1000).max(300000).default(60000),
  // Built-in known-command table (gh, kubectl). 'enforce' maps aliases to
  // canonical names before policy rules run and refuses an unknown first
  // subcommand (extensions, config aliases, kubectl plugins). 'off' restores
  // the pre-table behaviour; built-in hard denies (gh api) stay either way.
  // Tools without a built-in table are unaffected.
  known_subcommands: z.enum(['enforce', 'off']).default('enforce'),
  // Run every invocation with a fresh, private HOME and XDG_* dirs (plus
  // GH_CONFIG_DIR for gh), removed after the call, so tool config, aliases
  // and extensions cannot persist between calls. Overrides declared env vars
  // of the same names. false = inherit the server's HOME (legacy).
  isolate_config: z.boolean().default(true),
  // Declarative install hint (consumed by helm, not by splicedock runtime).
  install: cliPassthroughInstallSchema.optional(),
});

export const toolSchema = z.discriminatedUnion('type', [
  mcpProxyToolSchema,
  httpToolSchema,
  cliToolSchema,
  cliPassthroughToolSchema,
]);

// Per-profile credential binding, keyed by tool name. Without it every profile
// shares the tool-level credential (one upstream connection, one identity);
// with it a profile gets its own. Two shapes, one per upstream kind:
//   - `auth`: mcp_proxy backends — the same HTTP auth the tool-level `auth`
//     accepts. The proxy opens a per-profile upstream connection with it.
//   - `env`: cli_passthrough tools — env refs handed to the child process,
//     replacing same-named entries of the tool's own `env` list.
const profileCredentialSchema = z
  .object({
    auth: httpAuthSchema.optional(),
    env: z.array(cliPassthroughEnvRefSchema).min(1).optional(),
  })
  .strict()
  .refine(c => (c.auth === undefined) !== (c.env === undefined), {
    message: "profile credential must set exactly one of 'auth' or 'env'",
  });

export const profileSchema = z.object({
  tools: z.array(z.string()).min(1),
  // Built-in workflow executor. Unlike ordinary tools, this is a profile flag:
  // neither '*' nor naming code_mode__execute in tools enables it.
  enable_code_mode: z.boolean().default(false),
  // Tool name -> credential override. Tools not listed inherit the tool-level
  // credential, which every profile then shares.
  credentials: z.record(z.string(), profileCredentialSchema).default({}),
}).strict();

// A named admin token: the name becomes the approver identity. Exactly one
// token source (env var or file); the token value itself never lives in config.
export const adminTokenSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'name must be 1-64 chars of [A-Za-z0-9_.-]'),
    token_env: z.string().min(1).optional(),
    token_file: z.string().min(1).optional(),
  })
  .refine(t => (t.token_env === undefined) !== (t.token_file === undefined), {
    message: 'set exactly one of token_env or token_file',
  });

// A credential_providers instance is a named minter. `command` is the generic
// adapter: any CLI that prints a credential on stdout mints for any service,
// so adding a service needs no code. The broker caches each minted value and
// persists it through credential_storage.
const commandProviderSchema = z
  .object({
    type: z.literal('command'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeout_ms: z.number().int().min(100).max(120_000).default(10_000),
    // Used when the command reports no expiry of its own.
    ttl_seconds: z.number().int().positive().max(2_592_000).default(3600),
    output: z
      .object({
        format: z.enum(['text', 'json']).default('text'),
        // JSON only: field holding the secret, and the optional expiry fields.
        secret_field: z.string().min(1).default('token'),
        expires_in_field: z.string().min(1).optional(),
        expires_at_field: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

const credentialProviderSchema = z.discriminatedUnion('type', [commandProviderSchema]);

const credentialStorageSchema = z
  .object({
    type: z.enum(['vault', 'memory']).default('vault'),
    // Vault KV v2 *data* path prefix. One entry per (profile, backend, agent);
    // `data` is swapped for `metadata` for list/delete.
    prefix: z.string().min(1).default('secret/data/splicedock/minted'),
  })
  .strict()
  .prefault({});

export const splicedockConfigSchema = z.object({
  server: z
    .object({
      port: z.number().int().min(1).max(65535).default(8788),
      admin_port: z.number().int().min(1).max(65535).default(8789),
      admin_token_env: z.string().default('SPLICEDOCK_ADMIN_TOKEN'),
      // Env var holding the bearer token required to scrape /metrics. If that
      // env var is unset or empty, /metrics stays unauthenticated.
      metrics_token_env: z.string().default('SPLICEDOCK_METRICS_TOKEN'),
      // When true, POST /mcp requires a valid profile-token bearer; ?profile= is ignored.
      require_profile_token: z.boolean().default(false),
      // Optional named admin tokens. The legacy admin_token_env keeps working
      // and maps to the fixed identity "admin".
      admin_tokens: z
        .array(adminTokenSchema)
        .default([])
        .refine(a => new Set(a.map(t => t.name)).size === a.length, { message: 'admin_tokens names must be unique' }),
      shadow:z.object({enabled:z.boolean().default(false),queue_max:z.number().int().positive().max(10000).default(1000),timeout_ms:z.number().int().positive().max(5000).default(300),retention_days:z.number().int().positive().max(365).default(30),sample_rate:z.number().min(0).max(1).default(1)}).strict().prefault({}),
      breaker: z.object({
        enabled:z.boolean().default(true), mode:z.enum(['observe','enforce']).default('observe'),
        window_seconds:z.number().int().positive().max(3600).default(60),
        deny_threshold:z.number().int().positive().max(1000000).default(10),
        cooldown_seconds:z.number().int().positive().max(86400).default(1800),
        half_open_probes:z.number().int().positive().max(100).default(3),
        scopes:z.array(z.string().regex(/^(global|profile:[a-zA-Z0-9_-]+|token)$/)).max(100).default(['global']),
        read_allowlist:z.array(z.object({tool:z.string(),argv:z.array(z.string())}).strict().refine(a=>breakerReadonly(a.tool,a.argv),'unsupported breaker read exemption')).max(100).default([]),
      }).strict().prefault({}),
      consent: z.object({
        enabled:z.boolean().default(true),
        hardware_roots:z.array(z.string().min(1)).default([]),
        // YAML tools whose every approval needs strong (WebAuthn) consent, e.g.
        // a repository-deletion CLI tool. See docs/architecture.md.
        strong_default_tools:z.array(z.string()).default([]),
        rp_id:z.string().min(1).optional(), origin:z.string().url().optional(),
        approval_ttl_seconds:z.number().int().positive().max(600).default(600),
        link_ttl_seconds:z.number().int().positive().max(600).default(600),
        max_attempts:z.number().int().positive().max(3).default(3),
        rate_limit_per_minute:z.number().int().positive().default(10),
        min_human_latency_ms:z.number().int().nonnegative().default(2000),
        weak:z.object({enabled:z.boolean().default(false),ttl_seconds:z.number().int().positive().default(120),max_attempts:z.number().int().positive().default(3)}).strict().prefault({}),
      }).strict().refine(c=>!c.origin || (new URL(c.origin).origin===c.origin && new URL(c.origin).protocol==='https:' && !!c.rp_id && (new URL(c.origin).hostname===c.rp_id || new URL(c.origin).hostname.endsWith('.'+c.rp_id))),{message:'consent origin must be HTTPS and bound to rp_id'}).refine(c=>!c.rp_id || !!c.origin,{message:'consent rp_id requires origin'}).prefault({}),
      token_policy: z.object({
        max_ttl_seconds: z.number().int().positive().max(2592000).default(2592000),
        default_ttl_seconds: z.number().int().positive().max(2592000).default(2592000),
        touch_interval_seconds: z.number().int().positive().default(60),
        inactivity_days: z.number().int().positive().default(30),
        inactivity_mode: z.enum(['observe', 'enforce']).default('observe'),
        sweep_interval_seconds: z.number().int().positive().max(86400).default(3600),
      }).strict().refine(p => p.default_ttl_seconds <= p.max_ttl_seconds).prefault({}),
      vault: z.object({
        timeout_ms: z.number().int().positive().max(60000).default(3000),
        fail_closed_auth: z.literal(true).default(true),
        fail_closed_destructive: z.literal(true).default(true),
        read_cache_seconds: z.literal(0).default(0),
      }).strict().prefault({}),
      cli_whitelist: z.array(z.string()).default([]),
      // Hostnames (exact, or `*.suffix`) that admin-API/wizard-created mcp_proxy
      // upstreams may point at. Deny-by-default: an operator-entered service_dns
      // makes the gateway connect to that host (SSRF). YAML upstreams are exempt.
      mcp_upstream_allowlist: z.array(z.string().min(1)).default([]),
    }).strict()
    .prefault({}),
  // Deprecated and ignored: the built-in repo_delete broker was removed (#29);
  // repository deletion is a YAML tool now. Still accepted so configs that set
  // it keep loading; drop it from deployed values, then from here.
  broker:z.unknown().optional(),
  profiles: z.record(z.string(), profileSchema).prefault({}),
  credential_providers: z.record(providerNameSchema, credentialProviderSchema).prefault({}),
  credential_storage: credentialStorageSchema,
  // Binding that applies to ANY profile without its own entry for that tool,
  // including profiles created at runtime through the admin API. This is what
  // makes a new profile credentialed without touching config.
  credential_defaults: z.record(z.string(), profileCredentialSchema).prefault({}),
  tools: z.array(toolSchema).default([]),
});

export type SplicedockConfig = z.infer<typeof splicedockConfigSchema>;
export type ToolConfig = z.infer<typeof toolSchema>;
export type McpProxyToolConfig = z.infer<typeof mcpProxyToolSchema>;
export type HttpToolConfig = z.infer<typeof httpToolSchema>;
export type CliToolConfig = z.infer<typeof cliToolSchema>;
export type CliPassthroughToolConfig = z.infer<typeof cliPassthroughToolSchema>;
export type CliToolPolicy = z.infer<typeof cliToolPolicySchema>;
export type ProfileConfig = z.infer<typeof profileSchema>;
export type ProfileCredential = z.infer<typeof profileCredentialSchema>;
export type CredentialSource = z.infer<typeof credentialSourceSchema>;
export type CredentialProviderConfig = z.infer<typeof credentialProviderSchema>;
export type CredentialStorageConfig = z.infer<typeof credentialStorageSchema>;
export type CommandProviderConfig = z.infer<typeof commandProviderSchema>;
