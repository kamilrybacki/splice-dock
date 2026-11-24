import type { IssueProfileTokenRequest, RelabelProfileTokenRequest, RevokeProfileTokenRequest } from '../../../../../contracts/inbound/profile-tokens.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { SplicedockStore } from '../../../../database/adapters/store.js';
import { generateProfileToken, hashProfileToken } from '../../../../authentication/base.js';

/** Same shape as a profile name; also used for the optional agent label. */
const LABEL_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Admin routes to mint, list, relabel, and revoke profile tokens.
 *
 * A token binds an MCP session to a single splicedock profile (see the MCP-port
 * bearer handling in the Express MCP adapter). The raw token is returned exactly once
 * on creation; only its sha256 hash is stored, and the listing never exposes it.
 */
export function registerProfileTokenRoutes(app: FastifyInstance, store: SplicedockStore, policy = { max_ttl_seconds: 2592000, default_ttl_seconds: 2592000 }): void {
  app.post('/api/v1/profile-tokens', async (req, reply) => {
    const body = req.body as IssueProfileTokenRequest;
    if (!body?.profile) {
      reply.code(400).send({ error: { code: 'bad_request', message: "'profile' is required" } });
      return;
    }
    if (!LABEL_PATTERN.test(body.profile)) {
      reply.code(422).send({ error: { code: 'validation_error', message: 'profile must be 1-64 alphanumeric/underscore/hyphen characters' } });
      return;
    }
    if (body.agent !== undefined && body.agent !== null && !(typeof body.agent === 'string' && LABEL_PATTERN.test(body.agent))) {
      reply.code(422).send({ error: { code: 'validation_error', message: 'agent must be 1-64 alphanumeric/underscore/hyphen characters' } });
      return;
    }
    const agent = body.agent ?? null;
    const ttl = body.expires_in_seconds;
    if (!Number.isInteger(ttl) || !ttl || ttl < 1 || ttl > policy.max_ttl_seconds) {
      return reply.code(400).send({ error: { code: 'invalid_ttl' } });
    }
    const id = randomUUID();
    const token = generateProfileToken();
    await store.insertProfileToken(id, body.profile, hashProfileToken(token), ttl, req.adminIdentity, agent);
    // The raw token is shown exactly once; only its hash is persisted.
    reply.code(201).send({ data: { id, profile: body.profile, agent, token } });
  });

  app.post('/api/v1/profile-tokens/:id/rotate', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const newId = randomUUID();
    const token = generateProfileToken();
    if (!await store.rotateProfileToken(id, newId, hashProfileToken(token), policy.default_ttl_seconds, req.adminIdentity)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Active token not found' } });
    }
    const agent = (await store.listProfileTokens()).find(t => t.id === newId)?.agent ?? null;
    return reply.code(201).send({ data: { id: newId, agent, token } });
  });

  // Relabel an active token in place: the secret is unchanged, so running agents keep working.
  app.patch('/api/v1/profile-tokens/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as RelabelProfileTokenRequest | undefined;
    if (!body || !('agent' in body)) {
      return reply.code(400).send({ error: { code: 'bad_request', message: "'agent' is required (string or null)" } });
    }
    if (body.agent !== null && !(typeof body.agent === 'string' && LABEL_PATTERN.test(body.agent))) {
      return reply.code(422).send({ error: { code: 'validation_error', message: 'agent must be 1-64 alphanumeric/underscore/hyphen characters or null' } });
    }
    const row = await store.setProfileTokenAgent(id, body.agent, req.adminIdentity);
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'Active token not found' } });
    return reply.send({ data: row });
  });

  app.post('/api/v1/profile-tokens/:id/revoke', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const reason = (req.body as RevokeProfileTokenRequest | undefined)?.reason;
    if (!reason || !['manual', 'compromised'].includes(reason)) return reply.code(400).send({ error: { code: 'invalid_reason' } });
    const row = (await store.listProfileTokens()).find(t => t.id === id);
    if (!row) return reply.code(404).send({ error: { code: 'not_found' } });
    if (!await store.deleteProfileToken(id, req.adminIdentity, reason)) return reply.code(409).send({ error: { code: 'already_revoked' } });
    return reply.code(204).send();
  });

  app.get('/api/v1/profile-tokens', async (_req, reply) => {
    reply.send({ data: await store.listProfileTokens() });
  });

  app.delete('/api/v1/profile-tokens/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!await store.deleteProfileToken(id, req.adminIdentity)) {
      reply.code(404).send({ error: { code: 'not_found', message: `Token '${id}' not found` } });
      return;
    }
    reply.code(204).send();
  });
}
