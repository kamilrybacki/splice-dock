import {breakerReadonly} from './readonly.js';
import {migrateBreakerState} from './schema.js';
import { isPostgres, type SqlDb } from '../../database/base.js';
import {createHash} from 'node:crypto';
import type {SplicedockConfig} from '../../../config/types.js';
import type {CallerIdentity} from '../../../common/request/context.js';
type Config=SplicedockConfig['server']['breaker'];
type Row={scope:string; family:string; state:string; opened_at:number; cooldown_until:number; trip_count:number; window_at:number; denials:number; probes:number};
/** Every read-modify-write runs in one transaction that owns the scope row:
 * SQLite serializes writers with BEGIN IMMEDIATE; on Postgres (several
 * replicas, READ COMMITTED) the row is taken with SELECT ... FOR UPDATE and
 * created with an upsert that also locks it. Counters saturate and no argv is retained. */
export class CircuitBreaker {
 /** The constructor does no I/O; create() migrates the breaker tables first. */
 constructor(readonly db:SqlDb,readonly config:Config,readonly event:(event:string,family:string,state?:string)=>void=()=>{}){}
 static async create(db:SqlDb,config:Config,event:(event:string,family:string,state?:string)=>void=()=>{}):Promise<CircuitBreaker>{
 await migrateBreakerState(db);
 return new CircuitBreaker(db,config,event);
 }
 /** Row-lock suffixes. Empty on SQLite, where the IMMEDIATE transaction already holds the write lock. */
 private get forUpdate():string{return isPostgres(this.db)?' FOR UPDATE':'';}
 private get skipLocked():string{return isPostgres(this.db)?' FOR UPDATE SKIP LOCKED':'';}
 private scopes(c?:CallerIdentity):[string,string][] {return this.config.scopes.flatMap(s=>s==='global'?[[s,s] as [string,string]]:s==='token'?(c?.authenticated?[[`token:${createHash('sha256').update(JSON.stringify([c.profile,c.tokenId])).digest('hex')}`,'token'] as [string,string]]:[]):s===`profile:${c?.profile}`?[[s,s] as [string,string]]:[]);}
 async list():Promise<Row[]>{return await this.db.prepare('SELECT * FROM breaker_state ORDER BY scope LIMIT 4096').all() as Row[];}
 private async row(scope:string,family:string,now:number):Promise<Row> {
 // Delete only expired closed scopes; active states are never evicted to bypass enforcement.
 // Eviction is best effort: rows another replica holds are skipped, never waited on.
 await this.db.prepare(`DELETE FROM breaker_buckets WHERE (scope,second) IN (SELECT scope,second FROM breaker_buckets WHERE second<=? LIMIT 32${this.skipLocked})`).run(Math.floor(now/1000)-this.config.window_seconds);
 await this.db.prepare(`DELETE FROM breaker_state WHERE scope IN (SELECT scope FROM breaker_state WHERE state='closed' AND window_at<? LIMIT 32${this.skipLocked})`).run(now-this.config.window_seconds*2000);
 const row=await this.db.prepare(`SELECT * FROM breaker_state WHERE scope=?${this.forUpdate}`).get(scope) as Row|undefined;
 if(row)return row;
 const n=(await this.db.prepare('SELECT count(*) AS n FROM breaker_state').get() as {n:number}).n;
 if(n>=4096)throw new Error('breaker_capacity'); // Fail closed; cannot evict another caller.
 // A concurrent replica may create the same scope first: the no-op DO UPDATE
 // waits for it, then returns (and locks) the committed row instead of failing.
 return await this.db.prepare('INSERT INTO breaker_state(scope,family,window_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET scope=excluded.scope RETURNING *').get(scope,family,now) as Row;
 }
 private async transition(r:Row,state:string,now:number,actor='automatic'){
 r.state=state;r.probes=0;r.denials=0;r.window_at=now;
 if(state==='open'){r.opened_at=now;r.cooldown_until=now+this.config.cooldown_seconds*1000;r.trip_count++;}
 await this.db.prepare('DELETE FROM breaker_buckets WHERE scope=?').run(r.scope);
 await this.db.prepare('DELETE FROM breaker_probe_ids WHERE scope=?').run(r.scope);
 await this.db.prepare('INSERT INTO breaker_audit(ts,scope,event,actor) VALUES(?,?,?,?)').run(now,r.scope,state,actor);
 await this.db.prepare('DELETE FROM breaker_audit WHERE id <= (SELECT coalesce(max(id),0)-10000 FROM breaker_audit)').run();
 this.event(this.config.mode==='observe'&&state==='open'?'would_trip':'transition',r.family,state);
 }
 private async save(r:Row){await this.db.prepare('UPDATE breaker_state SET state=@state,opened_at=@opened_at,cooldown_until=@cooldown_until,trip_count=@trip_count,window_at=@window_at,denials=@denials,probes=@probes WHERE scope=@scope').run(r);}
 private async recordUnsafe(c:CallerIdentity|undefined,denied:boolean,now=Date.now()):Promise<void>{
 if(!this.config.enabled)return;
 await this.db.transaction(async ()=>{for(const [s,f] of this.scopes(c)){
 const r=await this.row(s,f,now);
 if(r.state==='open'&&now>=r.cooldown_until)await this.transition(r,'half_open',now);
 if(r.state==='half_open'&&denied)await this.transition(r,'open',now);
 else if(r.state==='closed'){
 r.window_at=now;
 const second=Math.floor(now/1000);
 await this.db.prepare('DELETE FROM breaker_buckets WHERE scope=? AND second<=?').run(s,second-this.config.window_seconds);
 if(denied)await this.db.prepare('INSERT INTO breaker_buckets(scope,second,n) VALUES(?,?,1) ON CONFLICT(scope,second) DO UPDATE SET n=CASE WHEN breaker_buckets.n+1<? THEN breaker_buckets.n+1 ELSE ? END').run(s,second,this.config.deny_threshold,this.config.deny_threshold);
 r.denials=(await this.db.prepare('SELECT coalesce(sum(n),0) AS n FROM breaker_buckets WHERE scope=?').get(s) as {n:number}).n;
 if(r.denials>=this.config.deny_threshold)await this.transition(r,'open',now);
 }
 await this.save(r);
 }}).immediate();
 }
 private async forceUnsafe(c:CallerIdentity|undefined,tool:string,argv:readonly string[],now=Date.now()):Promise<boolean>{
 if(!this.config.enabled)return false;
 let active=false;
 await this.db.transaction(async ()=>{for(const [s,f] of this.scopes(c)){
 const r=await this.row(s,f,now);
 if(r.state==='open'&&now>=r.cooldown_until)await this.transition(r,'half_open',now);
 if(r.state==='half_open'&&now-r.window_at>=this.config.window_seconds*1000&&r.probes>=this.config.half_open_probes)await this.transition(r,'closed',now);
 if(r.state!=='closed')active=true;
 await this.save(r);
 }}).immediate();
 const force=active&&this.config.mode==='enforce'&&!this.config.read_allowlist.some(a=>breakerReadonly(a.tool,a.argv)&&a.tool===tool&&JSON.stringify(a.argv)===JSON.stringify(argv));
 if(force)this.event('forced','configured');
 return force;
 }
 /** Recovery authority comes from the persisted, consumed WebAuthn row,
  * never from a caller-supplied strength flag. Reservation already verified
  * the operation digest; also bind recovery accounting to that caller. */
 async recoveryEligible(c:CallerIdentity|undefined,approvalId:string):Promise<boolean> {
 if(!c?.authenticated)return false;
 return !!await this.db.prepare("SELECT 1 FROM pending_approvals WHERE id=? AND level='strong' AND consent_method='webauthn' AND status='consumed' AND consumed_at IS NOT NULL AND kind='passthrough' AND profile=? AND token_id=?").get(approvalId,c.profile,c.tokenId);
 }
 // A recovery probe is one distinct strong approval consumed while half-open. The
 // (scope,approval_id) ledger makes the count idempotent per approval, so a
 // consent replayed after a released reservation can never count twice; the
 // ledger is cleared on every transition, so ids never carry across windows.
 private async approvedUnsafe(c:CallerIdentity|undefined,approvalId:string){await this.db.transaction(async ()=>{
 if(!await this.recoveryEligible(c,approvalId))return;
 for(const [s] of this.scopes(c)){
 const r=await this.db.prepare(`SELECT probes FROM breaker_state WHERE scope=? AND state='half_open'${this.forUpdate}`).get(s) as {probes:number}|undefined;
 if(!r||r.probes>=this.config.half_open_probes)continue;
 if((await this.db.prepare('INSERT INTO breaker_probe_ids(scope,approval_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(s,approvalId)).changes>0)await this.db.prepare('UPDATE breaker_state SET probes=probes+1 WHERE scope=?').run(s);
 }}).immediate();}
 private async guard<T>(fallback:T,fn:()=>Promise<T>):Promise<T> {try{return await fn();}catch(error){try{this.event('storage_error','configured');}catch{/* telemetry cannot affect authorization */}if(this.config.mode==='enforce')throw error;return fallback;}}
 async securityDenial(c:CallerIdentity|undefined):Promise<void> {if(c?.authenticated)await this.record(c,true);}
 async record(c:CallerIdentity|undefined,denied:boolean,now=Date.now()):Promise<void> {await this.guard(undefined,()=>this.recordUnsafe(c,denied,now));}
 async force(c:CallerIdentity|undefined,tool:string,argv:readonly string[],now=Date.now()):Promise<boolean> {return await this.guard(false,()=>this.forceUnsafe(c,tool,argv,now));}
 /** Count a recovery probe for an approval that was irreversibly consumed
  *  (never for a reservation, which may still be released). */
 async approved(c:CallerIdentity|undefined,approvalId:string):Promise<void> {await this.guard(undefined,()=>this.approvedUnsafe(c,approvalId));}
 async control(scope:string,trip:boolean,actor:string,now=Date.now()):Promise<boolean>{return await this.db.transaction(async ()=>{const r=await this.db.prepare(`SELECT * FROM breaker_state WHERE scope=?${this.forUpdate}`).get(scope) as Row|undefined;if(!r)return false;await this.transition(r,trip?'open':'closed',now,actor);await this.save(r);return true;}).immediate();}
}
