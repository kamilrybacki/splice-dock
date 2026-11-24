import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildSessionCtx, requireSession } from '../../src/services/admin/adapters/fastify/web/session.js';

const SECRET = 'edge-secret-value';

function run(headers: Record<string, string>): boolean {
  const ctx = buildSessionCtx({ expectedToken: 'admin-token', autheliaBypassSecret: SECRET });
  const reply = { header: () => reply, redirect: () => reply, code: () => reply, send: () => reply } as unknown as FastifyReply;
  return requireSession({ headers } as unknown as FastifyRequest, reply, ctx);
}

describe('edge bypass header', () => {
  it('accepts the splicedock header', () => {
    expect(run({ 'x-splicedock-authelia': SECRET })).toBe(true);
  });
  it('rejects the removed legacy cellarette header', () => {
    expect(run({ 'x-cellarette-authelia': SECRET })).toBe(false);
  });
  it('rejects a wrong secret', () => {
    expect(run({ 'x-splicedock-authelia': 'nope' })).toBe(false);
  });
});
