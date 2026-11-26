// Admin routes for cli_passthrough usage metrics. Two surfaces:
//   - JSON /api/v1/usage(/:tool)  — consumed by the WebUI
//   - text /api/v1/usage/prometheus — Prometheus exposition (admin-token-gated
//     for the JSON endpoints; the unauthenticated /metrics route in server.ts
//     remains the scraper-facing surface)

import type { FastifyInstance } from 'fastify';
import type { ToolMetrics, ToolMetric } from '../../../../metrics/base.js';
import { hourlyOf, minutesOf } from '../../../../metrics/metric-state.js';
import { hourOf } from '../../../../metrics/hourly.js';
import { minuteOf } from '../../../../metrics/minutes.js';
import { windowSum } from '../../../../metrics/window.js';

/**
 * Calls in the last `sinceMinutes`, read from the time-correct windows: rolled to
 * now (no calls since the last one = zeros) and counting only known units.
 * `calls_in_window_complete` is false when part of the range is unknown (e.g. a
 * legacy snapshot with no anchor), so the count is only a lower bound.
 */
function slice(metric: ToolMetric, sinceMinutes: number | null, now: number): {
  total: number; allow: number; deny: number; calls_in_window: number; calls_in_window_complete: boolean;
} {
  const base = { total: metric.total, allow: metric.allow, deny: metric.deny };
  if (sinceMinutes === null) {
    return { ...base, calls_in_window: metric.total, calls_in_window_complete: true };
  }
  const w = sinceMinutes <= 60
    ? windowSum(minutesOf(metric), minuteOf(now), sinceMinutes)
    : windowSum(hourlyOf(metric), hourOf(now), Math.min(24, Math.ceil(sinceMinutes / 60)));
  return { ...base, calls_in_window: w.sum, calls_in_window_complete: w.complete };
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
      ...slice(m, sinceMinutes, Date.now()),
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
        ...slice(m, sinceMinutes, Date.now()),
        rule_denies: m.rule_denies,
        last_ts: m.last_ts,
        last_duration_ms: m.last_duration_ms,
        buckets_60s: m.buckets_60s,
        buckets_1h: m.buckets_1h,
      },
    });
  });
}
