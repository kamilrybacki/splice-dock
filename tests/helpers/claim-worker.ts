// Worker thread for the approval race tests: opens its OWN store connection
// (SQLite file or Postgres DSN), waits on a start barrier, then performs one
// claim and reports the outcome. Never throws across the thread boundary.
import { parentPort, workerData } from 'node:worker_threads';
import { SplicedockStore } from '../../src/adapters/outbound/persistence/store.js';

interface Data {
  target: string;
  op: 'approve' | 'reject' | 'reserve';
  id: string;
  barrier: SharedArrayBuffer;
  reserve?: { tool: string; argv_hash: string; profile: string; token_id: string; cwd: string };
}

const d = workerData as Data;
const flag = new Int32Array(d.barrier);
try {
  const store = await SplicedockStore.open(d.target);
  parentPort!.postMessage({ type: 'ready' });
  Atomics.wait(flag, 0, 0, 30_000);
  const now = Date.now();
  let ok: boolean;
  if (d.op === 'approve') ok = await store.approveApproval(d.id, 'race', now);
  else if (d.op === 'reject') ok = await store.rejectApproval(d.id, 'race', now);
  else {
    const r = d.reserve!;
    ok = await store.reserveBoundApproval(r.tool, r.argv_hash, r.profile, r.token_id, r.cwd, now) === d.id;
  }
  await store.close();
  parentPort!.postMessage({ type: 'done', ok });
} catch (e) {
  parentPort!.postMessage({ type: 'done', ok: false, error: String((e as Error).message ?? e) });
}
