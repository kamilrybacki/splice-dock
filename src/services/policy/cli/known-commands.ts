// Per-tool known-command tables (1c fix B).
//
// Two bypasses motivated this:
//   1. Built-in aliases: `gh secret remove` is `gh secret delete`, `gh ext
//      uninstall` is `gh extension remove`. A rule written against the
//      canonical name missed the alias spelling.
//   2. Dynamic dispatch: gh runs extensions and config aliases for unknown
//      first tokens, kubectl runs `kubectl-<name>` plugins from PATH. Neither
//      is visible to subcommand rules.
//
// The table maps every alias to its canonical name (at the top level and under
// a canonical parent path) and lists the top-level commands the binary itself
// implements. An unknown top-level token is refused by the policy layer.
//
// Tables were taken from the offline `--help` output of gh 2.102 and kubectl
// 1.32. Commands a newer binary added are refused until listed here; commands
// listed here that an older binary lacks are harmless (the binary errors out).
// The tables themselves live in the per-CLI profiles (./profiles/).

import { cliProfileFor } from './profiles/index.js';
import type { KnownCommandTable } from './command-table.js';

export {
  canonicalizeCommandPath,
  canonicalizeRulePath,
  type KnownCommandTable,
} from './command-table.js';

/** Table for a tool, selected by the executable's basename. */
export function knownCommandsFor(command: string | undefined): KnownCommandTable | undefined {
  return cliProfileFor(command)?.knownCommands;
}
