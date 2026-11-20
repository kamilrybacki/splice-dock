// Session auth helpers for the admin WebUI.
// Encapsulates cookie read/write, HMAC digest comparison, and Authelia bypass.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ADMIN_SESSION_COOKIE, AUTHELIA_HEADER, buildAdminTokenSet, type AdminTokenSet } from '../auth.js';

export const SESSION_TTL_SEC = 8 * 3600;

// Per-process random key used to HMAC admin tokens before comparing.
// This prevents timing attacks against the raw token string.
// Intentionally regenerated on every process start: existing sessions are
// invalidated after a restart, which is acceptable for an admin surface and
// avoids persisting an extra long-lived secret.
export const HMAC_FOR_CHECK = randomBytes(32);

export function readCookie(req: FastifyRequest, name: string): string | null {
  const cookieHeader = req.headers.cookie ?? '';
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name && v) return decodeURIComponent(v);
  }
  return null;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const value = encodeURIComponent(token);
  reply.header('Set-Cookie', [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SEC}`,
    'HttpOnly',
    'SameSite=Strict',
    'Secure',
  ].join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`,
  );
}

export interface SessionCtx {
  expectedDigest: Buffer;
  tokens: AdminTokenSet;
  expectedToken: string;
  autheliaSecret: string | undefined;
}

export function buildSessionCtx(opts: {
  expectedToken: string;
  tokens?: AdminTokenSet;
  autheliaBypassSecret?: string;
}): SessionCtx {
  return {
    tokens: opts.tokens ?? buildAdminTokenSet(opts.expectedToken),
    expectedDigest: createHmac('sha256', HMAC_FOR_CHECK).update(opts.expectedToken).digest(),
    expectedToken: opts.expectedToken,
    autheliaSecret: opts.autheliaBypassSecret,
  };
}

export function verifyToken(submitted: string, expectedDigest: Buffer): boolean {
  const presented = createHmac('sha256', HMAC_FOR_CHECK).update(submitted).digest();
  return presented.length === expectedDigest.length && timingSafeEqual(presented, expectedDigest);
}

// Timing-safe comparison for the Authelia bypass secret.
// Both sides are HMAC'd with HMAC_FOR_CHECK so digests are always 32 bytes;
// length-equality holds by construction and does not leak the secret length.
export function verifyBypassSecret(submitted: string, expected: string): boolean {
  const presented = createHmac('sha256', HMAC_FOR_CHECK).update(submitted).digest();
  const expectedDigest = createHmac('sha256', HMAC_FOR_CHECK).update(expected).digest();
  return timingSafeEqual(presented, expectedDigest);
}

export function requireSession(req: FastifyRequest, reply: FastifyReply, ctx: SessionCtx): boolean {
  if (ctx.autheliaSecret) {
    const bypass = req.headers[AUTHELIA_HEADER];
    if (typeof bypass === 'string' && verifyBypassSecret(bypass, ctx.autheliaSecret)) {
      setSessionCookie(reply, ctx.expectedToken);
      return true;
    }
  }

  const token = readCookie(req, ADMIN_SESSION_COOKIE);
  if (!token) {
    reply.redirect('/admin/login');
    return false;
  }
  if (!ctx.tokens.identify(token)) {
    clearSessionCookie(reply);
    reply.redirect('/admin/login');
    return false;
  }
  return true;
}
