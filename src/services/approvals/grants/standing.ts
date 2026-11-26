import type { SqlDb } from '../../database/base.js';
import { createHash, randomUUID } from 'node:crypto';
import { baseShapeKey, type OperationShape } from '../../policy/shape/base.js';
import { NO_SHAPES, type ShapeRegistry } from '../../policy/shape/registry.js';
import { contextEscalates, escalationComparer } from '../../policy/context/escalation.js';
import { logger } from '../../../common/logger.js';
import { grantNamePrefix } from './name-prefix.js';
const WEEK=7*86400000;
/** ADR 0009: a grant lives three days and covers at most twenty operations. */
export const GRANT_TTL=3*86400000;
export const GRANT_USE_MAX=20;
export interface GrantRow extends Omit<OperationShape, 'flags_allowed'> {
  id:string; flags_allowed:string; created_at:number; expires_at:number; revoked_at:number|null;
  suspended_at:number|null; name_prefix:string|null; use_count:number; use_count_max:number; last_used_at:number|null; context_refs:string;
}
interface ContextRow {id:string;approval_context:string;argv_json:string;}
import { isBuiltInGrantException, type GrantException } from '../../policy/grants/config.js';
export type { GrantException } from '../../policy/grants/config.js';
export class StandingGrants {
  /** Seeding the configured exceptions is async; it starts here and every
   *  exception read/write awaits it, so a caller never sees a half-seeded set. */
  private readonly seeded:Promise<void>;
  /** ADR 0010: exact namespaces grants may form and match in. Empty means none (default-deny). */
  private readonly namespaces:ReadonlySet<string>;
  constructor(private readonly db:SqlDb, readonly enabled:boolean, private readonly threshold:number, private readonly now:()=>number, configured:readonly GrantException[]|undefined=undefined, private readonly shapes:ShapeRegistry=NO_SHAPES, namespaces:readonly string[]=[]) {
    this.namespaces=new Set(namespaces);
    this.seeded=this.seed(configured);
    this.seeded.catch(()=>{/* surfaced to the first caller that awaits it */});
  }
  private async seed(configured:readonly GrantException[]|undefined):Promise<void> {
    const {db,now}=this;
    if(this.enabled && configured !== undefined) {
      const key='exceptions_config:'+createHash('sha256').update(JSON.stringify(configured)).digest('hex');
      await db.transaction(async ()=>{
        if(await db.prepare('SELECT 1 FROM grant_settings WHERE key=?').get(key))return;
        await db.prepare("DELETE FROM grant_exceptions WHERE added_by='default' OR added_by='config'").run();
        for(const entry of configured)await db.prepare('INSERT OR IGNORE INTO grant_exceptions VALUES (?,?,?,?)').run(entry.tool,entry.verb_path ?? '*',now(),'config');
        await db.prepare("DELETE FROM grant_settings WHERE key LIKE 'exceptions_config:%'").run();
        await db.prepare('INSERT INTO grant_settings VALUES (?)').run(key);
      })();
    }
  }
  async exception(tool:string,verb:string,strong:boolean):Promise<boolean> {
    await this.seeded;
    return strong || isBuiltInGrantException(tool,verb) || !!await this.db.prepare("SELECT 1 FROM grant_exceptions WHERE tool=? AND verb_path IN (?, '*')").get(tool,verb);
  }
  async list():Promise<GrantRow[]> {return await this.db.prepare('SELECT * FROM standing_grants ORDER BY created_at DESC LIMIT 500').all() as GrantRow[];}
  async exceptions():Promise<GrantException[]>{await this.seeded;return await this.db.prepare('SELECT tool,verb_path FROM grant_exceptions').all() as GrantException[];}
  async setException(tool:string,verb:string,add:boolean,actor:string):Promise<void> {
    await this.seeded;
    if(add){await this.db.prepare('INSERT INTO grant_exceptions VALUES (?,?,?,?) ON CONFLICT(tool,verb_path) DO UPDATE SET added_at=excluded.added_at,added_by=excluded.added_by').run(tool,verb,this.now(),actor);await this.db.prepare("UPDATE standing_grants SET revoked_at=?,revoked_by=? WHERE tool=? AND (?='*' OR verb_path=?) AND revoked_at IS NULL").run(this.now(),actor,tool,verb,verb);}
    else await this.db.prepare('DELETE FROM grant_exceptions WHERE tool=? AND verb_path=?').run(tool,verb);
  }
  async revoke(id:string|undefined,actor:string):Promise<void> {
    await this.db.prepare(`UPDATE standing_grants SET revoked_at=?,revoked_by=? WHERE revoked_at IS NULL ${id?'AND id=?':''}`).run(this.now(),actor,...(id?[id]:[]));
  }
  private async blocked(key:string):Promise<boolean> {return !!await this.db.prepare('SELECT 1 FROM grant_blocks WHERE shape_key=? AND until>?').get(key,this.now());}
  /** Block key of a whole caller/tool/verb scope, written by ambiguous rejections. */
  private scopeKey(profile:string,tokenId:string,tool:string,verb:string):string {return JSON.stringify(['scope',profile,tokenId,tool,verb]);}
  private async refs(ids:string):Promise<ContextRow[]>{const out:ContextRow[]=[];for(const id of JSON.parse(ids) as string[]){const r=await this.db.prepare('SELECT id,approval_context FROM pending_approvals WHERE id=? AND approval_context IS NOT NULL').get(id) as ContextRow|undefined;if(r)out.push(r);}return out;}
  /** `names` are the bare object names of the request; a grant matches only when every one starts with its name_prefix. */
  async match(shape:OperationShape,context:string,names:readonly string[]):Promise<GrantRow|undefined> {
    if(!this.enabled || !context.trim() || !names.length || !this.namespaces.has(shape.namespace) || await this.blocked(baseShapeKey(shape)) || await this.blocked(this.scopeKey(shape.profile,shape.token_id,shape.tool,shape.verb_path)))return;
    const rows=await this.db.prepare('SELECT * FROM standing_grants WHERE tool=? AND verb_path=? AND profile=? AND token_id=? AND expires_at>? AND created_at>? AND revoked_at IS NULL AND suspended_at IS NULL AND use_count<use_count_max AND use_count<?').all(shape.tool,shape.verb_path,shape.profile,shape.token_id,this.now(),this.now()-GRANT_TTL,GRANT_USE_MAX) as GrantRow[];
    for(const r of rows){if(r.name_prefix===null || !names.every(name=>name.startsWith(r.name_prefix!)) || r.resource_kind!==shape.resource_kind || r.namespace!==shape.namespace || r.object_count_max!==shape.object_count_max || r.flags_allowed !== JSON.stringify(shape.flags_allowed))continue;
      // ADR 0009: the shape decides; context can only send the request back to a human.
      const refs=await this.refs(r.context_refs);
      // Grants promoted under ADR 0008 may rest on fewer approvals; they need fresh evidence.
      if(refs.length<this.threshold)continue;
      if(contextEscalates(context,refs.map(ref=>ref.approval_context))){logger.info('grant context escalated',{tool:shape.tool,grant_id:r.id});continue;}
      return r;
    }
  }
  /** Atomically consume one use of a matched grant. The WHERE clause rechecks
   *  quota, revocation, suspension and expiry against the row as committed when
   *  the update runs (on Postgres a blocked update re-evaluates it against the
   *  winner's row), so a concurrent use, revoke or suspend makes the claim fail. */
  async claim(id:string):Promise<boolean> {
    const now=this.now();
    const listed=[...this.namespaces];
    if(!listed.length)return false;
    // Defence in depth: legacy NULL-prefix grants and de-listed namespaces never claim, even for a stale match.
    return (await this.db.prepare(`UPDATE standing_grants SET use_count=use_count+1,last_used_at=? WHERE id=? AND name_prefix IS NOT NULL AND namespace IN (${listed.map(()=>'?').join(',')}) AND use_count<use_count_max AND use_count<? AND revoked_at IS NULL AND suspended_at IS NULL AND expires_at>? AND created_at>?`).run(now,id,...listed,GRANT_USE_MAX,now,now-GRANT_TTL)).changes===1;
  }
  private async lockScope(profile:string,tokenId:string,tool:string,verb:string):Promise<void> {
    await this.db.lockInTransaction(JSON.stringify(['standing_grant',profile,tokenId,tool,verb]));
  }
  async promote(id:string):Promise<void> {
    if(!this.enabled)return;
    const row=await this.db.prepare("SELECT * FROM pending_approvals WHERE id=? AND status='consumed' AND execution_success=1 AND grant_id IS NULL AND level!='strong'").get(id) as {shape_key:string|null;approval_context:string|null;tool:string;matched:string;profile:string;token_id:string}|undefined;
    if(!row?.shape_key || !row.approval_context?.trim() || !row.profile || !row.token_id || await this.exception(row.tool,row.matched,false))return;
    const shape=JSON.parse(row.shape_key) as OperationShape;
    if(!this.namespaces.has(shape.namespace)){logger.info('grant promotion skipped: namespace not in allowlist',{tool:row.tool,approval_id:id,namespace:shape.namespace});return;}
    // Serialise promotion against other promotions and rejections of the same
    // caller/tool/verb across replicas: without it two promotions both insert a
    // grant, and a rejection that commits between promote's block check and its
    // insert revokes nothing and leaves the new grant live.
    await this.lockScope(shape.profile,shape.token_id,shape.tool,shape.verb_path);
    const scopeKey=this.scopeKey(shape.profile,shape.token_id,shape.tool,shape.verb_path);
    if(await this.blocked(baseShapeKey(shape)) || await this.blocked(scopeKey))return;
    const until=this.db.prepare('SELECT until FROM grant_blocks WHERE shape_key=?');
    const block=await until.get(baseShapeKey(shape)) as {until:number}|undefined;
    const scopeBlock=await until.get(scopeKey) as {until:number}|undefined;
    // Identity-scoped queries use the lookup index and must never inherit the
    // admin listing's global pagination (which could renew an older quota).
    const identity='tool=? AND verb_path=? AND profile=? AND token_id=? AND resource_kind=? AND namespace=?';
    const params=[shape.tool,shape.verb_path,shape.profile,shape.token_id,shape.resource_kind,shape.namespace];
    if(await this.db.prepare(`SELECT 1 FROM standing_grants WHERE ${identity} AND name_prefix IS NOT NULL AND revoked_at IS NULL AND suspended_at IS NULL AND expires_at>? AND created_at>?`).get(...params,this.now(),this.now()-GRANT_TTL))return;
    // A grant ends at revocation, suspension or its effective expiry; ADR 0008 grants keep a longer stored expires_at.
    const ended=await this.db.prepare(`SELECT revoked_at,suspended_at,expires_at,created_at FROM standing_grants WHERE ${identity}`).all(...params) as {revoked_at:number|null;suspended_at:number|null;expires_at:number;created_at:number}[];
    const history=ended.reduce((latest,g)=>Math.max(latest,g.revoked_at ?? g.suspended_at ?? Math.min(g.expires_at,g.created_at+GRANT_TTL)),0);
    const cutoff=Math.max(this.now()-WEEK,block ? block.until-WEEK : 0,scopeBlock ? scopeBlock.until-WEEK : 0,history);
    const refs=await this.db.prepare("SELECT id,approval_context,argv_json FROM pending_approvals WHERE shape_key=? AND status='consumed' AND execution_success=1 AND grant_id IS NULL AND approval_context IS NOT NULL AND profile IS NOT NULL AND token_id IS NOT NULL AND consumed_at>? ORDER BY consumed_at DESC LIMIT 1000").all(row.shape_key,cutoff) as ContextRow[];
    // Evidence is a set of same-shape approvals whose contexts are mutually consistent,
    // built greedily from the newest. Consistency is not transitive, so every new piece
    // is checked against this context and every piece already kept, in both directions.
    // Repeated contexts are compared once: verdicts are cached per unordered pair, and a
    // candidate is checked against each distinct kept context rather than every kept row.
    const escalates=escalationComparer();
    const verdicts=new Map<string,boolean>();
    const consistent=(a:string,b:string)=>{
      const key=JSON.stringify(a<b ? [a,b] : [b,a]);
      const known=verdicts.get(key);
      if(known!==undefined)return known;
      const verdict=!escalates(a,b) && !escalates(b,a);
      verdicts.set(key,verdict);
      return verdict;
    };
    const {kept:evidence}=refs.reduce<{kept:ContextRow[];contexts:ReadonlySet<string>}>(({kept,contexts},r)=>
      consistent(row.approval_context!,r.approval_context) && [...contexts].every(c=>consistent(c,r.approval_context))
        ? {kept:[...kept,r],contexts:new Set([...contexts,r.approval_context])}
        : {kept,contexts},
      {kept:[],contexts:new Set<string>()});
    logger.info('grant promotion evidence',{tool:row.tool,approval_id:id,approvals:refs.length,consistent:evidence.length});
    if(evidence.length<this.threshold)return;
    // ADR 0010: the grant covers only the object-name segments every evidence approval shares.
    const objectNames=this.shapes.shapesFor(row.tool)?.objectNames;
    const names=objectNames ? evidence.map(r=>objectNames(JSON.parse(r.argv_json) as string[],row.matched)) : [null];
    const namePrefix=names.some(n=>n===null) ? null : grantNamePrefix((names as string[][]).flat());
    if(namePrefix===null){logger.info('grant promotion skipped: no common object-name prefix',{tool:row.tool,approval_id:id});return;}
    const grantId=randomUUID();
    await this.db.prepare(`INSERT INTO standing_grants(id,profile,token_id,tool,verb_path,resource_kind,namespace,object_count_max,flags_allowed,created_at,created_by,source_approval,context_refs,expires_at,use_count_max,name_prefix) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(grantId,shape.profile,shape.token_id,shape.tool,shape.verb_path,shape.resource_kind,shape.namespace,shape.object_count_max,JSON.stringify(shape.flags_allowed),this.now(),`auto:${id}`,id,JSON.stringify(evidence.map(r=>r.id)),this.now()+GRANT_TTL,GRANT_USE_MAX,namePrefix);
    logger.info('standing grant created',{tool:row.tool,grant_id:grantId,name_prefix:namePrefix});
  }
  async rejected(id:string):Promise<void> {
    if(!this.enabled)return;
    const row=await this.db.prepare('SELECT * FROM pending_approvals WHERE id=?').get(id) as {base_shape_key:string|null;argv_json:string;matched:string;profile:string;token_id:string;tool:string}|undefined;
    const toolShapes=row ? this.shapes.shapesFor(row.tool) : undefined;
    if(!row || !toolShapes)return;
    const argv=JSON.parse(row.argv_json) as string[];
    const base=toolShapes.baseShape(argv,row.matched,{profile:row.profile,tokenId:row.token_id,authenticated:true});
    // The strict parser does not resolve attached -nX namespace syntax.
    const unresolvedNamespace=argv.some(arg=>arg.startsWith('-n') && arg!=='-n' && !arg.startsWith('-n='));
    const shape=unresolvedNamespace ? null : base;
    await this.db.transaction(async ()=>{
      await this.lockScope(row.profile,row.token_id,row.tool,row.matched);
      // Unresolvable rejections revoke the entire caller/tool/verb scope.
      const scope='profile=? AND token_id=? AND tool=? AND verb_path=?';
      const narrowing=shape ? ' AND resource_kind=? AND namespace=?' : '';
      const params=[row.profile,row.token_id,row.tool,row.matched,...(shape ? [shape.resource_kind,shape.namespace] : [])];
      const grants=await this.db.prepare(`SELECT * FROM standing_grants WHERE ${scope}${narrowing} AND revoked_at IS NULL`).all(...params) as GrantRow[];
      const block=this.db.prepare('INSERT INTO grant_blocks VALUES (?,?) ON CONFLICT(shape_key) DO UPDATE SET until=excluded.until');
      const now=this.now();
      for(const grant of grants)await block.run(baseShapeKey(grant),now+WEEK);
      // Also reset learning evidence when a precise base has no grant yet.
      if(shape)await block.run(baseShapeKey(shape),now+WEEK);
      // An ambiguous rejection resets it for the whole scope, grant or not.
      else await block.run(this.scopeKey(row.profile,row.token_id,row.tool,row.matched),now+WEEK);
      await this.db.prepare(`UPDATE standing_grants SET revoked_at=?,revoked_by=? WHERE ${scope}${narrowing} AND revoked_at IS NULL`).run(now,`rejection:${id}`,...params);
    })();
  }
  async result(id:string,success:boolean):Promise<void> {
    if(!this.enabled)return;
    await this.db.prepare(`UPDATE standing_grants SET consecutive_failures=CASE WHEN ? THEN 0 ELSE consecutive_failures+1 END,
      suspended_at=CASE WHEN NOT ? AND consecutive_failures>=2 THEN ? ELSE suspended_at END
      WHERE id=(SELECT grant_id FROM pending_approvals WHERE id=?)`).run(Number(success),Number(success),this.now(),id);
  }
}
