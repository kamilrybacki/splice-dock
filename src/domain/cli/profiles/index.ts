// Registry of built-in CLI profiles, selected by the executable's basename.
// Adding support for a new CLI means adding one profile module here; nothing
// else in the codebase tests for binary names.

import { ghProfile } from './gh.js';
import { kubectlProfile } from './kubectl.js';
import type { CliProfile } from './types.js';

export type { CliProfile, InvocationContext } from './types.js';

const PROFILES: ReadonlyMap<string, CliProfile> = new Map(
  [ghProfile, kubectlProfile].map(p => [p.name, p]),
);

/** Basename of a command path (`/usr/bin/gh` → `gh`). */
export function commandBasename(command: string): string {
  return command.slice(command.lastIndexOf('/') + 1);
}

/** The built-in profile for a tool's executable, or undefined for unknown CLIs. */
export function cliProfileFor(command: string | undefined): CliProfile | undefined {
  return command ? PROFILES.get(commandBasename(command)) : undefined;
}
