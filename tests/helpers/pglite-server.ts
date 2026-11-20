import { spawn } from 'node:child_process';

/**
 * In-process-free Postgres (PGlite behind a TCP socket, in a child process)
 * for FUNCTIONAL parity tests only. pglite-socket accepts ONE connection at a
 * time by default (net.Server.maxConnections=1, so Node resets any second
 * socket with ECONNRESET) and serves all clients from one backend, so while the
 * server runs every PgDb pool in this worker is pinned to one connection via
 * SPLICEDOCK_DB_POOL_MAX; the server only gets headroom for reopen overlap. It is not real
 * concurrency; race tests use SPLICEDOCK_TEST_PG_DSN instead.
 */
export async function startPglite(): Promise<{ dsn: string; stop(): Promise<void> }> {
  const child = spawn(process.execPath, [new URL('./pglite-server.mjs', import.meta.url).pathname], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const prevPoolMax = process.env['SPLICEDOCK_DB_POOL_MAX'];
  process.env['SPLICEDOCK_DB_POOL_MAX'] = '1';
  const restorePoolMax = (): void => {
    if (prevPoolMax === undefined) delete process.env['SPLICEDOCK_DB_POOL_MAX'];
    else process.env['SPLICEDOCK_DB_POOL_MAX'] = prevPoolMax;
  };
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      const m = /PORT=(\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`pglite server exited early (${code})`)));
  });
  return {
    dsn: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      restorePoolMax();
      return new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
    },
  };
}
