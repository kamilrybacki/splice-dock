import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { CircuitBreaker } from '../../src/services/policy/breaker/index.js';
import { builtinReadonlyProbes } from '../../src/builtin-backends.js';
import { NO_READONLY_PROBES } from '../../src/services/policy/breaker/readonly.js';
import { sqliteDb } from '../helpers/sqlite.js';

const base = { enabled: true, mode: 'enforce' as const, window_seconds: 60, deny_threshold: 10, cooldown_seconds: 1800, half_open_probes: 3, scopes: ['token'] };
const open = (read_allowlist: { tool: string; argv: string[] }[], probes = builtinReadonlyProbes) =>
  CircuitBreaker.create(sqliteDb(new Database(':memory:')), { ...base, read_allowlist }, () => {}, probes);

describe('breaker read_allowlist validation (injected probes)', () => {
  it.each([
    ['gh', ['repo', 'archive', 'owner/repo', '--yes']],
    ['gh', ['repo', 'view', '--web']], ['gh', ['api', '/repos']], ['unknown', ['get']],
  ])('rejects unsafe breaker exemption %s %j', async (tool, argv) => {
    await expect(open([{ tool, argv }])).rejects.toThrow('unsupported breaker read exemption');
  });

  it('accepts a closed readonly exemption', async () => {
    await expect(open([{ tool: 'gh', argv: ['repo', 'view'] }])).resolves.toBeDefined();
  });

  it('rejects everything when no probes are injected', async () => {
    await expect(open([{ tool: 'gh', argv: ['repo', 'view'] }], NO_READONLY_PROBES)).rejects.toThrow('unsupported breaker read exemption');
  });

  it('refuses an unsupported exemption on reconfigure and leaves the config unchanged', async () => {
    const b = await open([]);
    await expect(b.reconfigure({ ...base, read_allowlist: [{ tool: 'gh', argv: ['api', '/repos'] }] })).rejects.toThrow('unsupported breaker read exemption');
    expect(b.config.read_allowlist).toEqual([]);
  });
});
