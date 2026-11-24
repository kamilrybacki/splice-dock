import { migrateSqliteToPostgres, MigrationError, redact } from '../migrate-sqlite-to-pg.js';

const USAGE = 'usage: db migrate-sqlite-to-pg --sqlite <path> [--force]   (target DSN from SPLICEDOCK_DB_DSN)';

/** Handles `db <subcommand>`; returns the process exit code. */
export async function runDbCli(argv: readonly string[], env: Record<string, string | undefined>, out: (s: string) => void = s => process.stdout.write(`${s}\n`)): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'migrate-sqlite-to-pg') { out(USAGE); return 2; }
  let sqlitePath: string | undefined;
  let force = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') force = true;
    else if (a === '--sqlite') sqlitePath = rest[++i];
    else { out(`unknown argument: ${a}\n${USAGE}`); return 2; }
  }
  const dsn = env['SPLICEDOCK_DB_DSN'];
  if (!sqlitePath || !dsn) { out(`--sqlite and SPLICEDOCK_DB_DSN are required\n${USAGE}`); return 2; }
  try {
    const report = await migrateSqliteToPostgres({ sqlitePath, dsn, force });
    for (const t of report.tables) out(`${t.table}: ${t.rows}`);
    out(`migrated ${report.totalRows} rows across ${report.tables.length} tables; counts verified`);
    return 0;
  } catch (err) {
    // Only our own MigrationError messages (names, counts, SQLSTATE) are printed.
    // Raw driver messages can quote row contents, so they are reduced to a code.
    if (err instanceof MigrationError) {
      out(`migration failed, no data was committed: ${redact(err.message, dsn)}`);
      return 1;
    }
    const code = (err as { code?: unknown })?.code;
    const safeCode = typeof code === 'string' && /^[0-9A-Z_]{1,32}$/.test(code) ? code : 'unknown';
    const name = err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
    out(`migration failed, no data was committed: ${name} (code ${safeCode})`);
    return 3;
  }
}
