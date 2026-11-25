// CLI profile registry, selected by the executable's basename.
//
// The core never names a CLI: the composition root builds the registry from
// the profiles it ships (src/builtin-backends.ts) and hands it to every
// consumer. Supporting a new CLI means adding one profile and listing it there.

import type { CliProfile } from './types.js';

export type { CliProfile, InvocationContext, NamespaceConfinement } from './types.js';

/** Looks up the profile for a tool's executable. */
export interface CliProfileRegistry {
  /** The profile for a command path, or undefined for CLIs without one. */
  profileFor(command: string | undefined): CliProfile | undefined;
}

/** Basename of a command path (`/usr/bin/gh` → `gh`). */
export function commandBasename(command: string): string {
  return command.slice(command.lastIndexOf('/') + 1);
}

/** A registry over the given profiles. Two profiles with one name are a wiring bug. */
export function createCliProfileRegistry(profiles: readonly CliProfile[]): CliProfileRegistry {
  const byName = new Map<string, CliProfile>();
  for (const profile of profiles) {
    if (byName.has(profile.name)) throw new Error(`duplicate CLI profile: ${profile.name}`);
    byName.set(profile.name, profile);
  }
  return { profileFor: command => (command ? byName.get(commandBasename(command)) : undefined) };
}

/** No CLI has a profile: every tool gets the generic defaults. */
export const NO_CLI_PROFILES: CliProfileRegistry = createCliProfileRegistry([]);
