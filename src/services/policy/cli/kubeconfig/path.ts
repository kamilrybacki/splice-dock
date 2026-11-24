// An operator-declared KUBECONFIG must be absolute.
//
// cli_passthrough tools spawn in a caller-chosen cwd, and client-go (kubectl,
// helm) resolves a relative KUBECONFIG entry against that cwd. A relative path
// would let the MCP caller plant its own kubeconfig, and with it another
// server, identity or namespace. KUBECONFIG is a list separated by ':';
// client-go skips empty entries, so only the non-empty ones are checked.
//
// The loader checks every value it can read without a live call (bare names
// and env: refs) at startup and on SIGHUP; the wrapper checks the resolved
// value again before every spawn (vault: refs, and env values that changed).
// Messages never include the path.
import { isAbsolute } from 'node:path';

export const KUBECONFIG_VAR = 'KUBECONFIG';

export const KUBECONFIG_RELATIVE_MESSAGE =
  'KUBECONFIG must be an absolute path (every non-empty entry of the list); a relative entry resolves against the caller-chosen cwd';

/** Whether a KUBECONFIG value has a relative entry. Unset or empty is fine
 *  (in-cluster config or the default ~/.kube/config). */
export function kubeconfigIsRelative(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(':').some(entry => entry !== '' && !isAbsolute(entry));
}
