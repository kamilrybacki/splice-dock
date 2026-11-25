// Credential-printing denials: argv whose purpose is to print a credential.
//
// A CLI passthrough child receives its credential through the environment, and
// several CLIs can echo their own environment or stored token back on request
// (`gh auth token`, `--jq 'env.GH_TOKEN'`). Those invocations are refused
// before anything is spawned, whatever the tool's policy says; no allow rule or
// approval overrides them.
//
// The rules are data, declared once per CLI profile (`CliProfile.credentialDenies`)
// and evaluated by the generic matcher below. Supporting another CLI means
// adding a list to its profile, not touching the matcher. Matching is
// deliberately conservative: when argv is ambiguous (more interpretations than
// the path extractor will enumerate) a rule whose command words all appear in
// argv still applies, even if that over-denies a harmless call.

import type { KnownCommandTable } from './commands/table.js';
import { canonicalizeCommandPath } from './commands/table.js';
import { extractSubcommandPaths } from './flags/arity.js';
import type { FlagTable } from './flags/table.js';

/** A flag, spelled the way the CLI accepts it: `--name` or `-n` (one letter). */
export type FlagSpelling = string;

/** Deny when one of `flags` is present on a matching command path. */
export interface PresenceFlagCondition {
  readonly kind: 'flag_present';
  /** Any one of these flags triggers the rule (`--flag`, `--flag=x`, `-f`, `-xfy`). */
  readonly flags: readonly FlagSpelling[];
}

/** Deny when the value of one of `flags` matches `pattern`. */
export interface ExpressionFlagCondition {
  readonly kind: 'expression_matches';
  /** Flags that carry a query or template expression (`--jq x`, `--jq=x`, `-qx`). */
  readonly flags: readonly FlagSpelling[];
  /** Tested against the flag's value. Must not use the `g` or `y` flag. */
  readonly pattern: RegExp;
}

export type CredentialDenyCondition = PresenceFlagCondition | ExpressionFlagCondition;

export interface CredentialPrintDeny {
  /** Stable identifier, reported to the caller (`credential_print_denied:<id>`). */
  readonly id: string;
  /** Why the invocation is refused; shown to the caller. Never echo argv values. */
  readonly reason: string;
  /** Leading command words, canonical form (`['auth', 'token']`). Empty = any command. */
  readonly path: readonly string[];
  /** When absent the rule matches on the path alone. */
  readonly when?: CredentialDenyCondition;
}

/** The CLI knowledge the matcher needs; all of it comes from the CLI's profile. */
export interface CredentialDenyContext {
  readonly table: FlagTable;
  readonly knownCommands?: KnownCommandTable;
}

function isFlagToken(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/** The letter of a one-letter short flag spelling (`-q` -> `q`), else undefined. */
function shortLetter(spelling: FlagSpelling): string | undefined {
  return /^-[^-]$/.test(spelling) ? spelling[1] : undefined;
}

/** The values supplied for `flags` in argv, in order. `null` marks a presence
 *  with no recoverable value (a flag that is the last token). A short cluster
 *  such as `-xq` reports the letter as present with the rest as its value. */
function flagValues(argv: readonly string[], flags: readonly FlagSpelling[]): (string | null)[] {
  const longs = new Set(flags.filter(f => f.startsWith('--')));
  const shorts = new Set(flags.map(shortLetter).filter((l): l is string => l !== undefined));
  const found: (string | null)[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') break;
    if (!isFlagToken(token)) continue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      if (!longs.has(name)) continue;
      found.push(eq === -1 ? (argv[i + 1] ?? null) : token.slice(eq + 1));
      continue;
    }
    // Short cluster: a letter in the list takes the remainder of the cluster as
    // its value, or the next token when it is the last character.
    const letters = token.slice(1);
    for (let j = 0; j < letters.length; j++) {
      if (!shorts.has(letters[j]!)) continue;
      const rest = letters.slice(j + 1).replace(/^=/, '');
      found.push(rest.length > 0 ? rest : (argv[i + 1] ?? null));
      break;
    }
  }
  return found;
}

/** Whether `words` appear in order among argv tokens. The fallback for argv
 *  too ambiguous for path extraction: it can only over-match. */
function containsInOrder(argv: readonly string[], words: readonly string[]): boolean {
  let next = 0;
  for (const token of argv) {
    if (next < words.length && token === words[next]) next += 1;
  }
  return next === words.length;
}

function pathMatches(argv: readonly string[], path: readonly string[], ctx: CredentialDenyContext): boolean {
  if (path.length === 0) return true;
  const candidates = extractSubcommandPaths(argv, ctx.table);
  if (candidates === null) return containsInOrder(argv, path);
  return candidates.some(candidate => {
    const canonical = (ctx.knownCommands ? canonicalizeCommandPath(candidate, ctx.knownCommands) : null) ?? candidate;
    return path.every((word, i) => canonical[i] === word);
  });
}

function conditionMatches(argv: readonly string[], condition: CredentialDenyCondition | undefined): boolean {
  if (!condition) return true;
  const values = flagValues(argv, condition.flags);
  if (condition.kind === 'flag_present') return values.length > 0;
  // A flag with no value cannot carry an expression; nothing to inspect.
  return values.some(value => value !== null && condition.pattern.test(value));
}

/** The first deny rule that argv trips, or undefined. */
export function findCredentialDeny(
  argv: readonly string[],
  rules: readonly CredentialPrintDeny[] | undefined,
  ctx: CredentialDenyContext,
): CredentialPrintDeny | undefined {
  if (!rules || rules.length === 0) return undefined;
  return rules.find(rule => pathMatches(argv, rule.path, ctx) && conditionMatches(argv, rule.when));
}

/** Caller-facing refusal text for a tripped rule. Names the rule, never the argv. */
export function credentialDenyMessage(rule: CredentialPrintDeny): string {
  return `Denied: ${rule.reason} (credential_print_denied:${rule.id})`;
}
