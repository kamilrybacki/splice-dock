import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
let store: SplicedockStore;
beforeEach(async () => { vi.useFakeTimers(); vi.setSystemTime(100000); store = await SplicedockStore.open(':memory:'); });
afterEach(async () => { await store.close(); vi.useRealTimers(); });
it('rejects expiration at the exact boundary without touching usage', async () => {
  await store.insertProfileToken('one', 'ops', 'hash');
  expect(await store.findProfileByToken('hash', 100000 + 30 * 86400000)).toBeNull();
  expect((await store.listProfileTokens())[0].last_used_at).toBeNull();
});
it('retains revoked rows for audit while refusing authentication', async () => {
  await store.insertProfileToken('one', 'ops', 'hash');
  expect(await store.deleteProfileToken('one')).toBe(true);
  expect(await store.findProfileByToken('hash', 100001)).toBeNull();
  expect(await store.listProfileTokens()).toHaveLength(1);
  expect(await store.deleteProfileToken('one')).toBe(false);
});
it('throttles last-used writes to one per minute', async () => {
  await store.insertProfileToken('one', 'ops', 'hash');
  await store.findProfileByToken('hash', 100000);
  await store.findProfileByToken('hash', 100001);
  expect((await store.listProfileTokens())[0].last_used_at).toBe(100000);
});

it('observes inactivity without revoking and enforces only when requested', async () => {
  await store.insertProfileToken('one', 'ops', 'hash');
  const now = 100000 + 31 * 86400000;
  expect(await store.sweepInactiveTokens(now, 'observe')).toEqual({ revoked: 0, wouldRevoke: 1 });
  expect(await store.sweepInactiveTokens(now, 'enforce')).toEqual({ revoked: 1, wouldRevoke: 0 });
  expect((await store.listProfileTokens())[0].revoked_reason).toBe('inactive');
});
it('rotation revokes the predecessor atomically and refuses repeated rotation', async () => {
  await store.insertProfileToken('one', 'ops', 'hash');
  expect(await store.rotateProfileToken('one', 'two', 'newhash')).toBe(true);
  expect(await store.findProfileByToken('hash', 100001)).toBeNull();
  expect((await store.findProfileByToken('newhash', 100001))?.id).toBe('two');
  expect(await store.rotateProfileToken('one', 'three', 'otherhash')).toBe(false);
  expect((await store.listProfileTokens())[1].rotated_from).toBe('one');
});
it('rolls back predecessor revocation if successor insertion fails', async () => {
  await store.insertProfileToken('one', 'ops', 'hash');
  await store.insertProfileToken('collision', 'ops', 'taken');
  await expect(async () => await store.rotateProfileToken('one', 'new', 'taken')).rejects.toThrow();
  expect((await store.findProfileByToken('hash', 100001))?.id).toBe('one');
  expect((await store.listProfileTokens()).find(t => t.id === 'one')?.revoked_at).toBeNull();
});
it('stores admin identity and rejects expiry rotation', async () => {
  await store.insertProfileToken('one', 'ops', 'hash', 1, 'operator');
  vi.setSystemTime(101000);
  expect(await store.rotateProfileToken('one', 'new', 'newhash')).toBe(false);
  expect((await store.listProfileTokens())[0].created_by).toBe('operator');
});
