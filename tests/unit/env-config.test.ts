import { describe, it, expect } from 'vitest';
import { approvalTtlMsFromEnv, grantsEnabledFromEnv, shadowKillSwitchFromEnv } from '../../src/env-config.js';

describe('env to config mapping', () => {
  it('APPROVAL_TTL_SEC: positive integers become ms, everything else defers to config', () => {
    expect(approvalTtlMsFromEnv({ APPROVAL_TTL_SEC: '30' })).toBe(30_000);
    expect(approvalTtlMsFromEnv({ APPROVAL_TTL_SEC: '12abc' })).toBe(12_000);
    for (const raw of [undefined, '', '0', '-5', 'abc']) {
      expect(approvalTtlMsFromEnv({ APPROVAL_TTL_SEC: raw })).toBeUndefined();
    }
  });

  it('SPLICEDOCK_GRANTS is on only for exactly "1"', () => {
    expect(grantsEnabledFromEnv({ SPLICEDOCK_GRANTS: '1' })).toBe(true);
    expect(grantsEnabledFromEnv({ SPLICEDOCK_GRANTS: 'true' })).toBe(false);
    expect(grantsEnabledFromEnv({})).toBe(false);
  });

  it('SPLICEDOCK_SHADOW kill switch is on only for exactly "off"', () => {
    expect(shadowKillSwitchFromEnv({ SPLICEDOCK_SHADOW: 'off' })).toBe(true);
    expect(shadowKillSwitchFromEnv({ SPLICEDOCK_SHADOW: 'on' })).toBe(false);
    expect(shadowKillSwitchFromEnv({})).toBe(false);
  });
});
