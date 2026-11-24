import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { buildAdminTokenSet, type AdminTokenSet, type NamedAdminToken } from '../../base.js';
export { buildAdminTokenSet, type AdminTokenSet } from '../../base.js';

export const ADMIN_SESSION_COOKIE = 'splicedock_admin';

/**
 * State-changing requests authenticated by the session cookie must carry this
 * header (any non-empty value). A cross-site form or <img> cannot set a custom
 * header, and a cross-origin fetch carrying it needs a CORS preflight that this
 * server never grants. Bearer-authenticated requests are exempt (a bearer is
 * never attached automatically by the browser).
 */
export const CSRF_HEADER = 'x-splicedock-csrf';

/** Edge (reverse proxy / Authelia) bypass header carrying the shared bypass secret. */
export const AUTHELIA_HEADER = 'x-splicedock-authelia';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated admin identity ("admin" for the legacy token, else the token's name). */
    adminIdentity?: string;
  }
}

type Presented = { token: string; via: 'bearer' | 'cookie' };

function presentToken(req: FastifyRequest): Presented | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return { token: auth.slice(7), via: 'bearer' };
  const cookieHeader = req.headers.cookie ?? '';
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === ADMIN_SESSION_COOKIE && v) return { token: decodeURIComponent(v), via: 'cookie' };
  }
  return null;
}

/**
 * Two valid auth surfaces:
 *   - Authorization: Bearer <admin token>      (API clients)
 *   - splicedock_admin=<admin token> cookie    (WebUI after login)
 * The token may be the single legacy token (identity "admin") or one of the
 * named tokens (identity = its name). The matched identity is attached to the
 * request as `adminIdentity`. Cookie-authenticated unsafe methods additionally
 * require the CSRF header.
 */
export function buildAdminAuthHook(
  legacyToken: string | AdminTokenSet,
  namedTokens: readonly NamedAdminToken[] = [],
) {
  const tokens = typeof legacyToken === 'string' ? buildAdminTokenSet(legacyToken, namedTokens) : legacyToken;

  return function adminAuth(
    req: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    const presented = presentToken(req);
    if (!presented) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing credentials' } });
      return;
    }
    const identity = tokens.identify(presented.token);
    if (!identity) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid token' } });
      return;
    }
    if (presented.via === 'cookie' && !SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || header.length === 0) {
        reply.code(403).send({ error: { code: 'csrf', message: `Missing ${CSRF_HEADER} header` } });
        return;
      }
    }
    req.adminIdentity = identity;
    done();
  };
}
