import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {ShadowObserver} from '../../src/application/shadow/queue.js';
it('shadow disabled by default, never calls provider',async()=>{
 let calls=0;const observer=await ShadowObserver.create(sqliteDb(new Database(':memory:')),{enabled:false,queue_max:1,timeout_ms:10,retention_days:30,sample_rate:1},async()=>{calls++;return {label:'allow',confidence:1};});
 observer.submit({tool:'gh',profile:'test',argv:['CANARY'],cwd:null},'deny');
 await new Promise(r=>setTimeout(r,20));expect(calls).toBe(0);
});

import {features} from '../../src/domain/shadow/features.js';
import {modelAdapter} from '../../src/ports/shadow-model.js';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
import { sqliteDb } from "../helpers/sqlite.js";
import {callCliPassthrough,setObservationSink} from '../../src/adapters/outbound/drivers/cli-passthrough-wrapper.js';
const config={enabled:true,queue_max:2,timeout_ms:10,retention_days:30,sample_rate:1};
const observation={tool:'gh',profile:'test',argv:['delete','CANARY_SECRET','--force'],cwd:'/CANARY_SECRET'};
const wait=()=>new Promise(r=>setTimeout(r,40));
it('redacts values, bounds queue, validates provider output, isolates provider and metric exceptions',async()=>{
 const db=new Database(':memory:');const events:string[]=[];
 const o=await ShadowObserver.create(sqliteDb(db),config,modelAdapter(async(f)=>{expect(JSON.stringify(f)).not.toContain('CANARY');return {label:'allow',confidence:1,raw:'CANARY'};}),(event)=>{events.push(event);throw new Error('telemetry failure');});
 for(let i=0;i<10000;i++)o.submit(observation,'deny');
 await wait();
 expect(events).toContain('dropped');
 expect(events).toContain('ok');
 const rows=db.prepare('SELECT * FROM s1_shadow_log').all();
 expect(rows).toHaveLength(2);expect(JSON.stringify(rows)).not.toContain('CANARY');
 expect(features(observation).flags_present).toEqual(['--force']);
 await expect(modelAdapter(async()=>({label:'deny',confidence:2}))(features(observation),new AbortController().signal)).rejects.toThrow();
});
it('timeout on cancellation-ignoring provider bounds outstanding work; kill switch overrides config',async()=>{
 const db=new Database(':memory:');let calls=0;
 const o=await ShadowObserver.create(sqliteDb(db),config,async()=>{calls++;return new Promise(()=>{});});
 o.submit(observation,'allow');await wait();
 for(let i=0;i<1000;i++)o.submit(observation,'allow');
 await wait();expect(calls).toBe(1);
 expect((await o.summary()).outcomes).toEqual([{outcome:'timeout',count:1}]);
 process.env.SPLICEDOCK_SHADOW='off';
 try{(await ShadowObserver.create(sqliteDb(db),config,async()=>{calls++;throw new Error();})).submit(observation,'allow');await wait();expect(calls).toBe(1);}finally{delete process.env.SPLICEDOCK_SHADOW;}
});
it('provider failure and retention are isolated',async()=>{
 const db=new Database(':memory:');const o=await ShadowObserver.create(sqliteDb(db),config,async()=>{throw new Error('CANARY');});
 db.prepare("INSERT INTO s1_shadow_log(ts,tool,profile,features,deterministic_decision,outcome) VALUES(0,'test','test','{}','deny','ok')").run();
 o.submit(observation,'deny');await wait();
 expect((await o.summary()).outcomes).toEqual([{outcome:'unavailable',count:1}]);
 expect((db.prepare('SELECT count(*) n FROM s1_shadow_log').get() as {n:number}).n).toBe(1);
});
it('actual CLI decision unaffected by a failing observation sink',async()=>{
 setObservationSink(()=>{throw new Error('provider');});
 try{
 const c={type:'cli_passthrough' as const,name:'echo',description:'test',command:'echo',deny_subcommands:['delete'],env:[],timeout_ms:5000};
 const allowed=await callCliPassthrough(c,'run',{args:['hello']},['echo']);
 const denied=await callCliPassthrough(c,'run',{args:['delete']},['echo']);
 expect(allowed.isError).toBeFalsy();expect(denied.isError).toBe(true);
 }finally{setObservationSink(null);}
});
/** Exhaustive transitive local import walk, including re-exports and literal dynamic imports. */
function reachesShadow(entry:string,seen=new Set<string>()):boolean {
 const path=resolve(entry);if(seen.has(path))return false;seen.add(path);
 if(/\/src\/(?:domain|application|adapters\/outbound)\/shadow\//.test(path))return true;
 if(!existsSync(path))return false;
 const parsed=ts.preProcessFile(readFileSync(path,'utf8'),true,true);
 return parsed.importedFiles.some(i=>i.fileName.startsWith('.')&&reachesShadow(resolve(dirname(path),i.fileName.replace(/\.js$/,'.ts')),seen));
}
it('policy and approval have no transitive dependency on shadow',()=>{
 const files=readdirSync('src/domain/policy').filter(f=>f.endsWith('.ts')).map(f=>'src/domain/policy/'+f);
 files.push('src/application/approvals/approval-service.ts');
 for(const file of files)expect(reachesShadow(file),file).toBe(false);
});
it('feature PSI waits for observed baseline and measures real distributions',async ()=>{
 const db=new Database(':memory:');const o=await ShadowObserver.create(sqliteDb(db),config);
 expect(await o.psi()).toEqual({});
 for(const [ts,argc] of [[Date.now()-172800000,1],[Date.now(),4]]){
 const f={...features(observation),argc_bucket:argc};
 db.prepare("INSERT INTO s1_shadow_log(ts,tool,profile,features,deterministic_decision,outcome) VALUES(?,'gh','test',?,'deny','ok')").run(ts,JSON.stringify(f));
 }
 expect((await o.psi()).argc_bucket).toBeGreaterThan(0);
 expect((await o.psi()).cwd_class).toBe(0);
});
it('dependency scanner includes reexports and dynamic imports',()=>{
 const imports=ts.preProcessFile("export * from './bridge.js'; import('./shadow/queue.js');",true,true).importedFiles.map(i=>i.fileName);
 expect(imports).toContain('./bridge.js');expect(imports).toContain('./shadow/queue.js');
});
it('provider cannot mutate the metadata retained for persistence',async()=>{
 const db=new Database(':memory:');const observer=await ShadowObserver.create(sqliteDb(db),config,async f=>{
 Reflect.set(f,'profile','CANARY_SECRET');return {label:'allow',confidence:1};
 });
 observer.submit(observation,'deny');await wait();
 expect(JSON.stringify(db.prepare('SELECT * FROM s1_shadow_log').all())).not.toContain('CANARY');
 expect(Object.isFrozen(features(observation).flags_present)).toBe(true);
});
