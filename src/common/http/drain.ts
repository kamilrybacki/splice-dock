import type { Server } from 'node:http';

const IDLE_SWEEP_MS = 250;

export type DrainResult = 'drained' | 'forced';

/**
 * Stop accepting connections and wait for in-flight requests to finish.
 * Idle keep-alive sockets are closed at once. Anything still open after
 * `timeoutMs` (e.g. a long approval wait) is force-closed so shutdown
 * finishes inside the pod's termination grace period.
 */
export function drainHttpServer(server: Server, timeoutMs: number): Promise<DrainResult> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: DrainResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(sweep);
      resolve(result);
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish('forced');
    }, timeoutMs);
    timer.unref();
    // Keep-alive sockets go idle as their last request finishes; close them
    // as they do so a reused socket is not reset mid-request at the timeout.
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
    sweep.unref();
    server.close(() => finish('drained'));
    server.closeIdleConnections();
  });
}
