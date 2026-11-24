import type { SqlDb } from '../../contracts/outbound/sql/database.js';

export type { SqlDb, SqlNamedParams, SqlParam, SqlRunResult, SqlStatement, SqlTransaction } from '../../contracts/outbound/sql/database.js';

export function isPostgres(db: SqlDb): boolean {
  return db.dialect === 'postgres';
}

export function isPostgresDsn(target: string): boolean {
  return /^postgres(ql)?:\/\//i.test(target);
}

/**
 * Pick the storage target from env. A set-but-malformed SPLICEDOCK_DB_DSN is a
 * hard error (never silently treated as a SQLite path, which would also log
 * the value); the message deliberately does not echo it.
 */
export function resolveDbTarget(env: Record<string, string | undefined>): string {
  const dsn = env['SPLICEDOCK_DB_DSN'];
  if (dsn !== undefined) {
    // An explicitly empty DSN is a misconfiguration (e.g. a missing secret
    // key), not a request for SQLite: fail instead of silently diverging.
    if (dsn.trim() === '') throw new Error('SPLICEDOCK_DB_DSN is set but empty');
    if (!isPostgresDsn(dsn)) {
      throw new Error('SPLICEDOCK_DB_DSN must be a postgres:// or postgresql:// URL');
    }
    return dsn;
  }
  // Multi-replica deployments set this so a pod with a missing DSN fails
  // instead of quietly opening its own private SQLite file.
  if (env['SPLICEDOCK_REQUIRE_POSTGRES'] === '1') {
    throw new Error('SPLICEDOCK_REQUIRE_POSTGRES=1 but SPLICEDOCK_DB_DSN is not set');
  }
  return env['SPLICEDOCK_DB_PATH'] ?? '/var/splicedock/data/splicedock.db';
}
