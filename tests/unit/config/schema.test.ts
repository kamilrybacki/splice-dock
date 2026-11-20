import { describe, it, expect } from 'vitest';
import { toolSchema, splicedockConfigSchema, type McpProxyToolConfig } from '../../../src/config/schema.js';

describe('mcp_proxy schema v2', () => {
  it('accepts service_dns + port', () => {
    const result = toolSchema.parse({
      type: 'mcp_proxy',
      name: 'seq-thinking',
      service_dns: 'seq-thinking-mcp-headless.default.svc.cluster.local',
      port: 8000,
      refresh_interval_ms: 600_000,
    });
    expect(result).toMatchObject({ name: 'seq-thinking', port: 8000 });
  });

  it('defaults port to 8000 and refresh to 10min', () => {
    const result = toolSchema.parse({
      type: 'mcp_proxy',
      name: 'seq-thinking',
      service_dns: 'foo.svc',
    });
    expect((result as McpProxyToolConfig).port).toBe(8000);
    expect((result as McpProxyToolConfig).refresh_interval_ms).toBe(600_000);
  });

  it('rejects refresh_interval_ms below 60000', () => {
    expect(() => toolSchema.parse({
      type: 'mcp_proxy',
      name: 'seq',
      service_dns: 'x.svc',
      refresh_interval_ms: 30_000,
    })).toThrow();
  });

  it('rejects empty service_dns', () => {
    expect(() => toolSchema.parse({
      type: 'mcp_proxy',
      name: 'seq',
      service_dns: '',
    })).toThrow();
  });

  it('rejects port 0', () => {
    expect(() => toolSchema.parse({
      type: 'mcp_proxy',
      name: 'seq',
      service_dns: 'x.svc',
      port: 0,
    })).toThrow();
  });

  it('accepts optional description and retry', () => {
    const result = toolSchema.parse({
      type: 'mcp_proxy',
      name: 'seq',
      service_dns: 'x.svc',
      description: 'A useful proxy',
      retry: { max_attempts: 3, backoff_ms: 500 },
    });
    expect((result as McpProxyToolConfig).description).toBe('A useful proxy');
    expect((result as McpProxyToolConfig).retry?.max_attempts).toBe(3);
  });
});

describe('splicedockConfigSchema — retired tunnel block', () => {
  // The workspace tunnel was removed; existing configs may still carry a
  // `tunnel:` block. It must be tolerated (not a startup failure) and dropped.
  it('accepts and strips a legacy tunnel block', () => {
    const config = splicedockConfigSchema.parse({
      tunnel: {
        enabled: true,
        broker_socket_path: '/run/splicedock/sessions.sock',
        required_for_workspace_bound: true,
      },
    });
    expect(config).not.toHaveProperty('tunnel');
  });
});

it.each([
 ['gh',['repo','archive','owner/repo','--yes']],
 ['gh',['repo','view','--web']],['gh',['api','/repos']],['unknown',['get']],
])('rejects unsafe breaker exemption %s %j',(tool,argv)=>{
 expect(()=>splicedockConfigSchema.parse({server:{breaker:{read_allowlist:[{tool,argv}]}}})).toThrow();
});
it('accepts a closed readonly exemption',()=>{
 expect(()=>splicedockConfigSchema.parse({server:{breaker:{read_allowlist:[{tool:'gh',argv:['repo','view']}]}}})).not.toThrow();
});
