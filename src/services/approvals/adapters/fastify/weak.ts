import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ConsentStore, hash } from '../../consent-store.js';
import { isPostgres } from '../../../database/base.js';
/** Thrown inside the approval transaction to roll back a lost credential race. */
class CredentialConsumed extends Error {}
/** Hook consent; disabled by default and never executes an operation. */
export class WeakConsent {
  constructor(readonly store:ConsentStore, readonly enabled=false, readonly ttlMs=120000, readonly maxAttempts=3,readonly event:(event:string,latency?:number)=>void=()=>{}) {}
  async issue(tokenId:string,now=Date.now()):Promise<string|undefined> {
    if(!this.enabled)return undefined;
    const token=await this.store.db.prepare('SELECT id FROM profile_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?').get(tokenId,now);
    if(!token)return undefined;
    const secret=randomBytes(32).toString('base64url');
    await this.store.db.prepare('INSERT INTO consent_credentials(token_id,secret_hash,created_at) VALUES(?,?,?) ON CONFLICT(token_id) DO UPDATE SET secret_hash=excluded.secret_hash,rotated_at=excluded.created_at,revoked_at=NULL').run(tokenId,hash(secret),now);
    return secret;
  }
  async approve(id:string,credential:string,now=Date.now()):Promise<boolean> {
    if(!this.enabled)return false;
    // One credential approves at most one request. On Postgres (several replicas,
    // READ COMMITTED) the credential row is locked with FOR UPDATE, so a second
    // approval waits and then sees it revoked; on SQLite BEGIN IMMEDIATE takes the
    // write lock first. The revoke is also conditional, and a lost race rolls back.
    const lock=isPostgres(this.store.db)?' FOR UPDATE':'';
    try { return await this.store.db.transaction(async ()=>{
      const r=await this.store.get(id);
      if(!r || r.level!=='weak' || r.status!=='pending' || r.expires_at<=now || r.requested_at+this.ttlMs<=now)return false;
      const saved=await this.store.db.prepare(`SELECT secret_hash FROM consent_credentials WHERE token_id=? AND revoked_at IS NULL AND COALESCE(rotated_at,created_at)>?${lock}`).get(r.token_id,now-this.ttlMs) as {secret_hash:string}|undefined;
      if(!saved || !timingSafeEqual(Buffer.from(hash(credential),'hex'),Buffer.from(saved.secret_hash,'hex'))) {await this.store.bad(id,now,this.maxAttempts);this.event('assertion_bad');if((await this.store.get(id))?.status==='rejected'){this.event('attempts_exhausted');this.event('rejected');}return false;}
      const ok=(await this.store.db.prepare("UPDATE pending_approvals SET status='approved',approved_at=?,approved_by='weak_credential',consent_method='weak_credential' WHERE id=? AND level='weak' AND status='pending' AND expires_at>?").run(now,id,now)).changes===1;
      if(!ok)return false;
      const consumed=(await this.store.db.prepare('UPDATE consent_credentials SET revoked_at=? WHERE token_id=? AND revoked_at IS NULL').run(now,r.token_id)).changes===1;
      if(!consumed)throw new CredentialConsumed();
      this.event('assertion_ok');this.event('approved',(now-r.requested_at)/1000);
      return true;
    }).immediate(); } catch(e) { if(e instanceof CredentialConsumed)return false; throw e; }
  }
}
