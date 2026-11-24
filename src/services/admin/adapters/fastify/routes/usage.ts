// Admin routes for cli_passthrough usage metrics. Two surfaces:
//   - JSON /api/v1/usage(/:tool)  — consumed by the WebUI
//   - text /api/v1/usage/prometheus — Prometheus exposition (admin-token-gated
//     for the JSON endpoints; the unauthenticated /metrics route in server.ts
//     remains the scraper-facing surface)

import type { FastifyInstance } from 'fastify';
import type { ToolMetrics, ToolMetric } from '../../../../metrics/base.js';

function slice(metric: ToolMetric, sinceMinutes: number | null): {
  total: number; allow: number; deny: number; calls_in_window: number;
} {
  if (sinceMinutes === null) {
    return {
      total: metric.total,
      allow: metric.allow,
      deny: metric.deny,
      calls_in_window: metric.total,
    };
  }
  if (sinceMinutes <= 60) {
    const slice60 = metric.buckets_60s.slice(metric.buckets_60s.length - sinceMinutes);
    return {
      total: metric.total,
      allow: metric.allow,
      deny: metric.deny,
      calls_in_window: slice60.reduce((a, b) => a + b, 0),
    };
  }
  const hours = Math.min(24, Math.ceil(sinceMinutes / 60));
  const sliceH = metric.buckets_1h.slice(metric.buckets_1h.length - hours);
  return {
    total: metric.total,
    allow: metric.allow,
    deny: metric.deny,
    calls_in_window: sliceH.reduce((a, b) => a + b, 0),
  };
}

function parseSince(s: string | undefined): number | null {
  if (!s) return null;
  // Accept "60m", "24h", or a plain integer minute count.
  const m = /^(\d+)([mh])?$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return m[2] === 'h' ? n * 60 : n;
}

export function registerUsageRoutes(app: FastifyInstance, metrics: ToolMetrics): void {
  app.get<{ Querystring: { since?: string } }>('/api/v1/usage', async (req, reply) => {
    const sinceMinutes = parseSince(req.query.since);
    const out = metrics.list().map(m => ({
      tool: m.tool,
      ...slice(m, sinceMinutes),
      rule_denies: m.rule_denies,
      last_ts: m.last_ts,
      last_duration_ms: m.last_duration_ms,
    }));
    reply.send({ data: out, since_minutes: sinceMinutes });
  });

  app.get<{
    Params: { name: string };
    Querystring: { since?: string };
  }>('/api/v1/usage/:name', async (req, reply) => {
    const m = metrics.get(req.params.name);
    if (!m) {
      reply.code(404).send({ error: { code: 'not_found', message: `metrics for tool '${req.params.name}' not found` } });
      return;
    }
    const sinceMinutes = parseSince(req.query.since);
    reply.send({
      data: {
        tool: m.tool,
        ...slice(m, sinceMinutes),
        rule_denies: m.rule_denies,
        last_ts: m.last_ts,
        last_duration_ms: m.last_duration_ms,
        buckets_60s: m.buckets_60s,
        buckets_1h: m.buckets_1h,
      },
    });
  });
}
