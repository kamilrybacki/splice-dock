// Admin routes for the per-call approval workflow used by policies with
// on_violation: approval. Mounts under the auth-gated plugin scope so every
// endpoint requires either the Bearer Authorization header or the WebUI
// session cookie.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApprovalService } from '../../../../application/approvals/approval-service.js';
import { BUILT_IN_GRANT_EXCEPTION_LABELS } from '../../../../domain/policy/grant-config.js';

/**
 * The approver is always the authenticated admin identity attached by the auth
 * hook. `body.approver` is accepted for backward compatibility but ignored: it
 * is caller-controlled and must never be recorded as who approved.
 */
function authenticatedApprover(req: FastifyRequest, reply: FastifyReply): string | null {
  if (req.adminIdentity) return req.adminIdentity;
  reply.code(401).send({ error: { code: 'unauthorized', message: 'No authenticated identity' } });
  return null;
}

export function registerApprovalRoutes(
  app: FastifyInstance,
  service: ApprovalService,
): void {
  app.get('/api/v1/grants', async (_req,reply) => reply.send({enabled:service.grants.enabled,data:await service.listGrants(),exceptions:await service.grants.exceptions(),built_in:BUILT_IN_GRANT_EXCEPTION_LABELS}));
  app.post<{Params:{id:string}}>('/api/v1/grants/:id/revoke',async(req,reply)=>{
    const actor=authenticatedApprover(req,reply);if(!actor)return;
    await service.grants.revoke(req.params.id==='all'?undefined:req.params.id,actor);return reply.send({ok:true});
  });
  app.post<{Body:{tool?:unknown;verb_path?:unknown;remove?:unknown}}>('/api/v1/grant-exceptions',async(req,reply)=>{
    const actor=authenticatedApprover(req,reply);if(!actor)return;
    const {tool,verb_path='*',remove=false}=req.body ?? {};
    if(typeof tool!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(tool) || typeof verb_path!=='string' || !/^[a-zA-Z0-9_ *-]{1,100}$/.test(verb_path) || typeof remove!=='boolean')return reply.code(400).send({error:'invalid exception'});
    await service.grants.setException(tool,verb_path,!remove,actor);return reply.send({ok:true});
  });
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/api/v1/approvals',
    async (req, reply) => {
      const status = req.query.status;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined;
      const rows = await service.list({
        status: status && /^[a-z]+$/.test(status) ? status : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      reply.send({ data: rows });
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/approvals/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) {
      reply.code(400).send({ error: { code: 'invalid_id', message: 'id must be a UUID' } });
      return;
    }
    const row = await service.get(req.params.id);
    if (!row) {
      reply.code(404).send({ error: { code: 'not_found', message: 'approval not found' } });
      return;
    }
    reply.send({ data: row });
  });

  app.post<{ Params: { id: string }; Body: { approver?: string } | undefined }>(
    '/api/v1/approvals/:id/approve',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        reply.code(400).send({ error: { code: 'invalid_id', message: 'id must be a UUID' } });
        return;
      }
      const approver = authenticatedApprover(req, reply);
      if (!approver) return;
      if (await service.isStrong(req.params.id)) {
        await service.approve(req.params.id,approver);
        return reply.code(409).send({error:{code:'webauthn_required',message:'WebAuthn required'}});
      }
      const ok = await service.approve(req.params.id, approver);
      if (!ok) {
        reply
          .code(409)
          .send({ error: { code: 'not_pending', message: 'approval is not pending or already expired' } });
        return;
      }
      reply.send({ data: await service.get(req.params.id) });
    },
  );

  app.post<{ Params: { id: string }; Body: { approver?: string } | undefined }>(
    '/api/v1/approvals/:id/reject',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        reply.code(400).send({ error: { code: 'invalid_id', message: 'id must be a UUID' } });
        return;
      }
      const approver = authenticatedApprover(req, reply);
      if (!approver) return;
      const ok = await service.reject(req.params.id, approver);
      if (!ok) {
        reply
          .code(409)
          .send({ error: { code: 'not_pending', message: 'approval is not pending' } });
        return;
      }
      reply.send({ data: await service.get(req.params.id) });
    },
  );
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
