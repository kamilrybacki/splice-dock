import { hash } from '../../../application/approvals/consent-store.js';
import { WeakConsent } from './weak.js';
import { enrollmentPage } from './enrollment-page.js';
import type { FastifyInstance } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { WebAuthnConsent } from './webauthn.js';
import { consentPage } from './page.js';
/** Rejects an approval through the approval service so grants are revoked and blocked. */
export type ConsentReject=(id:string,by:string|null)=>Promise<boolean>;
export function registerConsentRoutes(app:FastifyInstance,c:WebAuthnConsent,reject?:ConsentReject):void {
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
    if(!c.config.enabled) return reply.code(404).send({error:{code:'not_found'}});
    if(req.method==='POST' && req.headers.origin!==c.config.origin) return reply.code(403).send({error:{code:'origin_refused'}});
  });
  const config={rateLimit:{max:c.config.rate_limit_per_minute,timeWindow:'1 minute'}};
  app.get<{Params:{link:string}}>('/consent/:link',{config},async(req,reply)=>{
    const r=await c.store.lookup(req.params.link,Date.now()); if(!r)return reply.code(404).send({error:{code:'not_found'}});
    c.event('link_opened');
    const p=consentPage(r);
    return reply.header('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${p.nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`).type('text/html').send(p.html);
  });
  app.post<{Params:{link:string}}>('/consent/:link/options',{config},async(req,reply)=>{
    try{return await c.options(req.params.link);}catch{return reply.code(404).send({error:{code:'not_found'}});}
  });
  app.post<{Params:{link:string};Body:{id:string;response:AuthenticationResponseJSON}}>('/consent/:link/verify',{config},async(req,reply)=>{
    if(!await c.store.lookup(req.params.link,Date.now()))return reply.code(404).send({error:{code:'not_found'}});
    if(!req.body || typeof req.body.id!=='string' || !req.body.response || !await c.verify(req.params.link,req.body.id,req.body.response))return reply.code(400).send({error:{code:'bad_assertion'}});
    return {data:{status:'approved'}};
  });
  app.post<{Params:{link:string}}>('/consent/:link/reject',{config},async(req,reply)=>{
    const row=await c.store.lookup(req.params.link,Date.now());
    if(!row)return reply.code(404).send({error:{code:'not_found'}});
    // Via the service, a link reject must revoke and block like any other reject.
    if(reject){if(!await reject(row.id,'consent_link'))return reply.code(404).send({error:{code:'not_found'}});}
    else{if(!await c.store.reject(req.params.link,Date.now()))return reply.code(404).send({error:{code:'not_found'}});c.event('rejected');}
    return {data:{status:'rejected'}};
  });
}
export function registerEnrollmentRoutes(app:FastifyInstance,c:WebAuthnConsent):void {
  app.get('/api/v1/webauthn/enroll',async(_req,reply)=>{
    if(!c.config.enabled)return reply.code(403).send({error:{code:'disabled'}});
    const p=enrollmentPage();
    return reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${p.nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`).type('text/html').send(p.html);
  });
  app.post('/api/v1/webauthn/register/options',async(req,reply)=>{
    if(!c.config.enabled)return reply.code(403).send({error:{code:'disabled'}});
    if(!c.config.hardware_roots?.length)return reply.code(403).send({error:{code:'hardware_trust_unconfigured'}});
    return await c.registrationOptions(req.adminIdentity!);
  });
  app.post<{Body:{id:string;label:string;response:RegistrationResponseJSON}}>('/api/v1/webauthn/register/verify',async(req,reply)=>{
    const b=req.body;
    if(!c.config.enabled)return reply.code(403).send({error:{code:'disabled'}});
    if(!b || typeof b.id!=='string' || typeof b.label!=='string' || !/^[\w -]{1,64}$/.test(b.label) || !await c.register(req.adminIdentity!,b.id,b.label,b.response))return reply.code(400).send({error:{code:'bad_attestation'}});
    return {data:{id:b.response.id,label:b.label}};
  });
  app.delete<{Params:{id:string}}>('/api/v1/webauthn/credentials/:id',async(req,reply)=>{
    const n=(await c.store.db.prepare('UPDATE webauthn_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(),req.params.id)).changes;
    if(!n)return reply.code(404).send({error:{code:'not_found'}});
    return {data:{status:'revoked'}};
  });
  const weakConfig=(c.config as typeof c.config & {weak?:{enabled:boolean;ttl_seconds:number;max_attempts:number}}).weak;
  const weak=new WeakConsent(c.store,weakConfig?.enabled??false,(weakConfig?.ttl_seconds??120)*1000,weakConfig?.max_attempts??3);
  app.post<{Params:{id:string}}>('/api/v1/profile-tokens/:id/consent-credential',async(req,reply)=>{
    if(!weak.enabled)return reply.code(403).send({error:{code:'weak_disabled'}});
    const credential=await weak.issue(req.params.id);
    if(!credential)return reply.code(404).send({error:{code:'not_found'}});
    return reply.header('Cache-Control','no-store').send({data:{credential}});
  });
}

export function registerWeakConsentRoutes(app:FastifyInstance,c:WebAuthnConsent):void {
  const weakConfig=c.config.weak;
  const weak=new WeakConsent(c.store,weakConfig?.enabled??false,(weakConfig?.ttl_seconds??120)*1000,weakConfig?.max_attempts??3,(event,latency)=>c.event(event,latency,"weak"));
  app.post<{Params:{id:string};Body:{credential?:string}}>('/api/v1/consent/weak/:id/approve',{config:{rateLimit:{max:c.config.rate_limit_per_minute,timeWindow:'1 minute'}}},async(req,reply)=>{
    if(!weak.enabled)return reply.code(403).send({error:{code:'weak_disabled'}});
    const bearer=req.headers.authorization;
    const token=typeof bearer==='string' && bearer.startsWith('Bearer ') ? await c.store.db.prepare('SELECT id FROM profile_tokens WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').get(hash(bearer.slice(7)),Date.now()) as {id:string}|undefined : undefined;
    const row=await c.store.get(req.params.id);
    if(token && row && row.token_id!==token.id)c.event('binding_refused',undefined,'weak');
    if(!token || !row || row.token_id!==token.id)return reply.code(401).send({error:{code:'unauthorized'}});
    if(row?.status==='rejected' && row.consent_attempts>=weak.maxAttempts)return reply.code(429).send({error:{code:'attempts_exhausted'}});
    if(!await weak.approve(req.params.id,typeof req.body?.credential==='string'?req.body.credential:'')){
      const locked=await c.store.get(req.params.id);
      if(locked?.status==='rejected' && locked.consent_attempts>=weak.maxAttempts)return reply.code(429).send({error:{code:'attempts_exhausted'}});
      return reply.code(409).send({error:{code:'not_pending'}});
    }
    return {data:{status:'approved'}};
  });
}
