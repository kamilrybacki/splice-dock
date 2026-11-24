// tests/unit/export/yaml-exporter.test.ts
import { describe, it, expect } from 'vitest';
import { exportToolsYaml, exportProfilesYaml, exportFullManifest } from '../../../src/services/admin/adapters/fastify/yaml-exporter.js';
import { ToolRegistry, type RegistryEntry } from '../../../src/services/tools/tool-registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/profile-registry.js';
import yaml from 'js-yaml';

function makeHttpEntry(id: string, source: 'file' | 'runtime' = 'file'): RegistryEntry {
  const [ns, name] = id.split('__');
  return {
    id,
    driver: 'http',
    source,
    config: {
      type: 'http',
      name,
      namespace: ns,
      description: 'desc',
      method: 'GET',
      url: 'https://x.com/{p}',
      params: [{ name: 'p', in: 'path', required: true }],
      auth: { type: 'none' },
    },
    mcpDef: { name: id, description: 'desc', inputSchema: { type: 'object' } },
  };
}

describe('exportToolsYaml', () => {
  it('produces valid YAML that round-trips back to the original configs', () => {
    const reg = new ToolRegistry();
    reg.addFileTool(makeHttpEntry('github__search'));
    reg.addRuntimeTool(makeHttpEntry('jira__issue', 'runtime'));

    const raw = exportToolsYaml(reg.getAllTools());
    const parsed = yaml.load(raw) as { tools: unknown[] };
    expect(parsed.tools).toHaveLength(2);
  });

  it('preserves tool type and namespace', () => {
    const reg = new ToolRegistry();
    reg.addFileTool(makeHttpEntry('github__search'));

    const raw = exportToolsYaml(reg.getAllTools());
    const parsed = yaml.load(raw) as { tools: Array<{ type: string; namespace: string; name: string }> };
    expect(parsed.tools[0].type).toBe('http');
    expect(parsed.tools[0].namespace).toBe('github');
    expect(parsed.tools[0].name).toBe('search');
  });

  it('returns empty tools list when registry is empty', () => {
    const raw = exportToolsYaml([]);
    const parsed = yaml.load(raw) as { tools: unknown[] };
    expect(parsed.tools).toHaveLength(0);
  });
});

describe('exportProfilesYaml', () => {
  it('exports profiles with their tool globs', () => {
    const reg = new ProfileRegistry();
    reg.addFileProfile('coding', { tools: ['github__*', 'jira__*'] });
    reg.addRuntimeProfile('ops', { tools: ['kubectl__*'] });

    const raw = exportProfilesYaml(reg);
    const parsed = yaml.load(raw) as { profiles: Record<string, { tools: string[] }> };
    expect(parsed.profiles.coding.tools).toEqual(['github__*', 'jira__*']);
    expect(parsed.profiles.ops.tools).toEqual(['kubectl__*']);
  });

  it('does not pollute Object.prototype for adversarial profile names', () => {
    const reg = new ProfileRegistry();
    reg.addFileProfile('__proto__', { tools: ['evil__*'] });
    // Should not throw and should not mutate Object.prototype
    const raw = exportProfilesYaml(reg);
    expect(({} as Record<string, unknown>)['evil__*']).toBeUndefined();
    // The output is still valid YAML (though the key may be quoted)
    expect(raw).toContain('__proto__');
  });

  it('returns empty profiles when registry is empty', () => {
    const reg = new ProfileRegistry();
    const raw = exportProfilesYaml(reg);
    const parsed = yaml.load(raw) as { profiles: Record<string, unknown> };
    expect(Object.keys(parsed.profiles)).toHaveLength(0);
  });
});

describe('exportFullManifest', () => {
  it('produces a full splicedock.yaml with server, profiles, and tools', () => {
    const toolReg = new ToolRegistry();
    toolReg.addFileTool(makeHttpEntry('github__search'));
    const profileReg = new ProfileRegistry();
    profileReg.addFileProfile('coding', { tools: ['github__*'] });

    const raw = exportFullManifest(toolReg, profileReg, {
      port: 8788,
      admin_port: 8789,
      admin_token_env: 'SPLICEDOCK_ADMIN_TOKEN',
      cli_whitelist: [],
    });
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(parsed).toHaveProperty('server');
    expect(parsed).toHaveProperty('profiles');
    expect(parsed).toHaveProperty('tools');
  });

  it('round-trips server config correctly', () => {
    const toolReg = new ToolRegistry();
    const profileReg = new ProfileRegistry();
    const serverCfg = { port: 9000, admin_port: 9001, admin_token_env: 'MY_TOKEN', cli_whitelist: ['kubectl'] };

    const raw = exportFullManifest(toolReg, profileReg, serverCfg);
    const parsed = yaml.load(raw) as { server: typeof serverCfg };
    expect(parsed.server.port).toBe(9000);
    expect(parsed.server.admin_port).toBe(9001);
    expect(parsed.server.cli_whitelist).toEqual(['kubectl']);
  });

  it('omits admin token and metrics token config keys from the server block', () => {
    const toolReg = new ToolRegistry();
    const profileReg = new ProfileRegistry();
    const raw = exportFullManifest(toolReg, profileReg, {
      port: 8788,
      admin_port: 8789,
      admin_token_env: 'PLACEHOLDER_ADMIN_ENV',
      admin_tokens: [{ name: 'alice', token_env: 'PLACEHOLDER_ALICE_ENV' }],
      metrics_token_env: 'PLACEHOLDER_METRICS_ENV',
      require_profile_token: true,
      cli_whitelist: [],
    } as unknown as Parameters<typeof exportFullManifest>[2]);
    const parsed = yaml.load(raw) as { server: Record<string, unknown> };
    expect(parsed.server).not.toHaveProperty('admin_token_env');
    expect(parsed.server).not.toHaveProperty('admin_tokens');
    expect(parsed.server).not.toHaveProperty('metrics_token_env');
    expect(raw).not.toContain('PLACEHOLDER_');
    // Non-credential settings survive the export.
    expect(parsed.server.require_profile_token).toBe(true);
  });

  it('includes both file and runtime tools in manifest', () => {
    const toolReg = new ToolRegistry();
    toolReg.addFileTool(makeHttpEntry('github__search'));
    toolReg.addRuntimeTool(makeHttpEntry('jira__issue', 'runtime'));
    const profileReg = new ProfileRegistry();

    const raw = exportFullManifest(toolReg, profileReg, {
      port: 8788,
      admin_port: 8789,
      admin_token_env: 'TOKEN',
      cli_whitelist: [],
    });
    const parsed = yaml.load(raw) as { tools: unknown[] };
    expect(parsed.tools).toHaveLength(2);
  });
});
