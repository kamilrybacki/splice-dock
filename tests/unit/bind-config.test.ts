import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { splicedockConfigSchema } from '../../src/config/schema.js';
import { adminListenOptions, mcpListenOptions, warnIfProfileTokenOptional } from '../../src/bind-config.js';
import { logger } from '../../src/common/logger.js';

const parse = (server: Record<string, unknown> = {}) => splicedockConfigSchema.parse({ server }).server;

afterEach(() => vi.restoreAllMocks());

describe('listen options', () => {
  it('binds the admin API to all interfaces by default', () => {
    expect(adminListenOptions(parse())).toEqual({ port: 8789, host: '0.0.0.0' });
  });

  it('passes a configured admin_host and admin_port to listen', () => {
    expect(adminListenOptions(parse({ admin_host: '127.0.0.1', admin_port: 9001 }))).toEqual({ port: 9001, host: '127.0.0.1' });
  });

  it('leaves the MCP host unset by default, so Node keeps its all-interfaces default', () => {
    expect(mcpListenOptions(parse())).toEqual({ port: 8788 });
    expect('host' in mcpListenOptions(parse())).toBe(false);
  });

  it('passes a configured host and port to listen', () => {
    expect(mcpListenOptions(parse({ host: '127.0.0.1', port: 9000 }))).toEqual({ port: 9000, host: '127.0.0.1' });
  });

  it('is accepted by http.Server.listen and the server binds that address', async () => {
    const server = createServer();
    const opts = { ...mcpListenOptions(parse({ host: '127.0.0.1', port: 1 })), port: 0 };
    await new Promise<void>(r => server.listen(opts, r));
    expect((server.address() as { address: string }).address).toBe('127.0.0.1');
    await new Promise<void>(r => server.close(() => r()));
  });
});

describe('warnIfProfileTokenOptional', () => {
  it('stays quiet with the default configuration', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    warnIfProfileTokenOptional(parse());
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when require_profile_token is explicitly disabled', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    warnIfProfileTokenOptional(parse({ require_profile_token: false }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('require_profile_token');
  });
});
