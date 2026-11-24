// GitHub CLI profile (verified against gh 2.102.0, see ../gh/version.ts).

import { join } from 'node:path';
import { canonicalizeCommandPath, knownCommandTable } from '../commands/table.js';
import { flagTable, type FlagArity, type FlagTable } from '../flags/table.js';
import type { CliProfile, InvocationContext } from './types.js';

// Only flags whose arity is the same in every subcommand belong here. When in
// doubt, leave a flag out: unknown flags are handled by ambiguity detection,
// a wrong entry is a bypass.
const FLAGS = flagTable({
  longValue: [
    'repo', 'hostname', 'limit', 'state', 'jq', 'field',
    'raw-field', 'method', 'header', 'label', 'assignee', 'milestone', 'title',
    'body', 'body-file', 'base', 'head', 'author', 'search', 'branch', 'workflow',
    'reviewer', 'env', 'org', 'visibility',
  ],
  longBool: [
    'help', 'web', 'yes', 'paginate', 'draft', 'fill', 'verbose',
    'silent', 'include', 'exit-status', 'admin', 'auto', 'squash', 'merge', 'rebase',
    'delete-branch', 'private', 'public', 'internal',
  ],
  // Verified against gh 2.102.0 help (tests/unit/drivers/gh-help-tables.test.ts).
  // Deliberately absent: --json (bool on `workflow run`), --template (bool on
  // `repo edit`), --comments (value on `search issues|prs`), -h (--hostname on
  // auth/config), --confirm (hidden, unverifiable). See invocationFlagTable.
  shortValue: ['R', 'L', 'X', 'H', 'B', 'A', 'S'],
  shortBool: ['y'],
});

const LS = { ls: 'list' };
const LS_NEW = { ls: 'list', new: 'create' };

// `co` (pr checkout) is NOT a top-level built-in: it is an alias in gh's
// default user config, so it resolves from config and is refused here.
const KNOWN_COMMANDS = knownCommandTable(
  [
    'auth', 'browse', 'codespace', 'discussion', 'gist', 'issue', 'org', 'pr', 'project', 'release',
    'repo', 'skill', 'cache', 'run', 'workflow', 'agent-task', 'alias', 'api', 'attestation',
    'completion', 'config', 'copilot', 'extension', 'gpg-key', 'label', 'licenses', 'preview',
    'ruleset', 'search', 'secret', 'ssh-key', 'status', 'variable', 'help', 'version',
    // help topics
    'accessibility', 'actions', 'environment', 'exit-codes', 'formatting', 'mintty', 'reference',
    'telemetry',
  ],
  {
    '': {
      cs: 'codespace',
      skills: 'skill',
      'agent-tasks': 'agent-task',
      agent: 'agent-task',
      agents: 'agent-task',
      at: 'attestation',
      extensions: 'extension',
      ext: 'extension',
      rs: 'ruleset',
    },
    codespace: LS,
    discussion: LS,
    gist: LS_NEW,
    issue: LS_NEW,
    org: LS,
    pr: { ...LS_NEW, co: 'checkout' },
    project: LS,
    release: LS_NEW,
    repo: LS_NEW,
    skill: { ls: 'list', add: 'install', show: 'preview' },
    cache: LS,
    run: LS,
    workflow: LS,
    alias: LS,
    config: LS,
    extension: { ls: 'list', uninstall: 'remove' },
    'gpg-key': LS,
    label: LS,
    ruleset: LS,
    secret: { ls: 'list', remove: 'delete' },
    'ssh-key': LS,
    variable: { ls: 'list', remove: 'delete' },
    'repo autolink': LS_NEW,
    'repo deploy-key': LS,
    'repo gitignore': LS,
    'repo license': LS,
  },
);

/** gh commands where `-h` takes a value instead of meaning --help (gh 2.102.0). */
export const GH_SHORT_H_VALUE: Readonly<Record<string, string>> = {
  'auth login': '--hostname', 'auth logout': '--hostname', 'auth refresh': '--hostname',
  'auth setup-git': '--hostname', 'auth status': '--hostname', 'auth switch': '--hostname',
  'auth token': '--hostname', 'config get': '--host', 'config list': '--host', 'config set': '--host',
  'repo create': '--homepage', 'repo edit': '--homepage',
};

const EDITING_PATHS = ['pr create', 'pr edit', 'issue create', 'issue edit'];
const CREATE_PATHS = ['pr create', 'issue create'];
const QUIET_PATHS = ['pr list', 'pr view', 'issue list', 'issue view', 'repo list', 'repo view', 'run list', 'run view'];

/** Subcommand-specific shorthand meanings. Resolve only an explicit leading
 * command path; flags before it retain conservative unknown-arity handling. */
function invocationFlagTable(argv: readonly string[], base: FlagTable): FlagTable {
  const short = new Map(base.short);
  const long = new Map(base.long);
  const path = (canonicalizeCommandPath(argv.slice(0, 2), KNOWN_COMMANDS) ?? []).join(' ');
  const put = (spec: Record<string, FlagArity>): void => { for (const [k, v] of Object.entries(spec)) short.set(k, v); };
  const putLong = (spec: Record<string, FlagArity>): void => { for (const [k, v] of Object.entries(spec)) long.set(k, v); };
  if (EDITING_PATHS.includes(path)) put({ m: 'value', F: 'value', b: 'value', t: 'value' });
  if (CREATE_PATHS.includes(path)) put({ a: 'value', l: 'value' });
  if (path === 'pr create') put({ f: 'bool', F: 'value', d: 'bool', H: 'value', B: 'value', r: 'value', p: 'value', T: 'value' });
  if (path === 'pr merge') put({ m: 'bool' });
  if (Object.prototype.hasOwnProperty.call(GH_SHORT_H_VALUE, path)) put({ h: 'value' });
  if (QUIET_PATHS.includes(path)) put({ q: 'value' });
  // Long flags whose arity differs between subcommands (gh 2.102.0 help).
  if (path) {
    putLong({ json: path === 'workflow run' ? 'bool' : 'value', template: path === 'repo edit' ? 'bool' : 'value' });
    if (['issue view', 'pr view', 'discussion view'].includes(path)) putLong({ comments: 'bool' });
    if (['search issues', 'search prs'].includes(path)) putLong({ comments: 'value' });
  }
  return { long, short };
}

/** Long spelling of a shorthand whose meaning depends on the invocation. */
function shorthandLongName(k: string, ctx: InvocationContext): string {
  const arity = ctx.table.short.get(k);
  switch (k) {
    case 'a': return '--assignee';
    case 'm': return arity === 'bool' ? '--merge' : '--milestone';
    case 'f': return ctx.argv[0] === 'repo' ? '--force' : '--fill';
    case 'F': return '--body-file';
    default: return arity === 'bool' ? '--quiet' : '--jq';
  }
}

function invocationOptionAliases(ctx: InvocationContext): Readonly<Record<string, string>> {
  const { path } = ctx;
  return {
    ...(EDITING_PATHS.includes(path) ? { '-F': '--body-file', '-b': '--body', '-t': '--title' } : {}),
    // gh 2.102 defines -l (--label) on the create commands only, matching invocationFlagTable.
    ...(CREATE_PATHS.includes(path) ? { '-l': '--label' } : {}),
    // -h is --help except where gh gives it a value (--hostname, --host, --homepage).
    ...(path ? { '-h': Object.prototype.hasOwnProperty.call(GH_SHORT_H_VALUE, path) ? GH_SHORT_H_VALUE[path]! : '--help' } : {}),
    ...(path === 'pr create' ? { '-d': '--draft', '-H': '--head', '-B': '--base', '-r': '--reviewer', '-p': '--project', '-T': '--template' } : {}),
    ...Object.fromEntries(['a', 'm', 'f', 'F', 'q'].filter(k => ctx.table.short.has(k)).map(k => ['-' + k, shorthandLongName(k, ctx)])),
  };
}

export const ghProfile: CliProfile = {
  name: 'gh',
  flags: FLAGS,
  knownCommands: KNOWN_COMMANDS,
  optionAliases: { '-R': '--repo', '-L': '--limit', '-X': '--method', '-H': '--header', '-B': '--base', '-A': '--author', '-S': '--search', '-y': '--yes' },
  // `gh api` sends raw HTTP requests and bypasses subcommand classification entirely (D14a).
  hardDenyPaths: [['api']],
  isolatedConfigEnv: configHome => ({ GH_CONFIG_DIR: join(configHome, 'gh') }),
  invocationFlagTable,
  invocationOptionAliases,
  // Raw API access is never run through a gh tool.
  requiresBroker: p => p[0] === 'api',
  // Repository deletion needs a tool whose policy routes it to approval;
  // that approval always requires WebAuthn (docs/architecture.md).
  strongApprovalPaths: p => p[0] === 'repo' && p[1] === 'delete',
};
