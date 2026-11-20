import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';

describe('SplicedockStore profile_tokens', () => {
  let store: SplicedockStore;

  beforeEach(async () => { store = await SplicedockStore.open(':memory:'); });
  afterEach(async () => { await store.close(); });

  it('starts empty', async () => {
    expect(await store.listProfileTokens()).toEqual([]);
  });

  it('inserts a token and finds the profile by hash, stamping last_used_at', async () => {
    await store.insertProfileToken('id1', 'ops', 'hash-abc');
    const found = await store.findProfileByToken('hash-abc', 1_000);
    expect(found).toEqual({ id: 'id1', profile: 'ops', agent: null });
    const rows = await store.listProfileTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('id1');
    expect(rows[0].profile).toBe('ops');
    expect(rows[0].last_used_at).toBe(1_000);
    // The hash is never exposed in the listing.
    expect(rows[0]).not.toHaveProperty('token_hash');
  });

  it('returns null for an unknown hash', async () => {
    expect(await store.findProfileByToken('nope', 1)).toBeNull();
  });

  it('deletes a token and reports whether a row was removed', async () => {
    await store.insertProfileToken('id1', 'ops', 'hash-abc');
    expect(await store.deleteProfileToken('id1')).toBe(true);
    expect(await store.listProfileTokens()).toHaveLength(1);
    expect(await store.deleteProfileToken('id1')).toBe(false);
    // After deletion the hash no longer resolves.
    expect(await store.findProfileByToken('hash-abc', 2)).toBeNull();
  });
});
