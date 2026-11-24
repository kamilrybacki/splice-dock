import {describe,it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {CircuitBreaker} from '../../src/services/policy/breaker/index.js';
describe('durable breaker',()=>{
 it('trips once, persists, isolates tokens and never enforces observe',async ()=>{
 const db=new Database(':memory:');
 const c={enabled:true,mode:'observe' as const,window_seconds:60,deny_threshold:10,cooldown_seconds:1800,half_open_probes:3,scopes:['token'],read_allowlist:[]};
 const b=await CircuitBreaker.create(sqliteDb(db),c);
 const caller={profile:'test',tokenId:'one',authenticated:true};
 for(let i=0;i<100;i++)await b.record(caller,true,1000);
 expect((await b.list())[0].trip_count).toBe(1);
 expect(await b.force(caller,'gh',[],1000)).toBe(false);
 const enforcing=await CircuitBreaker.create(sqliteDb(db),{...c,mode:'enforce'});
 expect(await enforcing.force(caller,'gh',[],1000)).toBe(true);
 expect(await enforcing.force({...caller,tokenId:'two'},'gh',[],1000)).toBe(false);
 });
});

import {SplicedockStore} from '../../src/services/database/adapters/store.js';
import {ApprovalService} from '../../src/services/approvals/base.js';
import { callCliPassthrough, configurePassthrough } from '../../src/services/tools/adapters/cli/passthrough.js';
import {runWithCaller} from '../../src/common/request/context.js';
const cfg={enabled:true,mode:'enforce' as const,window_seconds:60,deny_threshold:10,cooldown_seconds:1800,half_open_probes:3,scopes:['token'],read_allowlist:[]};
const caller={profile:'test',tokenId:'one',authenticated:true};

import { sqliteDb } from "../helpers/sqlite.js";

it('bounds floods, cooldown is exact, probes need approvals, denial reopens, reset audited',async ()=>{
 const db=new Database(':memory:');const b=await CircuitBreaker.create(sqliteDb(db),cfg);
 for(let i=0;i<100000;i++)await b.record(caller,true,0);
 expect((await b.list())[0].trip_count).toBe(1);
 expect(await b.force(caller,'echo',[],1799999)).toBe(true);
 expect((await b.list())[0].state).toBe('open');
 expect(await b.force(caller,'echo',[],1800000)).toBe(true);
 expect((await b.list())[0].state).toBe('half_open');
 expect(await b.force(caller,'echo',[],1860000)).toBe(true);
 await b.record(caller,true,1860000);expect((await b.list())[0].trip_count).toBe(2);
 await b.control((await b.list())[0].scope,false,'operator',1860001);
 expect((await b.list())[0].state).toBe('closed');
 expect((db.prepare('SELECT actor FROM breaker_audit ORDER BY id DESC LIMIT 1').get() as {actor:string}).actor).toBe('operator');
 expect(await b.list()).toHaveLength(1);
}, 60_000); // 100k durable writes need more time on the slower ARC runner.
it('actual CLI path refuses weak consent, creates strong, preserves hard deny',async()=>{
 const store=await SplicedockStore.open(':memory:');const b=await CircuitBreaker.create(store.consentDatabase(),{...cfg,deny_threshold:1});
 const svc=new ApprovalService({store,sweepIntervalMs:0,strongTools:[]});
 const input={tool:'echo',argv:['hello'],rule:'approval_subcommands' as const,matched:'hello'};
 const weak=await svc.makeHook('echo',process.cwd(),caller)(input);
 if(!('id' in weak))throw new Error('missing id');await svc.approve(weak.id,'admin');
 await b.record(caller,true);
 configurePassthrough({circuitBreaker: b, approvalHookFactory: (t,c)=>svc.makeHook(t,c.cwd,undefined,c.requireStrong), approvalSettler: svc});
 try{
 const config={type:'cli_passthrough' as const,name:'echo',description:'test',command:'echo',deny_subcommands:[],env:[],timeout_ms:5000};
 const out=await runWithCaller(caller,()=>callCliPassthrough(config,'run',{args:['hello']},['echo']));
 expect(out.isError).toBe(true);expect(out.content[0].text).toContain('strong');
 expect((await svc.get(weak.id))?.status).toBe('approved');
 const denied=await runWithCaller(caller,()=>callCliPassthrough({...config,deny_subcommands:['delete']},'run',{args:['delete']},['echo']));
 expect(denied.content[0].text).toContain('deny_subcommands');
 }finally{configurePassthrough({});await store.close();}
});
it('counts a sliding window across first-event window boundaries',async ()=>{
 const b=await CircuitBreaker.create(sqliteDb(new Database(':memory:')),{...cfg,deny_threshold:3});
 await b.record(caller,true,0);await b.record(caller,true,59000);await b.record(caller,true,61000);await b.record(caller,true,62000);
 expect((await b.list())[0].state).toBe('open');
});

it('strengthened tool policy refuses an admin-approved weak row',async ()=>{
 const store=await SplicedockStore.open(':memory:');
 const weak=new ApprovalService({store,sweepIntervalMs:0,strongTools:[]});
 const input={tool:'gh',argv:['pr','create'],rule:'approval_subcommands' as const,matched:'pr'};
 const first=await weak.makeHook('gh',process.cwd(),caller)(input);
 if(!('id' in first))throw new Error('missing id');await weak.approve(first.id,'admin');
 const strong=new ApprovalService({store,sweepIntervalMs:0,strongTools:['gh']});
 const retry=await strong.makeHook('gh',process.cwd(),caller)(input);
 expect(retry.approved).toBe(false);
 if('id' in retry)expect(retry.payload?.level).toBe('strong');
 await store.close();
});

it.each(['observe','enforce'] as const)('storage failure semantics %s',async mode=>{
 const db=new Database(':memory:');const b=await CircuitBreaker.create(sqliteDb(db),{...cfg,mode});db.close();
 if(mode==='observe'){await b.record(caller,true);expect(await b.force(caller,'gh',[])).toBe(false);await b.approved(caller,'approval-1');}
 else await expect(()=>b.force(caller,'gh',[])).rejects.toThrow();
});

// repo delete is covered with a fake gh in tests/unit/drivers/cli-strong-approval-paths.test.ts.
it.each([['api','/repos']])('counts early gh security refusal %j',async(...argv)=>{
 const db=new Database(':memory:');const b=await CircuitBreaker.create(sqliteDb(db),{...cfg,deny_threshold:1});configurePassthrough({circuitBreaker: b});
 try{await runWithCaller(caller,()=>callCliPassthrough({type:'cli_passthrough',name:'gh',command:'gh',description:'test',env:[],timeout_ms:5000},'run',{args:argv},['gh']));expect((await b.list())[0]?.state).toBe('open');}
 finally{configurePassthrough({});db.close();}
});
it.each(['observe','enforce'] as const)('full scope storage preserves %s semantics',async mode=>{
 const db=new Database(':memory:');const b=await CircuitBreaker.create(sqliteDb(db),{...cfg,mode});
 db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4096) INSERT INTO breaker_state(scope,family,state,window_at) SELECT 'occupied:'||x,'token','open',0 FROM n").run();
 if(mode==='observe'){expect(await b.force(caller,'gh',[])).toBe(false);await b.record(caller,true);}
 else await expect(()=>b.force(caller,'gh',[])).rejects.toThrow('breaker_capacity');
 expect(await b.list()).toHaveLength(4096);db.close();
});
it('strengthened policy replaces pending weak consent without changing binding',async ()=>{
 const store=await SplicedockStore.open(':memory:');const options={store,sweepIntervalMs:0,strongTools:[] as string[]};const svc=new ApprovalService(options);
 const input={tool:'gh',argv:['pr','create'],rule:'approval_subcommands' as const,matched:'pr'};
 const first=await svc.makeHook('gh',process.cwd(),caller)(input);
 svc.reconfigureStrongTools(['gh']);const second=await svc.makeHook('gh',process.cwd(),caller)(input);
 if(!('id' in first)||!('id' in second))throw new Error('missing id');
 expect(second.id).not.toBe(first.id);expect((await svc.get(first.id))?.status).toBe('rejected');expect(second.payload?.level).toBe('strong');
 const row=await store.consentDatabase().prepare('SELECT token_id,cwd FROM pending_approvals WHERE id=?').get(second.id) as {token_id:string;cwd:string};expect(row.token_id).toBe(caller.tokenId);expect(row.cwd).toBe(process.cwd());await store.close();
});

import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
it('disk restart and idempotent migration cannot bless an old weak approval',async ()=>{
 const dir=mkdtempSync(join(tmpdir(),'approval-strength-'));const path=join(dir,'state.sqlite');
 try{
 let store=await SplicedockStore.open(path);let svc=new ApprovalService({store,sweepIntervalMs:0,strongTools:[]});
 const input={tool:'gh',argv:['pr','create'],rule:'approval_subcommands' as const,matched:'pr'};
 const first=await svc.makeHook('gh',process.cwd(),caller)(input);if(!('id' in first))throw new Error('missing id');await svc.approve(first.id,'admin');await store.close();
 store=await SplicedockStore.open(path);svc=new ApprovalService({store,sweepIntervalMs:0,strongTools:['gh']});
 const retry=await svc.makeHook('gh',process.cwd(),caller)(input);expect(retry.approved).toBe(false);if('id' in retry)expect(retry.payload?.level).toBe('strong');
 expect((await svc.get(first.id))?.status).toBe('approved');await store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
