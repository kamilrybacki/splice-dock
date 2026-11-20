// Admin routes for the in-memory audit ring and the SSE live feed.

import type { FastifyInstance } from 'fastify';
import type { AuditBuffer, AuditEntry } from '../../../../application/audit/audit-buffer.js';

export function registerAuditRoutes(app: FastifyInstance, buffer: AuditBuffer): void {
  app.get<{
    Querystring: { limit?: string; tool?: string; decision?: 'allow' | 'deny' | 'approval' };
  }>('/api/v1/audit', async (req, reply) => {
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit ?? '200', 10) || 200));
    const entries = buffer.recent(limit, {
      tool: req.query.tool,
      decision: req.query.decision,
    });
    reply.send({ data: entries, count: entries.length });
  });

  /**
   * Server-sent events feed of policy decisions. The client opens a long
   * connection and receives `data: {...}\n\n` blocks for each new entry.
   * No backfill — pair with /api/v1/audit for initial state.
   */
  app.get('/api/v1/audit/stream', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

    const send = (event: AuditEntry): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Send a comment-only line periodically so reverse proxies don't kill
    // the idle connection. 25s is below the 30s timeout most proxies use.
    const ping = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 25_000);
    ping.unref?.();

    const unsubscribe = buffer.subscribe(send);

    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });

    // Fastify's async handler returns; raw socket stays open until close().
    return reply;
  });
}
