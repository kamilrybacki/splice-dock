import { afterEach, describe, expect, it } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { StandingGrants } from '../../../src/services/approvals/standing-grants.js';
import { kubectlShape } from '../../../src/services/policy/shape/kubectl.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, type IsolatedSchema } from '../../helpers/pg-test.js';

const stores: SplicedockStore[] = [];
const schemas: IsolatedSchema[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const s of schemas.splice(0)) await s.drop();
});
for (const backend of ['sqlite', 'postgres']) {
  describe.skipIf(backend === 'postgres' && !TEST_PG_DSN)(`grant history (${backend}) ${backend === 'postgres' && !TEST_PG_DSN ? PG_SKIP_REASON : ''}`, () => {
    it.each(['active', 'revoked', 'suspended'])('retains older %s identity history beyond 500 global grants', async (state) => {
      const schema = backend === 'postgres' ? await createIsolatedSchema(TEST_PG_DSN!) : undefined;
      if (schema) schemas.push(schema);
      const store = await SplicedockStore.open(schema?.dsn ?? ':memory:'); stores.push(store);
      const db = store.consentDatabase();
      const now = 1000000;
      const shape = kubectlShape(['delete', 'job', 'x', '-n', 'batch'], 'delete', { profile: 'p', tokenId: 't', authenticated: true })!;
      await store.insertApproval({ id: 'evidence', tool: 'kubectl', argv_hash: 'x', argv_json: '[]', rule: 'approval_subcommands', matched: 'delete', requested_at: 1, expires_at: now + 10000, profile: 'p', token_id: 't', cwd: '/workspace' });
      await db.prepare("UPDATE pending_approvals SET status='consumed',execution_success=1,consumed_at=?,shape_key=?,approval_context=? WHERE id='evidence'").run(now - 10, JSON.stringify(shape), 'clean completed batch jobs');
      await db.transaction(async () => {
        for (let i = 0; i < 502; i++) {
          await db.prepare('INSERT INTO standing_grants(id,profile,token_id,tool,verb_path,resource_kind,namespace,flags_allowed,created_at,created_by,context_refs,expires_at,revoked_at,suspended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(String(i), i === 0 ? 'p' : `other${i}`, 't', 'kubectl', 'delete', shape.resource_kind, shape.namespace, '[]', i, 'test', '[]', now + 10000, i === 0 && state === 'revoked' ? now : null, i === 0 && state === 'suspended' ? now : null);
        }
      })();
      const grants = new StandingGrants(db, true, 1, 0, () => now);
      await db.transaction(async () => { await grants.promote('evidence'); })();
      expect(await db.prepare("SELECT id FROM standing_grants WHERE profile='p' AND token_id='t'").all()).toHaveLength(1);
    });
  });
}
