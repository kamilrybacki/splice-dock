import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialAdapters } from '../../../src/services/secrets/adapters/index.js';
import { configureCredentialBroker, resetCredentialBroker } from '../../../src/services/secrets/broker.js';
import { buildAuthHeaders } from '../../../src/services/upstreams/adapters/mcp/driver.js';
import { callHttpTool } from '../../../src/services/tools/adapters/http/driver.js';
import { runWithCaller } from '../../../src/common/request/context.js';
import type { HttpToolConfig } from '../../../src/config/types.js';

let dir: string;
let counter: string;

const httpConfig: HttpToolConfig = {
  type: 'http', name: 'svc', namespace: 'test', description: 'd', method: 'GET',
  url: 'https://api.example.com/x', params: [], auth: { type: 'bearer', token: { mint: 'p' } },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
  dir = mkdtempSync(join(tmpdir(), 'splicedock-mint-auth-'));
  counter = join(dir, 'counter');
  writeFileSync(counter, '0');
  configureCredentialBroker({
    providers: {
      p: {
        type: 'command', command: 'sh',
        args: ['-c', 'n=$(cat "$0"); n=$((n+1)); echo $n > "$0"; echo tok-$n', counter],
        env_allowlist: [], env: [],
        timeout_ms: 5000, ttl_seconds: 3600, output: { format: 'text', secret_field: 'token' },
      },
    },
    storage: { type: 'memory', prefix: '' },
  }, credentialAdapters);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCredentialBroker();
  rmSync(dir, { recursive: true, force: true });
});

const mints = (): string => readFileSync(counter, 'utf8').trim();

describe('upstream MCP driver minting', () => {
  const auth = { type: 'bearer' as const, token: { mint: 'p' } };

  it('mints for an authenticated identity', async () => {
    const headers = await buildAuthHeaders(auth, { profile: 'w', agent: null, authenticated: true, tokenId: 't' }, 'vault');
    expect(headers).toEqual({ Authorization: 'Bearer tok-1' });
  });

  it('refuses an unauthenticated identity without minting', async () => {
    await expect(buildAuthHeaders(auth, { profile: 'w', agent: null, authenticated: false, tokenId: null }, 'vault'))
      .rejects.toThrow('credential_identity_unauthenticated');
    expect(mints()).toBe('0');
  });
});

describe('http driver minting', () => {
  const call = (authenticated: boolean): Promise<unknown> =>
    runWithCaller({ profile: 'w', tokenId: 't', authenticated, agent: null }, () =>
      callHttpTool(httpConfig, {}));

  it('mints for an authenticated caller', async () => {
    await expect(call(true)).resolves.toBeDefined();
    expect(mints()).toBe('1');
  });

  it('refuses an unauthenticated caller without minting', async () => {
    await expect(call(false)).rejects.toThrow('credential_identity_unauthenticated');
    expect(mints()).toBe('0');
  });
});
