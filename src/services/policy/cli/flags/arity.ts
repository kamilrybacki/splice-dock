// Tool-aware flag arity for subcommand-path extraction.
//
// Path rules (deny/allow/approval subcommands and paths) match against the
// non-flag tokens of argv. To find those, we must know which flags consume
// the following token as their value. Guessing wrong either way lets a caller
// shift the path past a deny rule:
//   - treating a boolean flag as value-taking hides the next token
//     (`repo --yes delete` → path `repo`),
//   - treating a value flag as boolean exposes its value as a subcommand
//     (`-n ns delete` → path `ns delete`).
//
// So each tool gets a table of flags whose arity is KNOWN across all of its
// subcommands. A flag that is not in the table (or whose arity differs between
// subcommands, e.g. kubectl `-p`) is UNKNOWN: both interpretations are
// enumerated, and the policy evaluator refuses the call when the candidates
// disagree on any path-rule outcome. Unknown flags never silently swallow a
// token.
//
// Parsing follows spf13/pflag (used by gh and kubectl via cobra):
//   --flag=value      attached value, never consumes the next token
//   --flag value      value flag consumes the next token unconditionally,
//                     even if it starts with `-` (including `--`)
//   -abc              short cluster; a value flag inside a cluster takes the
//                     rest of the cluster as its value (`-nfoo`, `-n=foo`), or
//                     the next token when it is the last char
//   --                ends flag parsing; every remaining token is positional
//   -                 positional (conventionally stdin)

import { cliProfileFor } from '../profiles/index.js';
import { EMPTY_FLAG_TABLE, type FlagArity, type FlagTable } from './table.js';

export type { FlagArity, FlagTable } from './table.js';
export { GH_SHORT_H_VALUE } from '../profiles/gh.js';

/** Hard cap on enumerated interpretations (2^6). Beyond it the argv is too
 *  ambiguous to reason about and path extraction fails closed. */
export const MAX_PATH_CANDIDATES = 64;

export interface FlagOverrides {
  value_flags?: readonly string[];
  boolean_flags?: readonly string[];
}

/** Built-in table for a tool command (basename), merged with operator-declared
 *  overrides from the policy. Unknown tools start from an empty table. */
export function flagTableFor(command: string | undefined, overrides?: FlagOverrides): FlagTable {
  const base = cliProfileFor(command)?.flags ?? EMPTY_FLAG_TABLE;
  if (!overrides?.value_flags?.length && !overrides?.boolean_flags?.length) return base;
  const long = new Map(base.long);
  const short = new Map(base.short);
  const put = (flag: string, arity: FlagArity): void => {
    if (flag.startsWith('--')) long.set(flag.slice(2), arity);
    else if (flag.startsWith('-')) short.set(flag.slice(1), arity);
  };
  for (const f of overrides.boolean_flags ?? []) put(f, 'bool');
  for (const f of overrides.value_flags ?? []) put(f, 'value');
  return { long, short };
}

/** How a single flag token affects the next token. */
type Consume = 'no' | 'yes' | 'maybe';

function longFlagConsumes(tok: string, t: FlagTable): Consume {
  if (tok.includes('=')) return 'no';
  const arity = t.long.get(tok.slice(2));
  if (arity === 'bool') return 'no';
  if (arity === 'value') return 'yes';
  return 'maybe';
}

function shortClusterConsumes(tok: string, t: FlagTable): Consume {
  const chars = tok.slice(1);
  for (let j = 0; j < chars.length; j++) {
    const arity = t.short.get(chars[j]!);
    if (arity === undefined) return 'maybe';
    if (arity === 'value') {
      // Rest of the cluster (if any) is the value; otherwise the next token is.
      return j === chars.length - 1 ? 'yes' : 'no';
    }
  }
  return 'no';
}

/** Every plausible subcommand path for argv under table `t`, deduplicated.
 *  Returns `null` when the number of interpretations exceeds the cap. */
export function extractSubcommandPaths(argv: readonly string[], t: FlagTable): string[][] | null {
  const results = new Map<string, string[]>();
  let leaves = 0;
  let overflow = false;

  const walk = (start: number, prefix: readonly string[]): void => {
    const out = [...prefix];
    for (let i = start; i < argv.length; i++) {
      const tok = argv[i]!;
      if (tok === '--') {
        out.push(...argv.slice(i + 1));
        break;
      }
      if (!tok.startsWith('-') || tok === '-') {
        out.push(tok);
        continue;
      }
      const consume = tok.startsWith('--') ? longFlagConsumes(tok, t) : shortClusterConsumes(tok, t);
      if (consume === 'yes') {
        i += 1;
      } else if (consume === 'maybe' && i + 1 < argv.length) {
        // Branch: the unknown flag takes the next token as its value...
        walk(i + 2, out);
        if (overflow) return;
        // ...or it is boolean and parsing continues at the next token.
      }
    }
    leaves += 1;
    if (leaves > MAX_PATH_CANDIDATES) {
      overflow = true;
      return;
    }
    results.set(JSON.stringify(out), out);
  };

  walk(0, []);
  return overflow ? null : [...results.values()];
}

/** Subcommand-specific shorthand meanings, from the CLI's profile. Resolve
 *  only an explicit leading command path; flags before it retain conservative
 *  unknown-arity handling. */
export function invocationFlagTable(command: string | undefined, argv: readonly string[], base: FlagTable): FlagTable {
  return cliProfileFor(command)?.invocationFlagTable?.(argv, base) ?? base;
}
