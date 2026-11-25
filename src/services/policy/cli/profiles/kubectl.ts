// kubectl profile (tables taken from kubectl 1.32 offline help).

import { knownCommandTable } from '../commands/table.js';
import { KUBECTL_FLAGS } from '../kubectl/flags.js';
import { kubectlNamespaceConfinement } from '../kubectl/namespace-confinement.js';
import type { CliProfile } from './types.js';

// kubectl runs `kubectl-<name>` plugins from PATH for unknown first tokens;
// the known-command table makes the policy layer refuse them.
const KNOWN_COMMANDS = knownCommandTable(
  [
    'create', 'expose', 'run', 'set', 'explain', 'get', 'edit', 'delete', 'rollout', 'scale',
    'autoscale', 'certificate', 'cluster-info', 'top', 'cordon', 'uncordon', 'drain', 'taint',
    'describe', 'logs', 'attach', 'exec', 'port-forward', 'proxy', 'cp', 'auth', 'debug', 'events',
    'diff', 'apply', 'patch', 'replace', 'wait', 'kustomize', 'label', 'annotate', 'completion',
    'api-resources', 'api-versions', 'config', 'plugin', 'version', 'alpha', 'options', 'help',
  ],
  {
    create: {
      cm: 'configmap',
      cj: 'cronjob',
      deploy: 'deployment',
      ing: 'ingress',
      ns: 'namespace',
      pdb: 'poddisruptionbudget',
      pc: 'priorityclass',
      resourcequota: 'quota',
      svc: 'service',
      sa: 'serviceaccount',
    },
    top: { nodes: 'node', no: 'node', pods: 'pod', po: 'pod' },
    set: { sa: 'serviceaccount' },
    config: { use: 'use-context' },
  },
);

export const kubectlProfile: CliProfile = {
  name: 'kubectl',
  flags: KUBECTL_FLAGS,
  knownCommands: KNOWN_COMMANDS,
  optionAliases: {
    '-n': '--namespace', '-s': '--server', '-o': '--output', '-l': '--selector', '-c': '--container',
    '-L': '--label-columns', '-k': '--kustomize', '-v': '--v', '-A': '--all-namespaces', '-w': '--watch',
    '-R': '--recursive', '-i': '--stdin', '-t': '--tty', '-h': '--help',
  },
  // kuberc preferences off (KUBERC=off is the documented opt-out;
  // KUBECTL_KUBERC=false the feature gate), so no planted file or operator env
  // can rewrite a confined argv.
  envPins: { KUBERC: 'off', KUBECTL_KUBERC: 'false' },
  namespaceConfinement: kubectlNamespaceConfinement,
};
