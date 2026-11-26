import { describe, it, expect } from 'vitest';
import { builtinShapes } from '../../../src/builtin-backends.js';
import { grantNamePrefix } from '../../../src/services/approvals/grants/name-prefix.js';
import { kubectlObjectNames } from '../../../src/services/policy/shape/kubectl.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';

const caller = { profile: 'test', tokenId: 'fixture', authenticated: true };
const context = 'Clean up completed batch jobs after investigating failed scheduled runs';

describe('grantNamePrefix (ADR 0010)', () => {
  it.each([
    [['backup-29384701', 'backup-29384702', 'backup-29384703'], 'backup-'],
    [['job-nightly-1', 'job-nightly-2'], 'job-nightly-'],
    [['job-nightly-1', 'job-other'], 'job-'],
    [['app.v1.run1', 'app.v1.run2'], 'app.v1.'],
    [['job-one'], 'job-'],
    [['job-a', 'job-a'], 'job-'],
  ])('%j -> %s', (names, expected) => { expect(grantNamePrefix(names)).toBe(expected); });
  it.each([
    [[]], [['alpha', 'alphb']], [['ab-1', 'ab-2']], [['-x', '-y']], [['job', 'job']],
    [['abc', 'xyz']], [['a-b-1', 'c-d-2']], [['ab.1', 'ab.2']],
  ])('creates no prefix for %j', names => { expect(grantNamePrefix(names)).toBeNull(); });
  it('cuts at a separator, never inside a segment', () => { expect(grantNamePrefix(['job-nightly1', 'job-nightly2'])).toBe('job-'); });
});

describe('kubectlObjectNames', () => {
  it('returns bare names across forms and null when the command is not strictly parseable', () => {
    expect(kubectlObjectNames(['delete', 'job', 'a-1', 'a-2', '-n', 'batch'], 'delete')).toEqual(['a-1', 'a-2']);
    expect(kubectlObjectNames(['delete', 'job/a-1', 'jobs/a-2', '-n', 'batch'], 'delete')).toEqual(['a-1', 'a-2']);
    expect(kubectlObjectNames(['delete', 'job', 'a-1', '--all', '-n', 'batch'], 'delete')).toBeNull();
    expect(kubectlObjectNames([], 'delete')).toBeNull();
    expect(kubectlObjectNames(['-n', 'batch', 'delete', 'job', 'a-1'], 'delete')).toEqual(['a-1']);
    expect(kubectlObjectNames(['delete', 'job', 'a-1'], 'get')).toBeNull();
  });
});

async function setup(namespaces?: readonly string[], store?: SplicedockStore) {
  const st = store ?? await SplicedockStore.open(':memory:');
  const mk = (ns: readonly string[] | undefined) => new ApprovalService({ store: st, grantsEnabled: true, grantNamespaces: ns, sweepIntervalMs: 0, shapes: builtinShapes, now: () => 1000000 });
  const svc = mk(namespaces);
  const req = (s: ApprovalService, names: string[], ns = 'batch') =>
    s.makeHook('kubectl', '/workspace', caller, false, context)({ tool: 'kubectl', argv: ['delete', 'job', ...names, '-n', ns], rule: 'approval_subcommands', matched: 'delete' });
  const execute = async (names: string[], ns = 'batch', s = svc) => {
    const out = await req(s, names, ns); await s.approve(out.id!, 'operator');
    const ok = await req(s, names, ns); expect(ok.approved).toBe(true);
    await s.finalize(ok.id!); await s.executionResult(ok.id!, true);
  };
  const learn = async (names: string[][], ns = 'batch') => { for (const n of names) await execute(n, ns); };
  return { store: st, svc, mk, req, execute, learn };
}
const nightly = [['job-nightly-1'], ['job-nightly-2'], ['job-nightly-3']];

describe('name prefix at promotion and match', () => {
  it('stores the common prefix and shows it in the grant row', async () => {
    const { store, svc, learn } = await setup(['batch']);
    await learn(nightly);
    const [g] = await svc.listGrants();
    expect(g.name_prefix).toBe('job-nightly-');
    await store.close();
  });
  it('mixed names shorten the prefix to the shared whole segment', async () => {
    const { store, svc, learn } = await setup(['batch']);
    await learn([['job-aa-1'], ['job-bb-2'], ['job-cc-3']]);
    expect((await svc.listGrants())[0].name_prefix).toBe('job-');
    await store.close();
  });
  it('multiple objects in one approval all contribute', async () => {
    const { store, svc, req, learn } = await setup(['batch']);
    await learn([['job-nightly-1', 'job-nightly-2'], ['job-nightly-3'], ['job-nightly-4', 'job-nightly-5']]);
    expect((await svc.listGrants())[0].name_prefix).toBe('job-nightly-');
    expect((await req(svc, ['job-nightly-6', 'other-thing'])).approved).toBe(false);
    expect((await req(svc, ['job-nightly-6', 'job-nightly-7'])).approved).toBe(true);
    await store.close();
  });
  it.each([
    ['no separator', [['alpha1'], ['alpha2'], ['alpha3']]],
    ['too short', [['ab-1'], ['ab-2'], ['ab-3']]],
    ['no common prefix', [['job-a'], ['pod-b'], ['run-c']]],
  ])('forms no grant: %s', async (_n, names) => {
    const { store, svc, learn } = await setup(['batch']);
    await learn(names);
    expect(await svc.listGrants()).toHaveLength(0);
    await store.close();
  });
  it('a request outside the prefix goes to a human', async () => {
    const { store, svc, req, learn } = await setup(['batch']);
    await learn(nightly);
    expect((await req(svc, ['job-nightly-9'])).approved).toBe(true);
    for (const bad of ['job-other', 'prod-db-migrate', 'job-nightly', 'JOB-nightly-1', 'x-job-nightly-1']) {
      const out = await req(svc, [bad]);
      expect(out.approved).toBe(false);
      expect((await svc.get(out.id!))?.status).toBe('pending');
    }
    await store.close();
  });
  it('a NULL prefix (legacy grant) never matches', async () => {
    const { store, svc, req, learn } = await setup(['batch']);
    await learn(nightly);
    await store.consentDatabase().prepare('UPDATE standing_grants SET name_prefix=NULL').run();
    expect((await req(svc, ['job-nightly-9'])).approved).toBe(false);
    await store.close();
  });
  it('the claim path cannot bypass a NULL prefix or the allowlist', async () => {
    const { store, svc, learn, mk } = await setup(['batch']);
    await learn(nightly);
    const [g] = await svc.listGrants();
    expect(await mk([]).grants.claim(g.id)).toBe(false);
    await store.consentDatabase().prepare('UPDATE standing_grants SET name_prefix=NULL').run();
    expect(await svc.grants.claim(g.id)).toBe(false);
    await store.close();
  });
});

describe('namespace allowlist', () => {
  it.each([undefined, [], ['other']] as const)('default-deny: allowlist %j forms no grant', async ns => {
    const { store, svc, learn } = await setup(ns);
    await learn(nightly);
    expect(await svc.listGrants()).toHaveLength(0);
    await store.close();
  });
  it('promotion and match are bound to the listed namespace only', async () => {
    const { store, svc, req, learn } = await setup(['batch']);
    await learn(nightly, 'other');
    expect(await svc.listGrants()).toHaveLength(0);
    await learn(nightly);
    expect(await svc.listGrants()).toHaveLength(1);
    expect((await req(svc, ['job-nightly-9'], 'other')).approved).toBe(false);
    expect((await req(svc, ['job-nightly-9'])).approved).toBe(true);
    await store.close();
  });
  it('a namespace removed from the list stops matching, and re-adding restores it', async () => {
    const { store, svc, req, learn, mk } = await setup(['batch']);
    await learn(nightly);
    expect((await req(svc, ['job-nightly-8'])).approved).toBe(true);
    expect((await req(mk([]), ['job-nightly-9'])).approved).toBe(false);
    expect((await req(mk(['other']), ['job-nightly-9'])).approved).toBe(false);
    expect((await req(mk(['batch']), ['job-nightly-9'])).approved).toBe(true);
    await store.close();
  });
});
