import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';

describe('ProfileRegistry', () => {
  let registry: ProfileRegistry;

  beforeEach(() => { registry = new ProfileRegistry(); });

  it('adds and retrieves a file profile', () => {
    registry.addFileProfile('dev', { tools: ['tool-a', 'tool-b'] });
    const profile = registry.getProfile('dev');
    expect(profile).toBeDefined();
    expect(profile?.tools).toEqual(['tool-a', 'tool-b']);
    expect(profile?.source).toBe('file');
  });

  it('adds and retrieves a runtime profile', () => {
    registry.addRuntimeProfile('staging', { tools: ['tool-c'] });
    const profile = registry.getProfile('staging');
    expect(profile).toBeDefined();
    expect(profile?.tools).toEqual(['tool-c']);
    expect(profile?.source).toBe('runtime');
  });

  it('getAllProfiles returns all file and runtime profiles', () => {
    registry.addFileProfile('p1', { tools: ['a'] });
    registry.addFileProfile('p2', { tools: ['b'] });
    registry.addRuntimeProfile('p3', { tools: ['c'] });
    const all = registry.getAllProfiles();
    expect(all).toHaveLength(3);
    expect(all.map(p => p.name)).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });

  it('runtime profile overrides file profile with same name', () => {
    registry.addFileProfile('shared', { tools: ['file-tool'] });
    registry.addRuntimeProfile('shared', { tools: ['runtime-tool'] });
    const profile = registry.getProfile('shared');
    expect(profile?.source).toBe('runtime');
    expect(profile?.tools).toEqual(['runtime-tool']);
    expect(registry.getAllProfiles()).toHaveLength(1);
  });

  it('removeProfile removes a runtime profile and returns true', () => {
    registry.addRuntimeProfile('rt-profile', { tools: ['t'] });
    expect(registry.removeProfile('rt-profile')).toBe(true);
    expect(registry.getProfile('rt-profile')).toBeUndefined();
  });

  it('removeProfile removes a catalog profile originally seeded from file', () => {
    registry.addFileProfile('file-profile', { tools: ['t'] });
    expect(registry.removeProfile('file-profile')).toBe(true);
    expect(registry.getProfile('file-profile')).toBeUndefined();
  });
});
