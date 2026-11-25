// kubectl flag arity table (kubectl 1.32 offline help). Its own module so the
// profile and the namespace-confinement checker can share it without a cycle.

import { flagTable } from '../flags/table.js';

// Only flags whose arity is the same in every subcommand (kubectl `-p` is not).
export const KUBECTL_FLAGS = flagTable({
  longValue: [
    'namespace', 'context', 'cluster', 'user', 'kubeconfig', 'server', 'token', 'as',
    'as-group', 'as-uid', 'certificate-authority', 'client-certificate', 'client-key',
    'request-timeout', 'tls-server-name', 'cache-dir', 'v', 'vmodule', 'output',
    'selector', 'filename', 'container', 'field-selector', 'label-columns', 'sort-by',
    'kustomize', 'grace-period', 'timeout', 'replicas', 'image', 'to-revision', 'since',
    'tail', 'revision', 'subresource', 'chunk-size', 'field-manager', 'raw',
  ],
  longBool: [
    'help', 'all-namespaces', 'watch', 'watch-only', 'all', 'force', 'stdin', 'tty',
    'insecure-skip-tls-verify', 'recursive', 'overwrite', 'show-labels', 'no-headers',
    'ignore-not-found', 'follow', 'previous', 'timestamps', 'local', 'save-config',
  ],
  shortValue: ['n', 's', 'o', 'l', 'c', 'L', 'k', 'v'],
  shortBool: ['h', 'A', 'w', 'R', 'i', 't'],
});
