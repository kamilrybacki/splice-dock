// The builtin CLI profiles (gh, kubectl) as the composition root wires them.
// Core code takes a profile by injection; tests that exercise gh/kubectl
// rules resolve one here, by command name or path, like the runtime does.
import { beforeEach } from 'vitest';
import { builtinCliProfiles } from '../../src/builtin-backends.js';
import type { CliProfile } from '../../src/services/policy/cli/profiles/index.js';
import { configurePassthrough } from '../../src/services/tools/adapters/cli/passthrough.js';

export { builtinCliProfiles };

/** The builtin profile for a command (basename match), or undefined. */
export function cliProfile(command: string | undefined): CliProfile | undefined {
  return builtinCliProfiles.profileFor(command);
}

/** Install the builtin profiles in the passthrough before each test, as main() does. */
export function useBuiltinCliProfiles(): void {
  beforeEach(() => configurePassthrough({ cliProfiles: builtinCliProfiles }));
}
