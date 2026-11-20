import { describe, afterAll } from 'vitest';
import { defineRaceTests } from './approval-race.shared.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, type IsolatedSchema } from '../../helpers/pg-test.js';

const schemas: IsolatedSchema[] = [];
afterAll(async () => { await Promise.all(schemas.map((s) => s.drop())); });

// Real concurrency needs real Postgres connections. Skipped (with reason)
// unless SPLICEDOCK_TEST_PG_DSN is set; each test gets its own schema.
describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'approval claim race (Postgres)' : `approval claim race (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  defineRaceTests(async () => {
    const s = await createIsolatedSchema(TEST_PG_DSN!);
    schemas.push(s);
    return s.dsn;
  });
});
