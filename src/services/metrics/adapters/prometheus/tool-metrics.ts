import type { ToolLocalCounters } from '../../base.js';

/** Prometheus label value: surrounded by ", with " and \ escaped. */
function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Prometheus exposition of one process's own per-tool CLI counters. */
export function renderToolMetrics(counters: readonly ToolLocalCounters[]): string {
  const lines: string[] = [];
  lines.push('# HELP splicedock_cli_calls_total Cumulative CLI passthrough call count');
  lines.push('# TYPE splicedock_cli_calls_total counter');
  lines.push('# HELP splicedock_cli_deny_total Cumulative CLI passthrough deny count');
  lines.push('# TYPE splicedock_cli_deny_total counter');
  lines.push('# HELP splicedock_cli_last_duration_ms Last observed duration of a CLI passthrough run');
  lines.push('# TYPE splicedock_cli_last_duration_ms gauge');
  for (const c of counters) {
    const tool = quote(c.tool);
    lines.push(`splicedock_cli_calls_total{tool=${tool},decision="allow"} ${c.allow}`);
    lines.push(`splicedock_cli_calls_total{tool=${tool},decision="deny"} ${c.deny}`);
    for (const [rule, count] of Object.entries(c.rule_denies)) {
      lines.push(`splicedock_cli_deny_total{tool=${tool},rule=${quote(rule)}} ${count}`);
    }
    if (c.last_duration_ms !== null) {
      lines.push(`splicedock_cli_last_duration_ms{tool=${tool}} ${c.last_duration_ms}`);
    }
  }
  return lines.join('\n') + '\n';
}
