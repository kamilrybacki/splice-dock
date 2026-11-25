import { builtinReadonlyProbes } from '../../src/builtin-backends.js';
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SplicedockStore} from '../../src/services/database/adapters/store.js';
import {ConsentStore} from '../../src/services/approvals/consent/store.js';
import {WeakConsent} from '../../src/services/approvals/adapters/fastify/weak.js';
import {ApprovalService} from '../../src/services/approvals/base.js';
import {CircuitBreaker} from '../../src/services/policy/breaker/index.js';
import { callCliPassthrough, configurePassthrough } from '../../src/services/tools/adapters/cli/passthrough.js';
import {runWithCaller} from '../../src/common/request/context.js';
import { sqliteDb } from "../helpers/sqlite.js";
import { builtinCliProfiles, useBuiltinCliProfiles } from '../helpers/cli-profiles.js';

useBuiltinCliProfiles();

const caller={profile:'test',tokenId:'one',authenticated:true};
const cfg={enabled:true,mode:'enforce' as const,window_seconds:60,deny_threshold:1,cooldown_seconds:1800,half_open_probes:3,scopes:['global','profile:test','token'],read_allowlist:[{tool:'kubectl',argv:['get','pods']}]};
const config={type:'cli_passthrough' as const,name:'kubectl',command:'echo',description:'local harmless substitute',env:[],deny_subcommands:[],timeout_ms:5000,policy:{approval_subcommands:['get'],on_violation:'deny' as const,audit:false}};
afterEach(()=>{configurePassthrough({ cliProfiles: builtinCliProfiles });});

it.each(['open','half_open'])('real weak consent in %s never advances any recovery scope',async phase=>{
 const store=await SplicedockStore.open(':memory:');const db=store.consentDatabase();
 try{
 const b=await CircuitBreaker.create(db,cfg,()=>{},builtinReadonlyProbes);const probes=vi.spyOn(b,'approved');const svc=new ApprovalService({store,sweepIntervalMs:0,strongTools:[]});
 const weak=new WeakConsent(await ConsentStore.open(db),true);await store.insertProfileToken(caller.tokenId,caller.profile,'test-hash');
 configurePassthrough({ cliProfiles: builtinCliProfiles, circuitBreaker: b, approvalHookFactory: (t,c)=>svc.makeHook(t,c.cwd,undefined,c.requireStrong), approvalSettler: svc});
 await b.record(caller,true);
 if(phase==='half_open')await db.prepare('UPDATE breaker_state SET cooldown_until=0').run();
 const run=(args=['get','pods'])=>runWithCaller(caller,()=>callCliPassthrough(config,'run',{args},['echo']));
 const ids=new Set<string>();const credentials=new Set<string>();
 for(let i=0;i<3;i++){
 const pending=await run();const id=/approval id: ([0-9a-f-]+)/.exec(pending.content[0]!.text)?.[1];
 expect(id).toBeTruthy();ids.add(id!);
 const credential=(await weak.issue(caller.tokenId))!;credentials.add(credential);expect(await weak.approve(id!,credential)).toBe(true);
 expect(await weak.approve(id!,credential)).toBe(false);
 expect((await run()).isError).toBe(false);
 expect((await svc.get(id!))?.status).toBe('consumed');
 }
 expect(ids.size).toBe(3);expect(credentials.size).toBe(3);
 // A read-allowlisted operation needing no approval also never calls the counter.
 expect((await runWithCaller(caller,()=>callCliPassthrough({...config,policy:undefined},'run',{args:['get','pods']},['echo']))).isError).toBe(false);
 expect(probes).not.toHaveBeenCalled();
 expect(await b.list()).toHaveLength(3);
 expect((await b.list()).map(r=>r.probes)).toEqual([0,0,0]);
 await db.prepare('UPDATE breaker_state SET window_at=window_at-60001').run();
 expect(await b.force(caller,'other',['op'])).toBe(true);
 // A fresh weak approval cannot authorize a non-allowlisted op in either state.
 const input={argv:['get','services'],rule:'approval_subcommands' as const,matched:'get'};
 const pending=await svc.makeHook('kubectl',process.cwd(),caller)(input);
 if(!('id' in pending))throw new Error('missing pending approval');
 expect(await weak.approve(pending.id,(await weak.issue(caller.tokenId))!)).toBe(true);
 const refused=await run(['get','services']);expect(refused.isError).toBe(true);expect(refused.content[0]!.text).toContain('strong');
 expect((await svc.get(pending.id))?.status).toBe('approved');
 }finally{await store.close();}
});

it.each([false,true])('legacy counters reset once and survive disk restart (existing ledger: %s)',async hasLedger=>{
 const dir=mkdtempSync(join(tmpdir(),'breaker-upgrade-'));const path=join(dir,'state.sqlite');
 let db=new Database(path);
 try{
 // Pre-ledger schema with inflated counters in every state.
 db.exec(`CREATE TABLE breaker_state(scope TEXT PRIMARY KEY,family TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'closed',opened_at INTEGER NOT NULL DEFAULT 0,cooldown_until INTEGER NOT NULL DEFAULT 0,trip_count INTEGER NOT NULL DEFAULT 0,window_at INTEGER NOT NULL,denials INTEGER NOT NULL DEFAULT 0,probes INTEGER NOT NULL DEFAULT 0);
 INSERT INTO breaker_state(scope,family,state,window_at,probes) VALUES ('global','global','half_open',1,3),('profile:test','profile:test','open',1,3),('other','token','closed',1,3);`);
 if(hasLedger)db.exec("CREATE TABLE breaker_probe_ids(scope TEXT NOT NULL,approval_id TEXT NOT NULL,PRIMARY KEY(scope,approval_id)); INSERT INTO breaker_probe_ids VALUES ('global','old-weak');");
 db.close();db=new Database(path);const before=Date.now();let b=await CircuitBreaker.create(sqliteDb(db),cfg,()=>{},builtinReadonlyProbes);
 expect((await b.list()).map(r=>r.probes)).toEqual([0,0,0]);
 expect((await b.list()).find(r=>r.scope==='global')!.window_at).toBeGreaterThanOrEqual(before);
 expect((await b.list()).map(r=>r.state)).toEqual(['half_open','closed','open']);
 expect(db.prepare('SELECT count(*) n FROM breaker_probe_ids').get()).toEqual({n:0});
 expect(await b.force(caller,'other',['op'])).toBe(true);
 db.prepare("UPDATE breaker_state SET probes=1,window_at=12345 WHERE scope='global'").run();
 db.prepare("INSERT INTO breaker_probe_ids VALUES ('global','new-strong')").run();
 db.close();db=new Database(path);b=await CircuitBreaker.create(sqliteDb(db),cfg,()=>{},builtinReadonlyProbes);
 expect((await b.list()).find(r=>r.scope==='global')).toMatchObject({state:'half_open',probes:1,window_at:12345});
 expect(db.prepare('SELECT count(*) n FROM breaker_probe_ids').get()).toEqual({n:1});
 expect(await b.force(caller,'other',['op'])).toBe(true);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
