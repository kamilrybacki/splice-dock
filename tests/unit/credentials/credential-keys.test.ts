import { describe, it, expect } from 'vitest';
import {
  credentialCacheKey,
  credentialEntryPath,
  profileKeyPrefix,
} from '../../../src/services/secrets/keys.js';

const base = { profile: 'worker', agent: null as string | null, backend: 'vault', authenticated: true, tokenId: null };
const withAgent = (agent: string | null) => ({ ...base, agent });

describe('credential keys', () => {
  it('tell "no agent" apart from an agent literally named "_"', () => {
    expect(credentialCacheKey('p', withAgent(null))).not.toBe(credentialCacheKey('p', withAgent('_')));
    expect(credentialEntryPath('p', withAgent(null))).not.toBe(credentialEntryPath('p', withAgent('_')));
  });

  it('tell "no agent" apart from the empty agent label', () => {
    expect(credentialCacheKey('p', withAgent(null))).not.toBe(credentialCacheKey('p', withAgent('')));
  });

  it('give different agents on one profile different cache keys', () => {
    expect(credentialCacheKey('p', withAgent('builder'))).not.toBe(credentialCacheKey('p', withAgent('reviewer')));
  });

  it('keeps the profile as the prefix of every cache key', () => {
    for (const agent of [null, '_', 'builder']) {
      expect(credentialCacheKey('p', withAgent(agent)).startsWith(profileKeyPrefix('worker'))).toBe(true);
    }
    expect(credentialCacheKey('p', { ...base, profile: 'worker-2' }).startsWith(profileKeyPrefix('worker'))).toBe(false);
  });

  it('stores a missing agent under a segment no sanitized label can produce, and keeps present labels unchanged', () => {
    expect(credentialEntryPath('p', withAgent(null))).toBe('worker/vault/~/p');
    expect(credentialEntryPath('p', withAgent('_'))).toBe('worker/vault/_/p');
    expect(credentialEntryPath('p', withAgent('builder'))).toBe('worker/vault/builder/p');
    expect(credentialEntryPath('p', withAgent('~'))).toBe('worker/vault/_/p');
  });
});
