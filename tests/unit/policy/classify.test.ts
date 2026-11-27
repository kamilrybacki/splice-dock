import { describe, expect, it } from 'vitest';

import { classifyOperation } from '../../../src/services/policy/classify/index.js';

const c = (tool: string, ...argv: string[]) => classifyOperation(tool, argv);

describe('classifyOperation', () => {
  it('reads context from the object kind, not only the verb', () => {
    expect(c('kubectl', 'delete', 'pod', 'worker-1', '-n', 'batch').class).toBe('disruptive');
    expect(c('kubectl', 'delete', 'secret', 'db-cred', '-n', 'batch').class).toBe('destructive');
    expect(c('kubectl', 'delete', 'pvc', 'scratch').class).toBe('destructive');
  });

  it('flags only raise, never lower', () => {
    expect(c('kubectl', 'delete', 'pod', 'x', '--force').class).toBe('destructive');
    expect(c('kubectl', 'delete', 'pod', 'x', '--grace-period', '0').class).toBe('destructive');
    expect(c('kubectl', 'delete', 'pod', 'x', '--grace-period=0').class).toBe('destructive');
    expect(c('kubectl', 'delete', 'pod', 'x', '-A').class).toBe('destructive');
    expect(c('kubectl', 'get', 'pods', '--dry-run').class).toBe('benign');
  });

  it('the grace-period value is not mistaken for a kind or name', () => {
    expect(c('kubectl', 'delete', '--grace-period', '0', 'pod', 'x').key).toBe('kubectl|delete|pod');
  });

  it('picks the longest verb path', () => {
    expect(c('kubectl', 'rollout', 'restart', 'deployment/api').class).toBe('disruptive');
    expect(c('kubectl', 'rollout', 'pause', 'deployment/api').class).toBe('unknown');
  });

  it('raises HTTP DELETE through gh', () => {
    expect(c('gh', 'pr', 'close', '12').class).toBe('disruptive');
    expect(c('gh', 'pr', 'merge', '12', '--delete-branch').class).toBe('destructive');
    expect(c('gh', 'release', 'delete', 'v1').class).toBe('destructive');
  });

  it('abstains on anything not in the table', () => {
    expect(c('terraform', 'apply').class).toBe('unknown');
    expect(c('kubectl', 'cp', 'a', 'b').class).toBe('unknown');
    expect(c('kubectl', 'get', 'pods', '--weird').class).toBe('unknown');
    expect(c('kubectl').class).toBe('unknown');
    expect(c('constructor', 'get').class).toBe('unknown');
  });

  it('returns a typed key usable for review queues', () => {
    expect(c('kubectl', 'delete', 'configmap', 'x').key).toBe('kubectl|delete|configmap');
    expect(c('kubectl', 'delete', 'configmap', 'x').class).toBe('destructive');
    expect(c('kubectl', 'delete', 'job', 'nightly-1').class).toBe('disruptive');
  });
});

describe('classifyOperation: extended tables', () => {
  it('keeps benign reads benign and mutations above them', () => {
    expect(c('kubectl', 'rollout', 'status', 'deployment/api').class).toBe('benign');
    expect(c('argocd', 'app', 'sync', 'x').class).toBe('disruptive');
    expect(c('argocd', 'app', 'sync', 'x', '--prune').class).toBe('destructive');
    expect(c('helm', 'uninstall', 'x').class).toBe('destructive');
    expect(c('docker', 'system', 'prune', '--volumes').class).toBe('destructive');
    expect(c('git', 'push', '--force').class).toBe('destructive');
    expect(c('vault', 'kv', 'get', 'secret/x').class).toBe('benign');
  });

  it('abstains on exec and unlisted verbs of new tools', () => {
    expect(c('kubectl', 'exec', 'pod', '--', 'sh').class).toBe('unknown');
    expect(c('helm', 'repo', 'add').class).toBe('unknown');
  });
});

import { classifierDeniesGrant } from '../../../src/services/approvals/grants/standing.js';

describe('classifierDeniesGrant (deny-only)', () => {
  const shape = (tool: string, verb_path: string, resource_kind: string) => ({ tool, verb_path, resource_kind });
  it('lets the grantable pairs through', () => {
    expect(classifierDeniesGrant(shape('kubectl', 'delete', 'pod'))).toBe(false);
    expect(classifierDeniesGrant(shape('kubectl', 'delete', 'job'))).toBe(false);
  });
  it('denies destructive and unclassifiable shapes', () => {
    expect(classifierDeniesGrant(shape('kubectl', 'delete', 'namespace'))).toBe(true);
    expect(classifierDeniesGrant(shape('terraform', 'apply', 'x'))).toBe(true);
  });
});
