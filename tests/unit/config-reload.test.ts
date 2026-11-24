import { describe, it, expect, vi } from 'vitest';
import { createConfigReloader } from '../../src/services/admin/config-reload.js';
import type { SplicedockConfig } from '../../src/config/types.js';

const next = {
  server: {
    breaker: { enabled: true, mode: 'enforce' },
    shadow: { enabled: false },
    consent: { strong_default_tools: ['a__b'] },
  },
} as unknown as SplicedockConfig;

function setup(load: () => SplicedockConfig) {
  const calls: string[] = [];
  const targets = {
    breaker: { reconfigure: vi.fn(async () => { calls.push('breaker'); }) },
    shadow: { reconfigure: vi.fn(() => { calls.push('shadow'); }) },
    approvals: { reconfigureStrongTools: vi.fn(() => { calls.push('approvals'); }) },
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  return { calls, targets, log, reloader: createConfigReloader(load, targets, log) };
}

describe('config reloader', () => {
  it('applies breaker, shadow and strong tools from the freshly loaded config', async () => {
    const { calls, targets, log, reloader } = setup(() => next);
    await reloader.reload();
    expect(calls).toEqual(['breaker', 'shadow', 'approvals']);
    expect(targets.breaker.reconfigure).toHaveBeenCalledWith(next.server.breaker);
    expect(targets.shadow.reconfigure).toHaveBeenCalledWith(next.server.shadow);
    expect(targets.approvals.reconfigureStrongTools).toHaveBeenCalledWith(['a__b']);
    expect(log.info).toHaveBeenCalledWith('breaker/shadow configuration reloaded');
  });

  it('refuses without touching any service when the config does not load', async () => {
    const { calls, log, reloader } = setup(() => { throw new Error('bad yaml'); });
    await reloader.reload();
    expect(calls).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('breaker/shadow reload refused', { error: 'bad yaml' });
  });
});
