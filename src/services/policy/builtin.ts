import { createReadonlyProbes, type ReadonlyProbe } from './breaker/readonly.js';
import { kubectlBaseShape, kubectlReadonlyProbe, kubectlShape } from './shape/kubectl.js';
import { createShapeRegistry } from './shape/registry.js';

const GH_READONLY_COMMANDS = ['repo view', 'repo list', 'pr list', 'issue list', 'run list'];
const ghReadonlyProbe: ReadonlyProbe = argv => argv.length === 2 && GH_READONLY_COMMANDS.includes(argv.join(' '));

/** Standing-grant shapes shipped with the gateway, keyed by YAML tool name. */
export const builtinShapes = createShapeRegistry({
  kubectl: { shape: kubectlShape, baseShape: kubectlBaseShape },
});

/** Breaker read-only exemptions shipped with the gateway, keyed by YAML tool name. */
export const builtinReadonlyProbes = createReadonlyProbes({
  gh: ghReadonlyProbe,
  kubectl: kubectlReadonlyProbe,
});
