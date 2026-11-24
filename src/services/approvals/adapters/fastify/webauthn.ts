import { decodeAttestationObject, convertCertBufferToPEM, validateCertificatePath } from '@simplewebauthn/server/helpers';
import { verifyAuthenticationResponse, verifyRegistrationResponse, generateRegistrationOptions, type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ConsentStore, type Credential } from '../../consent/store.js';
import { isPostgres } from '../../../database/base.js';
/** Rolls back an approval whose credential counter or revocation changed under it. */
class CounterRaced extends Error {}
export interface ConsentConfig { enabled:boolean; rp_id?:string; origin?:string; max_attempts:number; rate_limit_per_minute:number; hardware_roots?:string[]; weak?:{enabled:boolean;ttl_seconds:number;max_attempts:number}; }
/** Minimum spacing between counter_raced events, so a burst of losers is one signal. */
const RACE_EVENT_INTERVAL_MS=10_000;
export class WebAuthnConsent {
  private lastRaceEvent=-Infinity;
  private raced(now:number):void {
    if(now-this.lastRaceEvent<RACE_EVENT_INTERVAL_MS)return;
    this.lastRaceEvent=now;this.event('counter_raced');
  }
  constructor(readonly store:ConsentStore,readonly config:ConsentConfig, readonly event:(event:string,latency?:number,level?:"weak"|"strong")=>void=()=>{}) {}
  private trustPolicy():string|undefined {
    const roots=this.config.hardware_roots;
    return roots?.length ? createHash('sha256').update(JSON.stringify(roots)).digest('hex') : undefined;
  }
  private async trustedCredentials() {
    const policy=this.trustPolicy();
    return policy ? (await this.store.credentials()).filter(c=>c.trust_policy===policy) : [];
  }
  private binding():{rp:string;origin:string} {
    if(!this.config.enabled || !this.config.rp_id || !this.config.origin) throw new Error('disabled');
    return {rp:this.config.rp_id,origin:this.config.origin};
  }
  async options(link:string,now=Date.now()) {
    const {rp}=this.binding(); const r=await this.store.lookup(link,now); if(!r) throw new Error('not_found');
    const challenge=createHash('sha256').update(r.op_digest!).update(Buffer.from([0])).update(randomBytes(32)).digest('base64url');
    const id=randomUUID();
    await this.store.db.prepare('DELETE FROM consent_challenges WHERE expires_at<=? OR used_at IS NOT NULL').run(now);
    await this.store.challenge(id,r.id,challenge,'assert',Math.min(r.expires_at,now+120000));
    return {id,challenge,rpId:rp,userVerification:'required',timeout:120000,allowCredentials:(await this.trustedCredentials()).map(c=>({id:c.id,type:'public-key'}))};
  }
  async verify(link:string,id:string,response:AuthenticationResponseJSON,now=Date.now()):Promise<boolean> {
    const {rp,origin}=this.binding(); const r=await this.store.lookup(link,now); if(!r) return false;
    try {
      const c=(await this.trustedCredentials()).find(c=>c.id===response.id); if(!c) throw new Error('bad_assertion');
      const result=await verifyAuthenticationResponse({response,expectedOrigin:origin,expectedRPID:rp,requireUserVerification:true,
        expectedChallenge:async challenge=>await this.store.takeChallenge(id,r.id,challenge,'assert',now),
        credential:{id:c.id,publicKey:new Uint8Array(c.public_key),counter:0}});
      if(!result.verified || result.authenticationInfo.credentialBackedUp || result.authenticationInfo.credentialDeviceType!=='singleDevice') throw new Error('bad_assertion');
      // Postgres runs READ COMMITTED: lock the credential row (FOR UPDATE) so two
      // approvals can never both accept the same next counter, and a revocation
      // that commits first is seen. The counter write is conditional and must
      // change exactly one row, otherwise the approval rolls back with it.
      const lock=isPostgres(this.store.db)?' FOR UPDATE':'';
      try { return await this.store.db.transaction(async ()=>{
        const current=await this.store.db.prepare(`SELECT * FROM webauthn_credentials WHERE id=? AND revoked_at IS NULL AND trust_policy=?${lock}`).get(c.id,this.trustPolicy() ?? null) as Credential|undefined;
        if(!current) return false;
        if(result.authenticationInfo.newCounter<=current.sign_count) {
          // It was fresh at our pre-verification read, but another submit
          // advanced the counter while this assertion was in flight. Refuse
          // this approval without revoking the legitimate credential.
          if(result.authenticationInfo.newCounter>c.sign_count){this.raced(now);return false;}
          await this.store.db.prepare('UPDATE webauthn_credentials SET revoked_at=? WHERE id=?').run(now,c.id);
          this.event('clone_suspected');
          return false;
        }
        const fresh=await this.store.lookup(link,Date.now()); if(!fresh || fresh.op_digest!==r.op_digest) return false;
        const ok=(await this.store.db.prepare("UPDATE pending_approvals SET status='approved',approved_at=?,approved_by='webauthn',consent_method='webauthn',link_used_at=? WHERE id=? AND status='pending' AND expires_at>? AND op_digest=? AND link_used_at IS NULL").run(now,now,r.id,Date.now(),r.op_digest)).changes===1;
        if(!ok) return false;
        const counted=(await this.store.db.prepare('UPDATE webauthn_credentials SET sign_count=?,last_used_at=? WHERE id=? AND revoked_at IS NULL AND sign_count<?').run(result.authenticationInfo.newCounter,now,c.id,result.authenticationInfo.newCounter)).changes===1;
        if(!counted) throw new CounterRaced();
        this.event('assertion_ok');this.event('approved',(now-r.requested_at)/1000);
        return true;
      }).immediate(); } catch(e) { if(e instanceof CounterRaced){this.raced(now);return false;} throw e; }
    } catch { await this.store.bad(r.id,now,this.config.max_attempts);this.event('assertion_bad');if((await this.store.get(r.id))?.status==='rejected'){this.event('attempts_exhausted');this.event('rejected');}return false; }
  }
  async registrationOptions(actor:string) {
    const {rp}=this.binding(); const id=randomUUID();
    if(!this.trustPolicy())throw new Error('hardware_trust_unconfigured');
    const options=await generateRegistrationOptions({rpName:'Splicedock consent',rpID:rp,userName:actor,userID:new TextEncoder().encode('splicedock-operator'),attestationType:'direct',authenticatorSelection:{authenticatorAttachment:'cross-platform',userVerification:'required',residentKey:'discouraged'},excludeCredentials:(await this.trustedCredentials()).map(c=>({id:c.id}))});
    await this.store.challenge(id,actor,options.challenge,'register',Date.now()+120000);
    return {id,...options};
  }
  async register(actor:string,id:string,label:string,response:RegistrationResponseJSON):Promise<boolean> {
    const {rp,origin}=this.binding();
    try {
      const policy=this.trustPolicy();
      if(!policy)return false;
      const att=decodeAttestationObject(Buffer.from(response.response.attestationObject,'base64url'));
      // Only manufacturer full packed attestation is supported. Self/none never suffice.
      const chain=att.get('attStmt').get('x5c');
      if(att.get('fmt')!=='packed' || !chain?.length)return false;
      await validateCertificatePath(chain.map(convertCertBufferToPEM),this.config.hardware_roots!);
      const v=await verifyRegistrationResponse({response,expectedRPID:rp,expectedOrigin:origin,requireUserVerification:true,expectedChallenge:async c=>await this.store.takeChallenge(id,actor,c,'register',Date.now())});
      const info=v.registrationInfo;
      if(!v.verified || !info || info.credentialBackedUp || info.credentialDeviceType!=='singleDevice' || response.authenticatorAttachment!=='cross-platform' || info.credential.counter<1) return false;
      await this.store.db.prepare('INSERT INTO webauthn_credentials(id,public_key,sign_count,label,created_at,trust_policy) VALUES(?,?,?,?,?,?)').run(info.credential.id,Buffer.from(info.credential.publicKey),info.credential.counter,label,Date.now(),policy);
      return true;
    } catch {return false;}
  }
}
