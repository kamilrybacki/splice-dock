// Backends shipped with the gateway: CLI profiles, standing-grant shapes and
// breaker read-only probes. This is the only place that names gh or kubectl;
// the core receives these registries from the composition root and never
// imports a backend module itself (enforced by .dependency-cruiser.cjs).

import { createReadonlyProbes, type ReadonlyProbe } from './services/policy/breaker/readonly.js';
import { ghProfile } from './services/policy/cli/profiles/gh.js';
import { createCliProfileRegistry } from './services/policy/cli/profiles/index.js';
import { kubectlProfile } from './services/policy/cli/profiles/kubectl.js';
import { kubectlBaseShape, kubectlReadonlyProbe, kubectlShape } from './services/policy/shape/kubectl.js';
import { createShapeRegistry } from './services/policy/shape/registry.js';

const GH_READONLY_COMMANDS = ['repo view', 'repo list', 'pr list', 'issue list', 'run list'];
const ghReadonlyProbe: ReadonlyProbe = argv => argv.length === 2 && GH_READONLY_COMMANDS.includes(argv.join(' '));

/** CLI profiles shipped with the gateway, keyed by executable basename. */
export const builtinCliProfiles = createCliProfileRegistry([ghProfile, kubectlProfile]);

/** Standing-grant shapes shipped with the gateway, keyed by YAML tool name. */
export const builtinShapes = createShapeRegistry({
  kubectl: { shape: kubectlShape, baseShape: kubectlBaseShape },
});

/** Breaker read-only exemptions shipped with the gateway, keyed by YAML tool name. */
export const builtinReadonlyProbes = createReadonlyProbes({
  gh: ghReadonlyProbe,
  kubectl: kubectlReadonlyProbe,
});
