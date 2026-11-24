// kubectl's namespace-confinement hooks for its CliProfile. The policy engine
// calls these through the profile and never names kubectl itself.
import { extractSubcommandPaths, type FlagTable } from '../flags/arity.js';
import type { NamespaceConfinement } from '../profiles/types.js';
import { kubectlConfinementBreach, kubectlNamespaceValues, type ConfinementReason } from './confinement.js';

const REASON_TEXT: Readonly<Record<ConfinementReason, string>> = {
  target: 're-addresses the request (another URI, server, cluster or context)',
  scope: 'widens the request past the namespace',
  identity: 'changes the identity the request is made as',
  'client-config': 'replaces the client config, its trust roots or caches',
  'local-file': 'writes caller-chosen local files',
  'manifest-source': 'reads manifests that carry their own namespace (files, URLs, kustomizations)',
};

/** Why argv escapes a required namespace, or undefined. Never echoes values. */
function breachMessage(argv: readonly string[], table: FlagTable): string | undefined {
  const breach = kubectlConfinementBreach(argv);
  if (breach?.flag === '--all-namespaces') return 'conflicts with --all-namespaces, which ignores the namespace';
  if (breach) return `confines kubectl to a namespace; ${breach.flag} ${REASON_TEXT[breach.reason]}`;
  const paths = extractSubcommandPaths(argv, table);
  if (paths === null) return 'confines kubectl to a namespace; argv is too ambiguous to check';
  if (paths.some(p => p[0] === 'config')) {
    return 'confines kubectl to a namespace; the config subcommand reads and rewrites the kubeconfig';
  }
  return undefined;
}

export const kubectlNamespaceConfinement: NamespaceConfinement = {
  label: 'kubectl',
  namespaceValues: kubectlNamespaceValues,
  breachMessage,
};
