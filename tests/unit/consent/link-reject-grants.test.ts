import { builtinShapes } from '../../../src/builtin-backends.js';
import { it, expect } from 'vitest';
import Fastify from 'fastify';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ConsentStore } from '../../../src/services/approvals/consent/store.js';
import { WebAuthnConsent } from '../../../src/services/approvals/adapters/fastify/webauthn.js';
import { registerConsentRoutes } from '../../../src/services/approvals/adapters/fastify/server.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';

const caller = { profile: 'test', tokenId: 'fixture', authenticated: true };
const context = 'Clean up completed batch jobs after investigating failed scheduled runs';
const origin = 'https://consent.example.test';

it('rejecting through a consent link revokes and blocks the matching grant', async () => {
  const store = await SplicedockStore.open(':memory:');
  const svc = new ApprovalService({ store, grantsEnabled: true, sweepIntervalMs: 0, shapes: builtinShapes });
  const request = (name: string) =>
    svc.makeHook('kubectl', '/workspace', caller, false, context)({ tool: 'kubectl', argv: ['delete', 'job', name, '-n', 'batch'], rule: 'approval_subcommands', matched: 'delete' });
  const execute = async (name: string) => {
    const out = await request(name); await svc.approve(out.id!, 'operator');
    const approved = await request(name); await svc.finalize(approved.id!); await svc.executionResult(approved.id!, true);
  };
  const pending = await request('x');
  const link = await svc.consent.bind(pending.id!);
  await execute('one'); await execute('two'); await execute('three');
  expect(await svc.listGrants()).toHaveLength(1);

  const consent = new WebAuthnConsent(await ConsentStore.open(store.consentDatabase()), { enabled: true, rp_id: 'consent.example.test', origin, max_attempts: 3, rate_limit_per_minute: 50 });
  const app = Fastify();
  registerConsentRoutes(app, consent, (id, by) => svc.reject(id, by));
  const res = await app.inject({ method: 'POST', url: `/consent/${link}/reject`, headers: { origin } });
  expect(res.statusCode).toBe(200);

  const db = store.consentDatabase();
  expect(await db.prepare('SELECT COUNT(*) AS n FROM standing_grants WHERE revoked_at IS NULL').get()).toEqual({ n: 0 });
  expect((await db.prepare('SELECT COUNT(*) AS n FROM grant_blocks').get() as { n: number }).n).toBeGreaterThan(0);
  await app.close(); await store.close();
});
