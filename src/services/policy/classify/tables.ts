import type { ToolTable } from './base.js';

const KUBECTL_NEUTRAL = { '-n': true, '--namespace': true, '-o': true, '--output': true, '-l': true, '--selector': true, '--context': true, '--wait': false, '--dry-run': false } as const;

/** Seed tables. Each row was written by a human; anything absent abstains. */
export const TABLES: Readonly<Record<string, ToolTable>> = {
  kubectl: {
    neutralFlags: KUBECTL_NEUTRAL,
    raiseFlags: ['--force', '--now', '--all', '-A', '--all-namespaces', '--ignore-not-found'],
    raiseValueFlags: { '--cascade': ['*'], '--grace-period': ['*'] },
    verbs: [
      { verb: 'get', class: 'benign' },
      { verb: 'describe', class: 'benign' },
      { verb: 'logs', class: 'benign' },
      { verb: 'uncordon', class: 'benign' },
      // Deleting is destructive by default; the listed kinds are recreated by their controller.
      { verb: 'delete', class: 'destructive', kinds: { pod: 'disruptive', pods: 'disruptive', po: 'disruptive' } },
      { verb: 'rollout restart', class: 'disruptive' },
      { verb: 'rollout undo', class: 'disruptive' },
      { verb: 'scale', class: 'disruptive' },
      { verb: 'cordon', class: 'disruptive' },
      { verb: 'drain', class: 'disruptive' },
    ],
  },
  gh: {
    neutralFlags: { '--repo': true, '-R': true, '--json': true },
    raiseFlags: ['--force', '--admin', '--delete-branch'],
    raiseValueFlags: { '-X': ['DELETE'], '--method': ['DELETE'] },
    verbs: [
      { verb: 'pr view', class: 'benign' },
      { verb: 'pr list', class: 'benign' },
      { verb: 'issue view', class: 'benign' },
      { verb: 'issue list', class: 'benign' },
      { verb: 'pr close', class: 'disruptive' },
      { verb: 'pr merge', class: 'disruptive' },
      { verb: 'release delete', class: 'destructive' },
      { verb: 'repo delete', class: 'destructive' },
    ],
  },
};
