import { describe, it, expect } from 'vitest';
import { createPrometheusMetrics } from '../../src/services/metrics/adapters/prometheus/index.js';

describe('approval/policy metrics', () => {
  it('registers counters with the specified labels', async () => {
    const m = createPrometheusMetrics();
    m.policyDecisions.inc({ tool: 't', profile: 'p', decision: 'deny', rule: 'deny_args' });
    m.approvals.inc({ tool: 't', event: 'consumed' });
    const out = await m.registry.metrics();
    expect(out).toMatch(/splicedock_policy_decisions_total\{[^}]*tool="t"[^}]*profile="p"[^}]*decision="deny"[^}]*rule="deny_args"/);
    expect(out).toMatch(/splicedock_approvals_total\{[^}]*tool="t"[^}]*event="consumed"/);
  });
});
