import { isoCBOR } from '@simplewebauthn/server/helpers';
import { describe,it,expect } from 'vitest';
import { generateKeyPairSync,createHash,sign } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ConsentStore } from '../../../src/services/approvals/consent/store.js';
import { WebAuthnConsent } from '../../../src/services/approvals/adapters/fastify/webauthn.js';
import { registerConsentRoutes } from '../../../src/services/approvals/adapters/fastify/server.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
async function setup(trusted=true,event:(event:string,latency?:number)=>void=()=>{}) {
  const db=await SplicedockStore.open(':memory:');const store=await ConsentStore.open(db.consentDatabase(),event);
  const now=Date.now();
  await db.insertApproval({id:'op',tool:'repo_delete',argv_hash:'x',argv_json:JSON.stringify(['repo','delete','<script>\n']),rule:'approval_subcommands',matched:'delete',requested_at:now,expires_at:now+600000,profile:'p',token_id:'token-A',cwd:'/tmp'});
  const link=await store.bind('op');
  const c=new WebAuthnConsent(store,{enabled:true,rp_id:'example.com',origin:'https://example.com',max_attempts:3,rate_limit_per_minute:10,hardware_roots:["test-policy-only"]},event);
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=keys.publicKey.export({format:'jwk'});
  // A COSE EC2 ES256 fixture; no production CBOR implementation lives here.
  const cose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(jwk.x!,'base64url'),Buffer.from('225820','hex'),Buffer.from(jwk.y!,'base64url')]);
  const id=Buffer.from('fixture-credential').toString('base64url');
  await store.db.prepare('INSERT INTO webauthn_credentials(id,public_key,sign_count,label,created_at) VALUES(?,?,1,?,?)').run(id,cose,'test',now);
  if(trusted)await store.db.prepare('UPDATE webauthn_credentials SET trust_policy=?').run(createHash('sha256').update(JSON.stringify(['test-policy-only'])).digest('hex'));
  const assertion=(challenge:string,counter=2,origin='https://example.com',rp='example.com',flags=5):AuthenticationResponseJSON=>{
    const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin}));
    const count=Buffer.alloc(4);count.writeUInt32BE(counter);
    const auth=Buffer.concat([createHash('sha256').update(rp).digest(),Buffer.from([flags]),count]);
    const signature=sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),keys.privateKey);
    return {id,rawId:id,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),authenticatorData:auth.toString('base64url'),signature:signature.toString('base64url')}};
  };
  return {db,store,c,link,assertion};
}
describe('real signed WebAuthn operation consent',()=>{
  it('verifies a real signature once, then refuses replay and used link',async()=>{
    const s=await setup();const o=await s.c.options(s.link);const a=s.assertion(o.challenge);
    expect(await s.c.verify(s.link,o.id,a)).toBe(true);
    expect(await s.c.verify(s.link,o.id,a)).toBe(false);
    expect(await s.store.lookup(s.link,Date.now())).toBeUndefined();await s.db.close();
  });
  it.each(['origin','rp','uv','challenge','signature','mutation','expiry','synced','backup'])('refuses %s',async mode=>{
    const s=await setup();const o=await s.c.options(s.link);
    const a=s.assertion(mode==='challenge'?'other':o.challenge,2,mode==='origin'?'https://evil.example':'https://example.com',mode==='rp'?'evil.example':'example.com',mode==='uv'?1:mode==='synced'?13:mode==='backup'?29:5);
    if(mode==='signature')a.response.signature=Buffer.alloc(72).toString('base64url');
    if(mode==='mutation')await s.store.db.prepare('UPDATE pending_approvals SET cwd=?').run('/other');
    if(mode==='expiry')await s.store.db.prepare('UPDATE consent_challenges SET expires_at=0').run();
    expect(await s.c.verify(s.link,o.id,a)).toBe(false);expect((await s.store.get('op'))?.status).toBe('pending');await s.db.close();
  });
  it('concurrent verifies have one winner',async()=>{const s=await setup();const a=await s.c.options(s.link);const b=await s.c.options(s.link);const result=await Promise.all([s.c.verify(s.link,a.id,s.assertion(a.challenge)),s.c.verify(s.link,b.id,s.assertion(b.challenge))]);expect(result.filter(Boolean)).toHaveLength(1);await s.db.close();});
  it('reject wins against an in-flight verification',async()=>{const s=await setup();const a=await s.c.options(s.link);const verify=s.c.verify(s.link,a.id,s.assertion(a.challenge));await s.store.reject(s.link,Date.now());expect(await verify).toBe(false);expect((await s.store.get('op'))?.status).toBe('rejected');await s.db.close();});
  it('refuses forged registration',async()=>{const s=await setup();const options=await s.c.registrationOptions('admin');expect(options.authenticatorSelection?.userVerification).toBe('required');expect(await s.c.register('admin',options.id,'test',{} as never)).toBe(false);await s.db.close();});
  it('revokes a regressed counter' ,async()=>{const s=await setup();const o=await s.c.options(s.link);expect(await s.c.verify(s.link,o.id,s.assertion(o.challenge,1))).toBe(false);expect(await s.store.credentials()).toHaveLength(0);await s.db.close();});
  it('three failed assertions lock pending approval',async()=>{const s=await setup();for(let i=0;i<3;i++){const o=await s.c.options(s.link);await s.c.verify(s.link,o.id,s.assertion('wrong'));}expect((await s.store.get('op'))?.status).toBe('rejected');await s.db.close();});
  it('GET preview is read only, escapes page content and rate limits unknown links',async()=>{
    const s=await setup();const app=Fastify();await app.register(rateLimit);registerConsentRoutes(app,s.c);
    for(let i=0;i<2;i++){const r=await app.inject(`/consent/${s.link}`);expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.headers['referrer-policy']).toBe('no-referrer');expect(r.body).toContain('&lt;script&gt;');expect(r.body).toContain('\\n');}
    expect((await s.store.get('op'))?.link_used_at).toBeNull();
    expect(JSON.stringify(await s.store.get('op'))).not.toContain(s.link);
    let limited=0;for(let i=0;i<20;i++){if((await app.inject('/consent/unknown')).statusCode===429)limited++;}expect(limited).toBeGreaterThan(0);
    await app.close();await s.db.close();
  });
  it('reject consumes link without executing, and kill switch refuses options',async ()=>{const s=await setup();expect(await s.store.reject(s.link,Date.now())).toBe(true);expect(await s.store.lookup(s.link,Date.now())).toBeUndefined();s.c.config.enabled=false;await expect(async ()=>await s.c.options(s.link)).rejects.toThrow('disabled');await s.db.close();});
});

it('legacy unattested credential cannot approve',async()=>{const s=await setup(false);const o=await s.c.options(s.link);expect(await s.c.verify(s.link,o.id,s.assertion(o.challenge))).toBe(false);await s.db.close();});

it.each(['none','self','untrusted'])('rejects %s attestation without enrolling',async kind=>{
 const s=await setup();const o=await s.c.registrationOptions('admin');
 const attStmt=new Map<string,string|number|Uint8Array|Uint8Array[]>();
 if(kind!=='none'){attStmt.set('alg',-7);attStmt.set('sig',new Uint8Array(64));}
 if(kind==='untrusted')attStmt.set('x5c',[new Uint8Array([1,2,3])]);
 const encoded=isoCBOR.encode(new Map([['fmt',kind==='none'?'none':'packed'],['attStmt',attStmt],['authData',new Uint8Array(128)]] as never));
 const response={id:'new',rawId:'new',type:'public-key',authenticatorAttachment:'cross-platform',response:{attestationObject:Buffer.from(encoded).toString('base64url'),clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge:o.challenge,origin:'https://example.com'})).toString('base64url')},clientExtensionResults:{}};
 expect(await s.c.register('admin',o.id,'test',response as never)).toBe(false);
 expect(await s.store.credentials()).toHaveLength(1);await s.db.close();
});
it('missing trust and changed trust never authorize existing credentials',async()=>{
 const s=await setup();const o=await s.c.options(s.link);s.c.config.hardware_roots=[];
 expect(await s.c.verify(s.link,o.id,s.assertion(o.challenge))).toBe(false);
 await expect(s.c.registrationOptions('admin')).rejects.toThrow('hardware_trust_unconfigured');
 s.c.config.hardware_roots=['different-policy'];expect((await s.c.options(s.link)).allowCredentials).toHaveLength(0);await s.db.close();
});

it('emits assertion, lockout, approval latency and binding metrics',async()=>{
 const events:{event:string;latency?:number}[]=[];const record=(event:string,latency?:number)=>events.push({event,latency});
 const s=await setup(true,record);const o=await s.c.options(s.link);expect(await s.c.verify(s.link,o.id,s.assertion(o.challenge))).toBe(true);
 expect(events.map(x=>x.event)).toEqual(['assertion_ok','approved']);expect(events[1].latency).toBeGreaterThanOrEqual(0);await s.db.close();
 const b=await setup(true,record);events.length=0;for(let i=0;i<3;i++){const o=await b.c.options(b.link);await b.c.verify(b.link,o.id,b.assertion('wrong'));}
 expect(events.map(x=>x.event)).toEqual(['assertion_bad','assertion_bad','assertion_bad','attempts_exhausted','rejected']);await b.db.close();
 const m=await setup(true,record);events.length=0;await m.store.db.prepare('UPDATE pending_approvals SET cwd=?').run('/mutated');expect(await m.store.lookup(m.link,Date.now())).toBeUndefined();expect(events.map(x=>x.event)).toEqual(['binding_refused']);await m.db.close();
});

import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
// Cryptographically valid synthetic manufacturer fixtures, NEVER production roots.
it.each([true,false])('full packed enrollment trust path: trusted=%s',async trusted=>{
 const s=await setup();
 const fixture=(name:string)=>readFileSync(new URL(`../../fixtures/attestation-only/${name}`,import.meta.url));
 const root=fixture('root.pem').toString();
 // For the untrusted case, use an unrelated but valid self-signed root.
 s.c.config.hardware_roots=[trusted?root:fixture('unrelated.pem').toString()];
 const o=await s.c.registrationOptions('admin');
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=keys.publicKey.export({format:'jwk'});
 const cose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(jwk.x!,'base64url'),Buffer.from('225820','hex'),Buffer.from(jwk.y!,'base64url')]);
 const credential=Buffer.from('enrollment-fixture');const length=Buffer.alloc(2);length.writeUInt16BE(credential.length);
 const counter=Buffer.alloc(4);counter.writeUInt32BE(1);
 const auth=Buffer.concat([createHash('sha256').update('example.com').digest(),Buffer.from([0x45]),counter,Buffer.alloc(16),length,credential,cose]);
 const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:o.challenge,origin:'https://example.com'}));
 const signature=sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),fixture('leaf-key.pem'));
 const stmt=new Map<string,unknown>([['alg',-7],['sig',signature],['x5c',[new X509Certificate(fixture('leaf.pem')).raw]]]);
 const encoded=isoCBOR.encode(new Map<string,unknown>([['fmt','packed'],['attStmt',stmt],['authData',auth]]) as never);
 const id=credential.toString('base64url');
 const response={id,rawId:id,type:'public-key',authenticatorAttachment:'cross-platform',clientExtensionResults:{},response:{attestationObject:Buffer.from(encoded).toString('base64url'),clientDataJSON:client.toString('base64url'),transports:['usb']}};
 expect(await s.c.register('admin',o.id,'fixture ONLY',response as never)).toBe(trusted);
 expect((await s.store.credentials()).some(c=>c.id===id)).toBe(trusted);
 await s.db.close();
});
