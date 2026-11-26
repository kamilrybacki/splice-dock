// Everything that brings a SQLite file to the current schema. The order is
// the historical order of SplicedockStore.open; each migration keeps its own
// transaction semantics. Postgres uses postgres/schema.ts instead.
import type { SqlDb } from '../../../base.js';
import { migrateStandingGrants } from '../../migrations/grants/standing.js';
import { migratePushSubscriptions } from '../../migrations/push/subscriptions.js';
import { migrateProfileCatalog } from '../../migrations/profiles/catalog.js';
import { migrateProfileTokenLifecycle } from '../../migrations/profiles/tokens/lifecycle.js';
import { migrateProfileTokenAgent } from '../../migrations/profiles/tokens/agent.js';
import { SCHEMA, migrateApprovalBinding, migrateMetricsHourlyAnchor, migrateMetricsMinuteAnchor } from './core.js';
import { migrateApprovalConsent } from './consent.js';
import { migrateApprovalBroker } from './broker.js';
import { migrateBreakerState } from './breaker.js';
import { migrateShadowLog } from './shadow.js';

export async function migrateSqlite(db: SqlDb): Promise<void> {
  await db.exec(SCHEMA);
  await migrateApprovalBinding(db);
  await migrateMetricsHourlyAnchor(db);
  await migrateMetricsMinuteAnchor(db);
  await migrateProfileTokenLifecycle(db);
  await migrateProfileTokenAgent(db);
  await migrateApprovalConsent(db);
  await migrateApprovalBroker(db);
  await migrateStandingGrants(db);
  await migratePushSubscriptions(db);
  await migrateProfileCatalog(db);
  await migrateBreakerState(db);
  await migrateShadowLog(db);
}
