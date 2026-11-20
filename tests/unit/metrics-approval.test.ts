import { describe, it, expect } from 'vitest';
import { createMetrics } from '../../src/common/metrics.js';

describe('approval/policy metrics', () => {
  it('registers counters with the specified labels', async () => {
    const m = createMetrics();
    m.policyDecisions.inc({ tool: 't', profile: 'p', decision: 'deny', rule: 'deny_args' });
    m.approvals.inc({ tool: 't', event: 'consumed' });
    const out = await m.registry.metrics();
    expect(out).toMatch(/splicedock_policy_decisions_total\{[^}]*tool="t"[^}]*profile="p"[^}]*decision="deny"[^}]*rule="deny_args"/);
    expect(out).toMatch(/splicedock_approvals_total\{[^}]*tool="t"[^}]*event="consumed"/);
  });
});
