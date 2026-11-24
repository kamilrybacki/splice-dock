import { migrateApprovalBroker } from '../broker/schema.js';
import type { SqlDb } from '../../database/base.js';
import { createHash, randomBytes } from 'node:crypto';
import { opDigest } from '../../policy/operation.js';
import { migrateApprovalConsent } from './schema.js';
export const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
export interface ConsentRow {
  id:string; tool:string; argv_json:string; cwd:string|null; profile:string; token_id:string;
  reserved_at:number|null; expires_at:number; requested_at:number; status:string; level:'weak'|'strong'; op_digest:string|null;
  link_token_hash:string|null; link_expires_at:number|null; link_used_at:number|null; consent_attempts:number;
}
export interface Credential {id:string; public_key:Buffer; sign_count:number; label:string; revoked_at:number|null;trust_policy:string|null}
export class ConsentStore {
  /** The schema must already be migrated: SplicedockStore.open does that
   *  (and pg-schema on Postgres). Use ConsentStore.open for a bare database. */
  constructor(readonly db: SqlDb, readonly event:(event:string)=>void=()=>{}) {}
  static async open(db: SqlDb, event:(event:string)=>void=()=>{}): Promise<ConsentStore> {
    await migrateApprovalConsent(db); await migrateApprovalBroker(db);
    return new ConsentStore(db, event);
  }
  async get(id:string):Promise<ConsentRow|undefined> {return await this.db.prepare('SELECT * FROM pending_approvals WHERE id=?').get(id) as ConsentRow|undefined;}
  digest(r:ConsentRow):string {return opDigest({tool:r.tool,argv:JSON.parse(r.argv_json),cwd:r.cwd,profile:r.profile,tokenId:r.token_id},Math.floor(r.expires_at/1000),r.level,r.id);}
  async bind(id:string,ttlMs=600000):Promise<string> {
    const link=randomBytes(32).toString('base64url');
    await this.db.transaction(async ()=>{
      const r=await this.get(id); if(!r || r.status!=='pending' || !r.token_id || r.token_id==='legacy-query') throw new Error('binding_refused');
      r.level='strong';
      await this.db.prepare("UPDATE pending_approvals SET level='strong',op_digest=?,link_token_hash=?,link_expires_at=? WHERE id=? AND status='pending'").run(this.digest(r),hash(link),Math.min(r.expires_at,Date.now()+ttlMs),id);
    })();
    return link;
  }
  async lookup(link:string,now:number):Promise<ConsentRow|undefined> {
    const r=await this.db.prepare("SELECT * FROM pending_approvals WHERE link_token_hash=? AND link_used_at IS NULL AND link_expires_at>? AND expires_at>? AND status='pending' AND level='strong'").get(hash(link),now,now) as ConsentRow|undefined;
    if(!r)return undefined;
    if(this.digest(r)!==r.op_digest){this.event('binding_refused');return undefined;}
    return r;
  }
  async credentials():Promise<Credential[]> {return await this.db.prepare('SELECT * FROM webauthn_credentials WHERE revoked_at IS NULL').all() as Credential[];}
  async challenge(id:string,approval:string,challenge:string,purpose:string,expires:number):Promise<void> {
    await this.db.prepare('INSERT INTO consent_challenges(id,approval_id,challenge_hash,purpose,expires_at) VALUES(?,?,?,?,?)').run(id,approval,hash(challenge),purpose,expires);
  }
  async takeChallenge(id:string,approval:string,challenge:string,purpose:string,now:number):Promise<boolean> {
    return (await this.db.prepare('UPDATE consent_challenges SET used_at=? WHERE id=? AND approval_id=? AND challenge_hash=? AND purpose=? AND expires_at>? AND used_at IS NULL').run(now,id,approval,hash(challenge),purpose,now)).changes===1;
  }
  async reject(link:string,now:number):Promise<boolean> {
    return (await this.db.prepare("UPDATE pending_approvals SET status='rejected',link_used_at=? WHERE link_token_hash=? AND status='pending' AND expires_at>? AND link_used_at IS NULL").run(now,hash(link),now)).changes===1;
  }
  async bad(id:string,now:number,max:number):Promise<void> {
    await this.db.prepare("UPDATE pending_approvals SET consent_attempts=consent_attempts+1,status=CASE WHEN consent_attempts+1>=? THEN 'rejected' ELSE status END,rejected_reason=CASE WHEN consent_attempts+1>=? THEN 'attempts_exhausted' ELSE rejected_reason END WHERE id=? AND status='pending' AND expires_at>?").run(max,max,id,now);
  }
}
