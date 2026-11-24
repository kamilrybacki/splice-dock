import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../src/config/loader.js';

const EXAMPLE_PATH = fileURLToPath(new URL('../../../splicedock.example.yaml', import.meta.url));
const README_PATH = fileURLToPath(new URL('../../../README.md', import.meta.url));

describe('splicedock.example.yaml', () => {
  it('loads against the config schema', () => {
    const config = loadConfig(EXAMPLE_PATH);
    const proxies = config.tools.filter(t => t.type === 'mcp_proxy');
    expect(proxies.length).toBeGreaterThan(0);
    for (const proxy of proxies) {
      expect(proxy.service_dns).toMatch(/\.example\.internal$/);
      expect(proxy.port).toBe(8000);
      expect(proxy.transport).toBe('sse');
    }
  });

  it('satisfies the startup rule for strong consent (enabled requires rp_id and an HTTPS origin)', () => {
    const { consent } = loadConfig(EXAMPLE_PATH).server;
    if (!consent.enabled) return;
    expect(consent.rp_id).toBeTruthy();
    expect(consent.origin).toBeTruthy();
    expect(new URL(consent.origin!).protocol).toBe('https:');
  });

  it('whitelists the command of every cli and cli_passthrough tool, so none is refused', () => {
    const config = loadConfig(EXAMPLE_PATH);
    const commands = config.tools.flatMap(t => (t.type === 'cli' || t.type === 'cli_passthrough' ? [t.command] : []));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(config.server.cli_whitelist).toContain(command);
  });
});

describe('README npm install commands', () => {
  it('point the config, database and CLI binaries at user-writable paths and set the admin token', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const block = /### npm \(bare metal\)[\s\S]*?```bash\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';
    for (const name of ['SPLICEDOCK_CONFIG', 'SPLICEDOCK_DB_PATH', 'SPLICEDOCK_BIN', 'SPLICEDOCK_ADMIN_TOKEN']) {
      expect(block).toContain(`export ${name}=`);
    }
  });
});
