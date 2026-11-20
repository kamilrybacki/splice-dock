import { expect, it } from 'vitest';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
import { raceClaims } from '../../helpers/race.js';

const N = 8;
const future = () => Date.now() + 600_000;

async function seed(target: string, id: string, approve: boolean): Promise<void> {
  const s = await SplicedockStore.open(target);
  await s.insertApproval({
    id, tool: 'kubectl', argv_hash: 'h-' + id, argv_json: '["get","pods"]', rule: 'r', matched: null,
    requested_at: Date.now(), expires_at: future(), profile: 'p', token_id: 't', cwd: '/tmp',
  });
  if (approve) expect(await s.approveApproval(id, 'seed', Date.now())).toBe(true);
  await s.close();
}

/** Shared race scenarios; `target` yields a fresh isolated store location. */
export function defineRaceTests(newTarget: () => string | Promise<string>): void {
  it(`approve x${N} on one pending row: exactly one wins`, async () => {
    const target = await newTarget();
    await seed(target, 'a1', false);
    const res = await raceClaims(Array.from({ length: N }, () => ({ target, op: 'approve' as const, id: 'a1' })));
    expect(res.filter((r) => r.error)).toEqual([]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.filter((r) => !r.ok)).toHaveLength(N - 1);
  }, 60_000);

  it('approve vs reject on one pending row: exactly one wins', async () => {
    const target = await newTarget();
    await seed(target, 'a2', false);
    const specs = Array.from({ length: N }, (_, i) => ({ target, op: (i % 2 ? 'reject' : 'approve') as 'approve' | 'reject', id: 'a2' }));
    const res = await raceClaims(specs);
    expect(res.filter((r) => r.error)).toEqual([]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    const s = await SplicedockStore.open(target);
    expect(['approved', 'rejected']).toContain((await s.getApproval('a2'))!.status);
    await s.close();
  }, 60_000);

  it(`reserve x${N} on one approved row: exactly one reservation`, async () => {
    const target = await newTarget();
    await seed(target, 'a3', true);
    const reserve = { tool: 'kubectl', argv_hash: 'h-a3', profile: 'p', token_id: 't', cwd: '/tmp' };
    const res = await raceClaims(Array.from({ length: N }, () => ({ target, op: 'reserve' as const, id: 'a3', reserve })));
    expect(res.filter((r) => r.error)).toEqual([]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    const s = await SplicedockStore.open(target);
    expect((await s.getApproval('a3'))!.status).toBe('reserved');
    await s.close();
  }, 60_000);
}
