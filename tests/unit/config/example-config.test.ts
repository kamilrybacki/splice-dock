import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../src/config/loader.js';

const EXAMPLE_PATH = fileURLToPath(new URL('../../../splicedock.example.yaml', import.meta.url));

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
});
