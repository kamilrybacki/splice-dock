import { describe, it, expect } from 'vitest';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { drainHttpServer } from '../../src/common/http-drain.js';

function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  return new Promise<{ server: ReturnType<typeof createServer>; port: number }>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })),
  );
}

function get(port: number): Promise<{ status: number | undefined; error?: string }> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/', agent: false }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', err => resolve({ status: undefined, error: err.message }));
    req.end();
  });
}

describe('drainHttpServer', () => {
  it('lets an in-flight request finish before resolving', async () => {
    const { server, port } = await listen((_req, res) => {
      setTimeout(() => res.end('ok'), 150);
    });
    const inflight = get(port);
    await new Promise(r => setTimeout(r, 30));
    const result = await drainHttpServer(server, 2_000);
    expect(result).toBe('drained');
    expect((await inflight).status).toBe(200);
  });

  it('force-closes connections still open after the timeout', async () => {
    const { server, port } = await listen(() => { /* never responds */ });
    const inflight = get(port);
    await new Promise(r => setTimeout(r, 30));
    const started = Date.now();
    const result = await drainHttpServer(server, 100);
    expect(result).toBe('forced');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await inflight).error).toBeDefined();
  });

  it('stops accepting new connections once draining starts', async () => {
    const { server, port } = await listen((_req, res) => res.end('ok'));
    await drainHttpServer(server, 500);
    expect((await get(port)).error).toBeDefined();
  });
});
