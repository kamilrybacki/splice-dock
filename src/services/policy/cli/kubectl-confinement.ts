// kubectl namespace confinement.
//
// A kubectl policy that requires a namespace (require_args / require_any_of
// naming --namespace or -n) is a confinement boundary: the call must stay in
// that namespace, on the operator's cluster, as the operator's identity. A
// required `--namespace=X` alone does not achieve that. Several kubectl flags
// re-target the request, swap the identity or client config, or read manifests
// that carry their own namespace, and kubectl happily accepts them next to
// --namespace. All of them are refused while confined.
//
// The scan works on raw tokens. It is deliberately independent of the policy's
// flag-arity table and of operator value_flags / boolean_flags overrides, so
// neither can hide a breach. Every option-shaped token before the real end of
// options is inspected, even one that pflag would consume as another flag's
// value: that can only over-deny, never under-deny.
//
// Spellings covered (kubectl 1.32.3, spf13/pflag):
//   --flag=value, --flag value, --flag (bools), any bool value (=false too)
//   --flag_name: kubectl normalizes '_' to '-' (WordSepNormalizeFunc)
//   -s x, -s=x, -sx, and short clusters such as -wA / -As
//   repeated flags (each occurrence is a breach)
// `--` ends the scan only where pflag treats it as the end of options. After a
// flag that consumes the next token (`-l --`) or a flag of unknown arity
// (`--x --`), the `--` may be a value, so scanning continues (fail closed).
//
// Findings name the canonical flag only, never its value: values here are
// tokens, client keys and server URLs.
import { flagTableFor, type FlagTable } from './flag-arity.js';

export type ConfinementReason =
  | 'target' // re-addresses the request: another URI, cluster, server or context
  | 'scope' // widens the request past the namespace (all namespaces)
  | 'identity' // authenticates or impersonates as someone else
  | 'client-config' // replaces the client config, trust roots or local caches
  | 'local-file' // writes caller-chosen local files
  | 'manifest-source'; // reads manifests (or URLs, kustomizations) with their own namespace

export interface ConfinementBreach {
  /** Canonical flag name (`--server`, `-f`), never the value. */
  readonly flag: string;
  readonly reason: ConfinementReason;
}

// Verified against `kubectl options` and `kubectl get --help` (1.32.3);
// --kuberc is the 1.33+ preferences file.
const LONG_BREACHES: Readonly<Record<string, ConfinementReason>> = {
  raw: 'target',
  server: 'target',
  cluster: 'target',
  context: 'target',
  'tls-server-name': 'target',
  'all-namespaces': 'scope',
  user: 'identity',
  username: 'identity',
  password: 'identity',
  token: 'identity',
  as: 'identity',
  'as-group': 'identity',
  'as-uid': 'identity',
  'client-certificate': 'identity',
  'client-key': 'identity',
  kubeconfig: 'client-config',
  kuberc: 'client-config',
  'certificate-authority': 'client-config',
  'insecure-skip-tls-verify': 'client-config',
  'cache-dir': 'client-config',
  profile: 'local-file',
  'profile-output': 'local-file',
  filename: 'manifest-source',
  kustomize: 'manifest-source',
};

// -f is --filename on most commands and --follow on `logs`; both meanings are
// refused (use --follow), because classifying it per subcommand is a bypass
// waiting to happen.
const SHORT_BREACHES: Readonly<Record<string, ConfinementBreach>> = {
  s: { flag: '--server', reason: 'target' },
  A: { flag: '--all-namespaces', reason: 'scope' },
  f: { flag: '-f', reason: 'manifest-source' },
  k: { flag: '--kustomize', reason: 'manifest-source' },
};

const KUBECTL = flagTableFor('kubectl');

/** The flag name of a long option, normalized the way kubectl does it. */
function longName(tok: string): string {
  const eq = tok.indexOf('=');
  return (eq < 0 ? tok.slice(2) : tok.slice(2, eq)).replaceAll('_', '-');
}

function shortBreach(tok: string): ConfinementBreach | undefined {
  for (const c of tok.slice(1)) {
    const hit = SHORT_BREACHES[c];
    if (hit) return hit;
    // A value flag takes the rest of the cluster as its value (-nkube-system).
    if (KUBECTL.short.get(c) === 'value') return undefined;
  }
  return undefined;
}

/** Whether pflag might take the token after `tok` as its value. */
function mayConsumeNext(tok: string): boolean {
  if (!tok.startsWith('-') || tok === '-') return false;
  if (tok.startsWith('--')) return !tok.includes('=') && KUBECTL.long.get(longName(tok)) !== 'bool';
  const chars = tok.slice(1);
  for (let j = 0; j < chars.length; j++) {
    const arity = KUBECTL.short.get(chars[j]!);
    if (arity === undefined) return true;
    if (arity === 'value') return j === chars.length - 1;
  }
  return false;
}

/** The first flag in argv that breaks namespace confinement, if any. */
export function kubectlConfinementBreach(argv: readonly string[]): ConfinementBreach | undefined {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') {
      if (i > 0 && mayConsumeNext(argv[i - 1]!)) continue;
      return undefined;
    }
    if (!tok.startsWith('-') || tok === '-') continue;
    if (tok.startsWith('--')) {
      const name = longName(tok);
      const reason = LONG_BREACHES[name];
      if (reason) return { flag: `--${name}`, reason };
      continue;
    }
    const hit = shortBreach(tok);
    if (hit) return hit;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Effective namespace.
//
// Every namespace kubectl would read from argv, following pflag exactly:
//   --namespace X, --namespace=X, -n X, -nX, -n=X, and short clusters whose
//   bools end in n (-wn X, -wnX, -wn=X). A value flag swallows the next token
//   even when it looks like an option (-l -n x reads no namespace), and `--`
//   ends options unless it is swallowed as a value.
// Where pflag's reading depends on a flag the table does not know, both
// readings are tried. If they find different namespaces, or a namespace flag
// has no value, the result is null (ambiguous): callers must refuse.

type Consume = 'no' | 'yes' | 'maybe';
interface Step {
  readonly values: readonly string[];
  readonly consume: Consume;
}

function longStep(argv: readonly string[], i: number, table: FlagTable): Step | null {
  const tok = argv[i]!;
  const name = longName(tok);
  const eq = tok.indexOf('=');
  const arity = table.long.get(name);
  if (name === 'namespace') {
    if (arity !== 'value') return null;
    if (eq >= 0) return { values: [tok.slice(eq + 1)], consume: 'no' };
    return i + 1 < argv.length ? { values: [argv[i + 1]!], consume: 'yes' } : null;
  }
  if (eq >= 0 || arity === 'bool') return { values: [], consume: 'no' };
  return { values: [], consume: arity === 'value' ? 'yes' : 'maybe' };
}

function shortStep(argv: readonly string[], i: number, table: FlagTable): Step | null {
  const chars = argv[i]!.slice(1);
  for (let j = 0; j < chars.length; j++) {
    const c = chars[j]!;
    const rest = chars.slice(j + 1);
    // pflag: `-x=v` gives x the value v (bool or not) and ends the cluster.
    const eqValue = rest.length > 1 && rest.startsWith('=') ? rest.slice(1) : undefined;
    const arity = table.short.get(c);
    if (arity === undefined) return rest.includes('n') ? null : { values: [], consume: 'maybe' };
    if (arity === 'bool') {
      if (eqValue !== undefined) return { values: [], consume: 'no' };
      continue;
    }
    if (rest.length > 0) return { values: c === 'n' ? [eqValue ?? rest] : [], consume: 'no' };
    if (c !== 'n') return { values: [], consume: 'yes' };
    return i + 1 < argv.length ? { values: [argv[i + 1]!], consume: 'yes' } : null;
  }
  return { values: [], consume: 'no' };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, k) => v === b[k]);

/** Every namespace value kubectl would read from argv, in order, or null when
 *  argv is ambiguous. Uses kubectl's built-in arity table unless one is given.
 *  Values are returned for comparison only; never echo them. */
export function kubectlNamespaceValues(argv: readonly string[], table: FlagTable = KUBECTL): readonly string[] | null {
  const memo = new Map<number, readonly string[] | null>();
  const from = (start: number): readonly string[] | null => {
    let i = start;
    while (i < argv.length && (!argv[i]!.startsWith('-') || argv[i] === '-')) i++;
    if (i >= argv.length || argv[i] === '--') return [];
    if (memo.has(i)) return memo.get(i) ?? null;
    const step = argv[i]!.startsWith('--') ? longStep(argv, i, table) : shortStep(argv, i, table);
    let result: readonly string[] | null;
    if (step === null) result = null;
    else if (step.consume !== 'maybe') {
      const tail = from(i + (step.consume === 'yes' ? 2 : 1));
      result = tail === null ? null : [...step.values, ...tail];
    } else {
      const free = from(i + 1);
      const taken = from(i + 2);
      result = free === null || taken === null || !sameList(free, taken) ? null : [...step.values, ...free];
    }
    memo.set(i, result);
    return result;
  };
  return from(0);
}
