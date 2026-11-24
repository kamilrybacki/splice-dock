export interface ApprovalPayload { approval_id:string; op_hash:string; canonical_argv:readonly string[]; cwd:string|null; level:'weak'|'strong'; expires_at:number; retry_hint:string; }
// CLI-passthrough argv policy engine.
//
// Evaluates a configured policy against the argv a caller wants to run, in a
// deterministic order. The first matching deny rule short-circuits with a
// structured violation; if no deny rule matches, allow rules are checked. An
// empty policy is permissive (accepts everything except what the host-level
// whitelist already rejects).
//
// Rule order is fixed so behaviour stays predictable when configs grow:
//   1. max_args                 — defends against argv-explosion DoS
//   2. deny_args                — substring match per argv element
//   3. deny_args_regex          — regex match per argv element
//   4. deny_argv_regex          — regex on the joined argv
//   5. deny_subcommands         — exact match on the first subcommand
//   6. deny_subcommand_paths    — multi-token argv prefix match
//   7. allow_subcommands        — first subcommand must be in this set (if set)
//   8. allow_subcommand_paths   — argv must prefix-match an entry (if set)
//   9. require_args             — every entry must appear in argv
//  10. require_any_of           — for each inner list, at least one entry must appear
//  11. approval_subcommands / approval_subcommand_paths — LAST
//
// Steps 5-8 and the approval match read the subcommand path, which depends on
// flag arity (cli-flag-arity.ts). They run once per plausible reading; when
// readings disagree the call is denied with rule `ambiguous_argv`.
//
// Invariant: deny always wins, approval is last. The approval hook reserves
// an approved row as a side effect, so it may only run once every other
// check has passed; any earlier denial means the hook is never called and
// nothing is reserved. compilePolicy rejects configs where an approval entry
// could never be reached because a deny entry covers it.

import type { CliToolPolicy } from '../../config/types.js';
import { extractSubcommandPaths, flagTableFor, invocationFlagTable, type FlagTable } from './cli/flag-arity.js';
import { cliProfileFor } from './cli/profiles/index.js';
import { kubectlConfinementBreach, kubectlNamespaceValues, type ConfinementReason } from './cli/kubectl-confinement.js';
import { ArgvCanonicalizationError, canonicalizeArgv } from './operation.js';
import {
  canonicalizeCommandPath,
  canonicalizeRulePath,
  knownCommandsFor,
  type KnownCommandTable,
} from './cli/known-commands.js';

export type PolicyDecision =
  | { ok: true }
  | { ok: true; approval: { reserved_id: string } }
  | {
      ok: false;
      rule:
        | 'max_args'
        | 'deny_subcommands'
        | 'deny_subcommand_paths'
        | 'deny_args'
        | 'deny_args_regex'
        | 'deny_argv_regex'
        | 'allow_subcommands'
        | 'allow_subcommand_paths'
        | 'require_args'
        | 'require_any_of'
        | 'approval_subcommands'
        | 'approval_subcommand_paths'
        | 'approval_requires_profile_token'
        | 'ambiguous_argv'
        | 'invalid_argv'
        | 'hard_deny'
        | 'unknown_subcommand';
      message: string;
      matched?: string;
      /** Set when rule is approval_*; the caller can retry after this id is approved. */
      pending_approval?: { id: string; expires_at: number; payload?:ApprovalPayload };
    };

/** Approval check hook injected by the host. Called when a policy
 *  rule with `on_violation: "approval"` matches. Must return either:
 *    - `{ approved: true, id }`  — an approved+unconsumed request matches; it is reserved + bypass
 *      (the wrapper finalizes it after spawn).
 *    - `{ approved: false, pending }` — record a new pending request (or return existing one).
 *    - `{ approved: false, refused }` — the caller may not use approvals at all
 *      (no authenticated profile token); nothing was created or reserved.
 *  The hook is responsible for argv_hash + pending-row bookkeeping. */
export type ApprovalVerdict =
  | { approved: true; id: string }
  | { approved: false; id: string; expires_at: number; payload?:ApprovalPayload }
  | { approved: false; refused: 'approval_requires_profile_token' };

export type ApprovalHook = (input: {
  tool: string;
  argv: readonly string[];
  rule: 'approval_subcommands' | 'approval_subcommand_paths';
  matched: string;
}) => ApprovalVerdict | Promise<ApprovalVerdict>;

/** The hook ApprovalService builds: always asynchronous (it hits the store). */
export type AsyncApprovalHook = (input: Parameters<ApprovalHook>[0]) => Promise<ApprovalVerdict>;

/** Compiled form — regex strings are pre-parsed so a malformed config fails
 *  at load time, not on the hot path. */
export interface CompiledCliPolicy {
  allowSubcommands?: Set<string>;
  denySubcommands?: Set<string>;
  allowSubcommandPaths?: string[][];
  denySubcommandPaths?: string[][];
  denyArgs?: string[];
  denyArgsRegex?: RegExp[];
  denyArgvRegex?: RegExp[];
  requireArgs?: string[];
  requireAnyOf?: string[][];
  approvalSubcommands?: Set<string>;
  approvalSubcommandPaths?: string[][];
  maxArgs: number;
  audit: boolean;
  /** Flag arity table used to extract the subcommand path from argv. */
  flagTable: FlagTable;
  command?:string;
  optionAliases?: Readonly<Record<string, string>>;
  /** Built-in, non-configurable deny paths for the tool (D14a). Checked
   *  before every configured rule; approval can never override them. */
  hardDenyPaths?: readonly (readonly string[])[];
  /** Built-in known-command table (1c fix B). When set, aliases are mapped
   *  to canonical names before path rules run and an unknown first
   *  subcommand is refused. Configured rules are already canonical. */
  knownCommands?: KnownCommandTable;
}

export interface CompileOptions {
  /** The tool's executable (path or name); selects the built-in flag table. */
  command?: string;
  /** Tool-level `known_subcommands` (default 'enforce'). 'off' drops the
   *  known-command table; the hard denies stay. */
  knownSubcommands?: 'enforce' | 'off';
}

export class PolicyCompileError extends Error {}

/** Short → long option spellings from the CLI's profile (none for unknown CLIs). */
function optionAliasesFor(command: string | undefined): Readonly<Record<string, string>> {
  return cliProfileFor(command)?.optionAliases ?? {};
}

/** Built-in hard denies from the CLI's profile (e.g. `gh api`, D14a). No kill switch. */
function hardDenyPathsFor(command: string | undefined): readonly (readonly string[])[] | undefined {
  return cliProfileFor(command)?.hardDenyPaths;
}

/** Whole-token prefix test: is `prefix` a (non-strict) token prefix of `full`? */
function isTokenPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false;
  return prefix.every((tok, i) => tok === full[i]);
}

/** An approval entry that is equal to or more specific than a deny entry can
 *  never fire (deny always wins), so the config is contradictory. An approval
 *  entry BROADER than a deny entry is legitimate: the deny carves out an
 *  exception. Comparison is by whole tokens and spans both rule categories. */
function assertNoUnreachableApprovals(p: CliToolPolicy): void {
  const approvals: Array<{ label: string; tokens: string[] }> = [
    ...(p.approval_subcommands ?? []).map(s => ({
      label: `approval_subcommands: ${JSON.stringify(s)}`,
      tokens: [s],
    })),
    ...(p.approval_subcommand_paths ?? []).map(path => ({
      label: `approval_subcommand_paths: ${JSON.stringify(path.join(' '))}`,
      tokens: [...path],
    })),
  ];
  if (approvals.length === 0) return;
  const denies: Array<{ label: string; tokens: string[] }> = [
    ...(p.deny_subcommands ?? []).map(s => ({
      label: `deny_subcommands: ${JSON.stringify(s)}`,
      tokens: [s],
    })),
    ...(p.deny_subcommand_paths ?? []).map(path => ({
      label: `deny_subcommand_paths: ${JSON.stringify(path.join(' '))}`,
      tokens: [...path],
    })),
  ];
  for (const a of approvals) {
    for (const d of denies) {
      if (isTokenPrefix(d.tokens, a.tokens)) {
        throw new PolicyCompileError(
          `policy: ${a.label} is unreachable, it is equal to or more specific than ${d.label} (deny always wins)`,
        );
      }
    }
  }
}

/** A bare requirement (`--namespace`, no `=value`) is satisfied only by a
 *  boolean flag, so naming a flag known to take a value can never pass and
 *  would silently deny every call. Reject it at compile time. Flags of unknown
 *  or command-dependent arity are left to evaluation, which fails closed. */
function assertSatisfiableRequirements(
  p: CliToolPolicy,
  table: FlagTable,
  aliases: Readonly<Record<string, string>>,
): void {
  const arityOf = (name: string) => {
    const direct = name.startsWith('--') ? table.long.get(name.slice(2)) : table.short.get(name.slice(1));
    const alias = aliases[name];
    return direct ?? (alias ? table.long.get(alias.slice(2)) : undefined);
  };
  const check = (field: string, requirement: string): void => {
    if (!requirement.startsWith('-') || requirement === '-' || requirement.includes('=')) return;
    if (arityOf(requirement) !== 'value') return;
    throw new PolicyCompileError(
      `policy.${field}: bare requirement ${JSON.stringify(requirement)} names a value-taking flag and can never be satisfied; use "${requirement}=<value>"`,
    );
  };
  for (const r of p.require_args ?? []) check('require_args', r);
  for (const group of p.require_any_of ?? []) for (const r of group) check('require_any_of', r);
}

/** A Kubernetes namespace name (RFC 1123 label). */
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** Compile-time checks for a confined kubectl policy (one that requires a
 *  namespace). The namespace gate scans argv with kubectl's own arity table,
 *  so an operator arity override for the namespace flag could only make the
 *  two readings disagree; reject it. A required namespace must be a real
 *  namespace name, and a requirement that kubectl would read as a namespace
 *  must be spelled so the gate recognises it (`--namespace=x` or `-n=x`). */
function assertKubectlConfinement(
  p: CliToolPolicy,
  command: string | undefined,
  aliases: Readonly<Record<string, string>>,
): void {
  if (!hasNamespaceConfinement(command)) return;
  const fields = [['require_args', p.require_args ?? []], ['require_any_of', (p.require_any_of ?? []).flat()]] as const;
  let confined = false;
  for (const [field, list] of fields) {
    for (const r of list) {
      if (isNamespaceRequirement(r, aliases)) {
        confined = true;
        if (!NAMESPACE_NAME.test(requiredValue(r))) {
          throw new PolicyCompileError(
            `policy.${field}: ${JSON.stringify(r)} does not name a valid namespace (lowercase RFC 1123 label)`,
          );
        }
        continue;
      }
      if (r.startsWith('-') && (kubectlNamespaceValues([r])?.length ?? 0) > 0) {
        throw new PolicyCompileError(
          `policy.${field}: ${JSON.stringify(r)} sets the namespace; spell it "--namespace=<name>"`,
        );
      }
    }
  }
  if (!confined) return;
  for (const [field, list] of [['value_flags', p.value_flags ?? []], ['boolean_flags', p.boolean_flags ?? []]] as const) {
    for (const f of list) {
      const name = f.startsWith('--') ? `--${f.slice(2).replaceAll('_', '-')}` : f;
      if ((aliases[name] ?? name) === '--namespace') {
        throw new PolicyCompileError(
          `policy.${field}: ${JSON.stringify(f)} overrides the arity of the namespace flag, which a namespace-confined kubectl policy reads with kubectl's own table`,
        );
      }
    }
  }
}

/** Pre-compile a CliToolPolicy. Throws PolicyCompileError on bad regex or
 *  contradictory rules (e.g. both allow+deny subcommands). */
/** Return a copy of the policy with every subcommand rule spelled with
 *  canonical command names, so `ext` in a rule matches `extension` in argv
 *  and vice versa. The input is not modified. */
function canonicalizeRules(p: CliToolPolicy, table: KnownCommandTable): CliToolPolicy {
  const top = (list: string[] | undefined): string[] | undefined =>
    list?.map(s => canonicalizeRulePath([s], table)[0]!);
  const paths = (list: string[][] | undefined): string[][] | undefined =>
    list?.map(path => canonicalizeRulePath(path, table));
  return {
    ...p,
    allow_subcommands: top(p.allow_subcommands),
    deny_subcommands: top(p.deny_subcommands),
    approval_subcommands: top(p.approval_subcommands),
    allow_subcommand_paths: paths(p.allow_subcommand_paths),
    deny_subcommand_paths: paths(p.deny_subcommand_paths),
    approval_subcommand_paths: paths(p.approval_subcommand_paths),
  };
}

export function compilePolicy(raw: CliToolPolicy | undefined, opts: CompileOptions = {}): CompiledCliPolicy {
  const knownCommands = opts.knownSubcommands === 'off' ? undefined : knownCommandsFor(opts.command);
  if (!raw) {
    // Permissive default. max_args still applies as DoS guard.
    return {
      maxArgs: 256,
      audit: false,
      command:opts.command,
      flagTable: flagTableFor(opts.command),
      optionAliases: optionAliasesFor(opts.command),
      hardDenyPaths: hardDenyPathsFor(opts.command),
      knownCommands,
    };
  }
  const p = knownCommands ? canonicalizeRules(raw, knownCommands) : raw;

  if (p.allow_subcommands && p.deny_subcommands && p.allow_subcommands.length > 0 && p.deny_subcommands.length > 0) {
    throw new PolicyCompileError(
      'policy: cannot set both allow_subcommands and deny_subcommands',
    );
  }
  if (
    p.allow_subcommand_paths &&
    p.deny_subcommand_paths &&
    p.allow_subcommand_paths.length > 0 &&
    p.deny_subcommand_paths.length > 0
  ) {
    throw new PolicyCompileError(
      'policy: cannot set both allow_subcommand_paths and deny_subcommand_paths',
    );
  }

  const compileRegexList = (arr: string[] | undefined, field: string): RegExp[] | undefined => {
    if (!arr || arr.length === 0) return undefined;
    return arr.map(src => {
      try {
        return new RegExp(src);
      } catch (err) {
        throw new PolicyCompileError(
          `policy.${field}: invalid regex ${JSON.stringify(src)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  };

  assertNoUnreachableApprovals(p);
  const flagTable = flagTableFor(opts.command, {
    value_flags: p.value_flags,
    boolean_flags: p.boolean_flags,
  });
  const optionAliases = optionAliasesFor(opts.command);
  assertSatisfiableRequirements(p, flagTable, optionAliases);
  assertKubectlConfinement(p, opts.command, optionAliases);

  return {
    allowSubcommands:
      p.allow_subcommands && p.allow_subcommands.length > 0 ? new Set(p.allow_subcommands) : undefined,
    denySubcommands:
      p.deny_subcommands && p.deny_subcommands.length > 0 ? new Set(p.deny_subcommands) : undefined,
    allowSubcommandPaths:
      p.allow_subcommand_paths && p.allow_subcommand_paths.length > 0 ? p.allow_subcommand_paths : undefined,
    denySubcommandPaths:
      p.deny_subcommand_paths && p.deny_subcommand_paths.length > 0 ? p.deny_subcommand_paths : undefined,
    denyArgs: p.deny_args && p.deny_args.length > 0 ? p.deny_args : undefined,
    denyArgsRegex: compileRegexList(p.deny_args_regex, 'deny_args_regex'),
    denyArgvRegex: compileRegexList(p.deny_argv_regex, 'deny_argv_regex'),
    requireArgs: p.require_args && p.require_args.length > 0 ? p.require_args : undefined,
    requireAnyOf: p.require_any_of && p.require_any_of.length > 0 ? p.require_any_of : undefined,
    approvalSubcommands:
      p.approval_subcommands && p.approval_subcommands.length > 0
        ? new Set(p.approval_subcommands)
        : undefined,
    approvalSubcommandPaths:
      p.approval_subcommand_paths && p.approval_subcommand_paths.length > 0
        ? p.approval_subcommand_paths
        : undefined,
    maxArgs: p.max_args,
    audit: p.audit,
    optionAliases,
    command:opts.command,
    flagTable,
    hardDenyPaths: hardDenyPathsFor(opts.command),
    knownCommands,
  };
}

/** Redact the value-half of a `flag=value` token before echoing in errors.
 *  Caller-visible policy errors otherwise reflect the full matched token back
 *  to the MCP client, which can leak secrets in e.g. `--token=hunter2`. */
function redactPreview(tok: string): string {
  if (tok.length <= 16) return JSON.stringify(tok);
  const eq = tok.indexOf('=');
  if (eq > 0 && eq < tok.length - 1) {
    return JSON.stringify(tok.slice(0, eq + 1) + '***');
  }
  return JSON.stringify(tok.slice(0, 12) + '…');
}

function pathMatchesPrefix(path: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0) return false;
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

type DenyDecision = Extract<PolicyDecision, { ok: false }>;
type ApprovalRule = 'approval_subcommands' | 'approval_subcommand_paths';

type PathVerdict =
  | { kind: 'ok' }
  | { kind: 'deny'; decision: DenyDecision }
  | { kind: 'approval'; rule: ApprovalRule; matched: string };

function hasPathRules(policy: CompiledCliPolicy): boolean {
  return Boolean(
    policy.denySubcommands ||
      policy.denySubcommandPaths ||
      policy.allowSubcommands ||
      policy.allowSubcommandPaths ||
      policy.approvalSubcommands ||
      policy.approvalSubcommandPaths,
  );
}

function ambiguous(message: string): PathVerdict {
  return { kind: 'deny', decision: { ok: false, rule: 'ambiguous_argv', message } };
}

/** Two readings agree when both deny (any rule: the call is refused either
 *  way), both pass, or both need the same approval. */
function sameOutcome(a: PathVerdict, b: PathVerdict): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'approval' && b.kind === 'approval') {
    return a.rule === b.rule && a.matched === b.matched;
  }
  return true;
}

/** A hard-deny path can only match a reading whose positionals include its
 *  first token, so when argv lacks every such token it cannot fire. Skipping
 *  it then keeps permissive policies free of the path-overflow refusal. */
function hardDenyRelevant(argv: readonly string[], policy: CompiledCliPolicy): boolean {
  return Boolean(policy.hardDenyPaths?.some(p => p.length > 0 && argv.includes(p[0]!)));
}

function resolvePathVerdict(argv: readonly string[], policy: CompiledCliPolicy): PathVerdict {
  if (!hasPathRules(policy) && !policy.knownCommands && !hardDenyRelevant(argv, policy)) {
    return { kind: 'ok' };
  }
  const candidates = extractSubcommandPaths(argv, policy.flagTable);
  if (candidates === null) {
    return ambiguous(
      'subcommand path is ambiguous: too many flags of unknown arity; use --flag=value or declare value_flags/boolean_flags',
    );
  }
  const verdicts = candidates.map(c => evaluateReading(c, policy));
  const first = verdicts[0]!;
  if (!verdicts.every(v => sameOutcome(v, first))) {
    return ambiguous(
      'subcommand path is ambiguous: a flag of unknown arity changes which rule applies; use --flag=value or declare value_flags/boolean_flags',
    );
  }
  return first;
}

/** Map aliases to canonical names (when the tool has a table) and refuse an
 *  unknown first subcommand, which the binary would dispatch to an extension,
 *  a config alias or a plugin. The message never echoes the token. */
function evaluateReading(subPath: readonly string[], policy: CompiledCliPolicy): PathVerdict {
  if (!policy.knownCommands) return evaluatePath(subPath, policy);
  const canonical = canonicalizeCommandPath(subPath, policy.knownCommands);
  if (canonical === null) {
    return {
      kind: 'deny',
      decision: {
        ok: false,
        rule: 'unknown_subcommand',
        message: 'first subcommand is not a known command for this tool',
      },
    };
  }
  return evaluatePath(canonical, policy);
}

/** Steps 5-8 and the approval match for one reading of the subcommand path. */
function evaluatePath(subPath: readonly string[], policy: CompiledCliPolicy): PathVerdict {
  const firstSub = subPath[0] ?? '';
  const deny = (decision: DenyDecision): PathVerdict => ({ kind: 'deny', decision });

  // 4b. Built-in hard denies (D14a): before every configured rule.
  if (policy.hardDenyPaths) {
    for (const path of policy.hardDenyPaths) {
      if (pathMatchesPrefix(subPath, path)) {
        return deny({
          ok: false,
          rule: 'hard_deny',
          message: `subcommand path '${path.join(' ')}' is never allowed for this tool`,
          matched: path.join(' '),
        });
      }
    }
  }

  // 5. deny_subcommands
  if (policy.denySubcommands && firstSub.length > 0 && policy.denySubcommands.has(firstSub)) {
    return deny({
      ok: false,
      rule: 'deny_subcommands',
      message: `subcommand '${firstSub}' is denied`,
      matched: firstSub,
    });
  }

  // 6. deny_subcommand_paths
  if (policy.denySubcommandPaths) {
    for (const path of policy.denySubcommandPaths) {
      if (pathMatchesPrefix(subPath, path)) {
        return deny({
          ok: false,
          rule: 'deny_subcommand_paths',
          message: `subcommand path '${path.join(' ')}' is denied`,
          matched: path.join(' '),
        });
      }
    }
  }

  // 7. allow_subcommands (must be in set if set)
  if (policy.allowSubcommands) {
    if (firstSub.length === 0) {
      return deny({
        ok: false,
        rule: 'allow_subcommands',
        message: 'no subcommand provided; allow_subcommands requires one',
      });
    }
    if (!policy.allowSubcommands.has(firstSub)) {
      return deny({
        ok: false,
        rule: 'allow_subcommands',
        message: `subcommand '${firstSub}' is not in the allow-list`,
        matched: firstSub,
      });
    }
  }

  // 8. allow_subcommand_paths (must prefix-match one)
  if (policy.allowSubcommandPaths) {
    const hit = policy.allowSubcommandPaths.some(p => pathMatchesPrefix(subPath, p));
    if (!hit) {
      return deny({
        ok: false,
        rule: 'allow_subcommand_paths',
        message: `subcommand path '${subPath.join(' ')}' is not in the allow-list`,
        matched: subPath.join(' '),
      });
    }
  }

  // Approval match (consulted in step 11, after the require checks).
  if (policy.approvalSubcommands && firstSub.length > 0 && policy.approvalSubcommands.has(firstSub)) {
    return { kind: 'approval', rule: 'approval_subcommands', matched: firstSub };
  }
  if (policy.approvalSubcommandPaths) {
    const path = policy.approvalSubcommandPaths.find(pp => pathMatchesPrefix(subPath, pp));
    if (path) return { kind: 'approval', rule: 'approval_subcommand_paths', matched: path.join(' ') };
  }
  return { kind: 'ok' };
}

const CONFINEMENT_REASON_TEXT: Readonly<Record<ConfinementReason, string>> = {
  target: 're-addresses the request (another URI, server, cluster or context)',
  scope: 'widens the request past the namespace',
  identity: 'changes the identity the request is made as',
  'client-config': 'replaces the client config, its trust roots or caches',
  'local-file': 'writes caller-chosen local files',
  'manifest-source': 'reads manifests that carry their own namespace (files, URLs, kustomizations)',
};

/** Why argv escapes a required kubectl namespace, or undefined. Never echoes values. */
function confinementEscape(argv: readonly string[], policy: CompiledCliPolicy): string | undefined {
  const breach = kubectlConfinementBreach(argv);
  if (breach?.flag === '--all-namespaces') return 'conflicts with --all-namespaces, which ignores the namespace';
  if (breach) return `confines kubectl to a namespace; ${breach.flag} ${CONFINEMENT_REASON_TEXT[breach.reason]}`;
  const paths = extractSubcommandPaths(argv, policy.flagTable);
  if (paths === null) return 'confines kubectl to a namespace; argv is too ambiguous to check';
  if (paths.some(p => p[0] === 'config')) {
    return 'confines kubectl to a namespace; the config subcommand reads and rewrites the kubeconfig';
  }
  return undefined;
}

/** Does the CLI's profile confine namespaced policies to their namespace? */
const hasNamespaceConfinement = (command: string | undefined): boolean =>
  cliProfileFor(command)?.namespaceConfinement === true;

/** Whether a requirement names the kubectl namespace (`--namespace=x`, `-n=x`). */
function isNamespaceRequirement(needed: string, aliases: Readonly<Record<string, string>> | undefined): boolean {
  if (!needed.startsWith('-')) return false;
  const name = needed.split('=')[0]!;
  return (aliases?.[name] ?? name) === '--namespace';
}

const requiredValue = (needed: string): string => needed.slice(needed.indexOf('=') + 1);

/** The effective-namespace gate of a confined kubectl policy.
 *
 *  A kubectl policy that requires a namespace anywhere (require_args, or any
 *  alternative of a require_any_of group) is a confinement boundary:
 *  - the allowed namespaces are every namespace value named in those
 *    requirements;
 *  - argv is scanned with kubectl's built-in arity table only, so operator
 *    value_flags / boolean_flags can never hide a namespace. If the operator's
 *    table reads the namespace differently, the call is refused;
 *  - at least one namespace must be given (the kubeconfig default is not a
 *    confinement), and every occurrence must be allowed;
 *  - flags that re-target the request, swap the identity or client config, or
 *    read their own manifests are refused even next to an allowed namespace.
 *  A satisfied non-namespace alternative of a mixed group does not lift any of
 *  this. Denials never echo the namespace given. */
interface NamespaceGate {
  readonly denial?: PolicyDecision;
  /** Namespaces kubectl will read, in order (set when there is no denial). */
  readonly namespaces?: readonly string[];
}

function kubectlNamespaceGate(argv: readonly string[], policy: CompiledCliPolicy): NamespaceGate | undefined {
  if (!hasNamespaceConfinement(policy.command)) return undefined;
  const isNamespace = (needed: string): boolean => isNamespaceRequirement(needed, policy.optionAliases);
  const required = policy.requireArgs?.find(isNamespace);
  const group = required === undefined ? policy.requireAnyOf?.find(g => g.some(isNamespace)) : undefined;
  const needed = required ?? group?.find(isNamespace);
  if (needed === undefined) return undefined;
  const deny = (why: string): NamespaceGate => {
    const message = `required ${JSON.stringify(needed)} ${why}`;
    return {
      denial: group === undefined
        ? { ok: false, rule: 'require_args', message, matched: needed }
        : { ok: false, rule: 'require_any_of', message, matched: group.join('|') },
    };
  };
  const escape = confinementEscape(argv, policy);
  if (escape !== undefined) return deny(escape);
  const allowed = new Set(
    [...(policy.requireArgs ?? []), ...(policy.requireAnyOf ?? []).flat()].filter(isNamespace).map(requiredValue),
  );
  const namespaces = kubectlNamespaceValues(argv);
  if (namespaces === null) return deny('confines kubectl to a namespace; argv is too ambiguous to find the namespace');
  const operatorReading = kubectlNamespaceValues(argv, policy.flagTable);
  if (operatorReading === null || operatorReading.length !== namespaces.length
    || operatorReading.some((v, k) => v !== namespaces[k])) {
    return deny('confines kubectl to a namespace; value_flags / boolean_flags read the namespace differently from kubectl');
  }
  if (namespaces.length === 0) {
    return deny('confines kubectl to a namespace; no namespace was given (the kubeconfig default is not allowed)');
  }
  if (namespaces.some(v => !allowed.has(v))) {
    return deny('confines kubectl to a namespace; a namespace outside the allowed set was given');
  }
  return { namespaces };
}

/** Apply the compiled policy to a concrete argv. Returns {ok:true} on accept,
 *  or {ok:false, rule, message, matched?} on first deny.
 *
 *  When `approvalHook` is provided AND a rule with on_violation=approval
 *  matches, the hook is consulted. If it returns approved, the call is
 *  allowed (and the hook is responsible for consuming the approval row);
 *  otherwise a structured pending-approval decision is returned and the
 *  caller is expected to retry once approved.
 *
 *  Rule ordering: see the header. Approval is evaluated LAST, so any deny or
 *  allow/require failure returns before the hook runs and nothing is reserved. */
interface ApprovalNeeded {
  readonly needsApproval: true;
  readonly argv: readonly string[];
  readonly rule: 'approval_subcommands' | 'approval_subcommand_paths';
  readonly matched: string;
}

/** Synchronous without a hook; with a hook the approval step consults the
 *  (database-backed, async) hook, so the result is a Promise. */
export function evaluatePolicy(rawArgv: readonly string[], policy: CompiledCliPolicy): PolicyDecision;
export function evaluatePolicy(
  rawArgv: readonly string[],
  policy: CompiledCliPolicy,
  approvalHook: { tool: string; fn: ApprovalHook },
): Promise<PolicyDecision>;
export function evaluatePolicy(
  rawArgv: readonly string[],
  policy: CompiledCliPolicy,
  approvalHook?: { tool: string; fn: ApprovalHook },
): PolicyDecision | Promise<PolicyDecision>;
export function evaluatePolicy(
  rawArgv: readonly string[],
  policy: CompiledCliPolicy,
  approvalHook?: { tool: string; fn: ApprovalHook },
): PolicyDecision | Promise<PolicyDecision> {
  const core = evaluateCore(rawArgv, policy);
  if (!('needsApproval' in core)) return core;
  const what = core.rule === 'approval_subcommands' ? 'subcommand' : 'subcommand path';
  if (!approvalHook) {
    return {
      ok: false,
      rule: core.rule,
      message: `${what} '${core.matched}' requires operator approval (no approval hook configured)`,
      matched: core.matched,
    };
  }
  return consultApproval(core, what, approvalHook);
}

async function consultApproval(
  core: ApprovalNeeded,
  what: string,
  approvalHook: { tool: string; fn: ApprovalHook },
): Promise<PolicyDecision> {
  const approvalRule = core.rule;
  const approvalMatched = core.matched;
  const verdict = await approvalHook.fn({
    tool: approvalHook.tool,
    argv: core.argv,
    rule: approvalRule,
    matched: approvalMatched,
  });
  if (verdict.approved) {
    return { ok: true, approval: { reserved_id: verdict.id } };
  }
  if ('refused' in verdict) {
    return {
      ok: false,
      rule: verdict.refused,
      message:
        `${what} '${approvalMatched}' requires operator approval, which requires an authenticated ` +
        'profile token (Authorization: Bearer); ?profile= callers cannot request or consume approvals',
      matched: approvalMatched,
    };
  }
  return {
    ok: false,
    rule: approvalRule,
    message: `${what} '${approvalMatched}' requires operator approval; approval_id=${verdict.id}; use approvals__wait then retry the SAME argv and cwd with the same profile token. An approved request stays executable until its own expires_at=${verdict.expires_at}`,
    matched: approvalMatched,
    pending_approval: { id: verdict.id, expires_at: verdict.expires_at, payload:verdict.payload },
  };
}

function evaluateCore(
  rawArgv: readonly string[],
  policy: CompiledCliPolicy,
): PolicyDecision | ApprovalNeeded {
  // 0. Canonical argv — the one object every later step (and the approval
  // hook, argvHash, opDigest) sees. See src/services/policy/operation.ts.
  let argv: readonly string[];
  try {
    argv = canonicalizeArgv(rawArgv);
  } catch (err) {
    if (!(err instanceof ArgvCanonicalizationError)) throw err;
    return { ok: false, rule: 'invalid_argv', message: err.message };
  }
  const invocationTable = invocationFlagTable(policy.command, argv, policy.flagTable);
  const invocationPath = policy.knownCommands
    ? canonicalizeCommandPath(argv.slice(0, 2), policy.knownCommands)?.join(' ')
    : '';
  const invocationAliases = cliProfileFor(policy.command)?.invocationOptionAliases?.({
    argv,
    path: invocationPath ?? '',
    table: invocationTable,
  }) ?? {};
  policy = {
    ...policy,
    flagTable: invocationTable,
    optionAliases: { ...policy.optionAliases, ...invocationAliases },
  };
  // 1. max_args
  if (argv.length > policy.maxArgs) {
    return {
      ok: false,
      rule: 'max_args',
      message: `argv length ${argv.length} exceeds max_args=${policy.maxArgs}`,
    };
  }

  // 2-4. Credential/secret guards — always apply, even to approvable calls.
  if (policy.denyArgs) {
    for (const tok of argv) {
      for (const needle of policy.denyArgs) {
        if (tok.includes(needle)) {
          return {
            ok: false,
            rule: 'deny_args',
            message: `argv element matched denied substring ${JSON.stringify(needle)} (preview: ${redactPreview(tok)})`,
            matched: needle,
          };
        }
      }
    }
  }
  if (policy.denyArgsRegex) {
    for (const tok of argv) {
      for (const re of policy.denyArgsRegex) {
        if (re.test(tok)) {
          return {
            ok: false,
            rule: 'deny_args_regex',
            message: `argv element matched denied pattern /${re.source}/ (preview: ${redactPreview(tok)})`,
            matched: re.source,
          };
        }
      }
    }
  }
  if (policy.denyArgvRegex) {
    const joined = argv.join(' ');
    for (const re of policy.denyArgvRegex) {
      if (re.test(joined)) {
        return {
          ok: false,
          rule: 'deny_argv_regex',
          message: `argv matches denied pattern ${re.source}`,
          matched: re.source,
        };
      }
    }
  }

  // 5-8 (+ approval match). Path rules run against every plausible reading
  // of argv (see cli-flag-arity.ts); if the readings disagree, refuse.
  const paths = resolvePathVerdict(argv, policy);
  if (paths.kind === 'deny') return paths.decision;

  // require_args / require_any_of: match either exact equality or the
  // `<arg>=value` form (single-token long flag). Avoids the trivial bypass
  // where an LLM picks `--namespace=sentinel` over `--namespace sentinel`.
  // Parse option occurrences, excluding values and everything after --.
  // Duplicate options fail requirements conservatively rather than guessing
  // whether the executable uses first/last wins or accumulates values.
  // A confined kubectl policy judges its namespace requirements with the
  // namespace gate below (step 8b), which reads argv exactly as kubectl does.
  // This arity pre-check then only guards the remaining requirements.
  const gateHandles = (needed: string): boolean =>
    hasNamespaceConfinement(policy.command) && isNamespaceRequirement(needed, policy.optionAliases);
  const ungated = [...(policy.requireArgs ?? []), ...(policy.requireAnyOf ?? []).flat()].filter(r => !gateHandles(r));
  if(ungated.length > 0) {
    for(let i=0;i<argv.length;i++) {
      const token=argv[i]!;
      if(token==='--')break;
      if(!token.startsWith('-') || token==='-')continue;
      const eq=token.indexOf('=');const name=eq<0?token:token.slice(0,eq);
      const arity=name.startsWith('--')?policy.flagTable.long.get(name.slice(2)):policy.flagTable.short.get(name.slice(1));
      if(!arity && (name.startsWith('-') && !name.startsWith('--') && name.length>2 || ![...(policy.requireArgs??[]),...(policy.requireAnyOf??[]).flat()].some(r=>r.split('=')[0]===name) || (eq<0 && argv[i+1]?.startsWith('-'))))return {ok:false,rule:'ambiguous_argv',message:'required options need known flag arity'};
      if(eq<0 && arity==='value')i++;
    }
  }
  // 8b. kubectl namespace confinement (cli-kubectl-confinement.ts).
  const gate = kubectlNamespaceGate(argv, policy);
  if (gate?.denial) return gate.denial;

  const options = new Map<string, Array<string | undefined>>();
  const positionals = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') break;
    if (!tok.startsWith('-') || tok === '-') { positionals.add(tok); continue; }
    const eq = tok.indexOf('=');
    const name = eq < 0 ? tok : tok.slice(0, eq);
    const arity = name.startsWith('--')
      ? policy.flagTable.long.get(name.slice(2))
      : policy.flagTable.short.get(name.slice(1));
    let value = eq < 0 ? undefined : tok.slice(eq + 1);
    if (eq < 0 && arity !== 'bool') value = argv[++i];
    const key = policy.optionAliases?.[name] ?? name;
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
  }
  const argHasRequirement = (needed: string): boolean => {
    if (!needed.startsWith('-')) return positionals.has(needed);
    // Confined kubectl: every namespace kubectl reads must be this one.
    // Repeating the same namespace is fine; the gate already refused the rest.
    if (gate?.namespaces && gateHandles(needed)) {
      const value = requiredValue(needed);
      return gate.namespaces.length > 0 && gate.namespaces.every(v => v === value);
    }
    const eq = needed.indexOf('=');
    const name = eq < 0 ? needed : needed.slice(0, eq);
    const values = options.get(policy.optionAliases?.[name] ?? name);
    if (!values || values.length !== 1) return false;
    if (eq >= 0) return values[0] === needed.slice(eq + 1);
    const arity = name.startsWith('--') ? policy.flagTable.long.get(name.slice(2)) : policy.flagTable.short.get(name.slice(1));
    return arity === 'bool' && (values[0] === undefined || values[0] === 'true');
  };
  // 9. require_args (every entry must appear)
  if (policy.requireArgs) {
    for (const needed of policy.requireArgs) {
      if (!argHasRequirement(needed)) {
        return {
          ok: false,
          rule: 'require_args',
          message: `required argv element ${JSON.stringify(needed)} is missing`,
          matched: needed,
        };
      }
    }
  }

  // 10. require_any_of (one per inner list)
  if (policy.requireAnyOf) {
    for (const group of policy.requireAnyOf) {
      if (!group.some(argHasRequirement)) {
        return {
          ok: false,
          rule: 'require_any_of',
          message: `at least one of [${group.map(g => JSON.stringify(g)).join(', ')}] must appear in argv`,
          matched: group.join('|'),
        };
      }
    }
  }

  // 11. Approval — strictly last. Every deny/allow/require check has passed,
  // so consulting the hook (which reserves an approved row) is now safe.
  if (paths.kind === 'approval') {
    return { needsApproval: true, argv, rule: paths.rule, matched: paths.matched };
  }

  return { ok: true };
}
