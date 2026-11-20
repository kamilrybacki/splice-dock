/* eslint-disable no-undef, no-console */
// Runs PGlite behind a TCP socket in its OWN process, so the server never
// shares an event loop with the code under test.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
const db = await PGlite.create();
// Headroom for a store that reopens before the server has seen its previous
// socket close. Clients still never overlap work: each PgDb pool is pinned to
// one connection (see pglite-server.ts) and the suites open one store at a time.
const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 4 });
await server.start();
const port = server.server?.address?.().port;
console.log('PORT=' + port);
process.on('SIGTERM', async () => { await server.stop(); await db.close(); process.exit(0); });
