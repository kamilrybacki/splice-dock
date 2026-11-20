import { Worker } from 'node:worker_threads';

export interface ClaimResult { ok: boolean; error?: string }

const WORKER = new URL('./claim-worker.ts', import.meta.url);

/** Spawn one worker per spec, release them together, collect the outcomes. */
export async function raceClaims(
  specs: Array<{ target: string; op: 'approve' | 'reject' | 'reserve'; id: string; reserve?: Record<string, string> }>,
): Promise<ClaimResult[]> {
  const barrier = new SharedArrayBuffer(4);
  const flag = new Int32Array(barrier);
  const workers = specs.map((s) => new Worker(WORKER, {
    workerData: { ...s, barrier },
    execArgv: ['--import', 'tsx'],
  }));
  const ready = workers.map((w) => new Promise<void>((resolve, reject) => {
    w.on('message', (m: { type: string }) => { if (m.type === 'ready') resolve(); });
    w.on('error', reject);
    w.on('exit', () => resolve());
  }));
  const done = workers.map((w) => new Promise<ClaimResult>((resolve) => {
    w.on('message', (m: { type: string; ok: boolean; error?: string }) => {
      if (m.type === 'done') resolve({ ok: m.ok, error: m.error });
    });
    w.on('error', (e) => resolve({ ok: false, error: String(e) }));
  }));
  await Promise.all(ready);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  const results = await Promise.all(done);
  await Promise.all(workers.map((w) => w.terminate()));
  return results;
}
