import type { SqlDb } from '../database/base.js';
import type {SplicedockConfig} from '../../config/types.js';
import {features,type Observation} from './features.js';
import type { Provider, ShadowFeatures } from '../../contracts/outbound/shadow/model.js';
import { modelAdapter, unavailable } from './model.js';
type Config=SplicedockConfig['server']['shadow'];
type Job={f:ShadowFeatures;decision:string};
/** An observer only. Submission returns void; neither policy nor consent receives its results. */
export class ShadowObserver {
 private queue:Job[]=[];
 private running=false;
 private stuck=false;
 /** The constructor does no I/O; create() migrates the shadow log first. */
 constructor(readonly db:SqlDb,readonly config:Config,private provider:Provider=unavailable,private event:(outcome:string,latency:number,depth:number,agreement?:string)=>void=()=>{}){}
 static async create(db:SqlDb,config:Config,provider:Provider=unavailable,event:(outcome:string,latency:number,depth:number,agreement?:string)=>void=()=>{}):Promise<ShadowObserver>{
 await db.ensureSchema();
 return new ShadowObserver(db,config,provider,event);
 }
 submit(o:Observation,decision:string):void {
 try{
 if(!this.config.enabled||process.env.SPLICEDOCK_SHADOW==='off'||Math.random()>=this.config.sample_rate)return;
 if(this.stuck||this.queue.length>=this.config.queue_max){this.emit('dropped',0);return;}
 const f=features(o);
 this.queue.push({f,decision:['allow','deny','approval_required','approved'].includes(decision)?decision:'deny'});
 if(!this.running){this.running=true;setImmediate(()=>{void this.drain();});}
 }catch{this.emit('unavailable',0);}
 }
 private emit(outcome:string,latency:number,agreement?:string){try{this.event(outcome,latency,this.queue.length,agreement);}catch{/* telemetry cannot affect requests */}}
 private async drain():Promise<void>{
 try{while(this.queue.length){
 if(!this.config.enabled||process.env.SPLICEDOCK_SHADOW==='off'){this.queue=[];break;}
 const job=this.queue.shift()!;const start=Date.now();const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;let settled=false;
 // A provider ignoring cancellation can leave at most ONE promise alive. Stop dispatch until it settles.
 const inference=Promise.resolve().then(()=>modelAdapter(this.provider)(job.f,controller.signal)).finally(()=>{settled=true;this.stuck=false;});
 let outcome='ok';let prediction:Awaited<ReturnType<Provider>>|undefined;
 try{prediction=await Promise.race([inference,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},this.config.timeout_ms);})]);}
 catch{outcome=controller.signal.aborted?'timeout':'unavailable';}
 finally{clearTimeout(timer);if(!settled){this.stuck=true;this.queue=[];}}
 const latency=Date.now()-start;
 this.emit(outcome,latency,prediction?(prediction.label==='escalate'?(job.decision==='allow'?'s1_would_escalate':'agree'):(job.decision==='allow'?'agree':'s1_would_allow')):undefined);
 try{
 await this.db.transaction(async ()=>{
 await this.db.prepare('DELETE FROM s1_shadow_log WHERE ts<?').run(Date.now()-this.config.retention_days*86400000);
 await this.db.prepare('INSERT INTO s1_shadow_log(ts,tool,profile,features,deterministic_decision,s1_label,s1_confidence,s1_latency_ms,outcome) VALUES(?,?,?,?,?,?,?,?,?)').run(Date.now(),job.f.tool,job.f.profile,JSON.stringify(job.f),job.decision,prediction?.label??null,prediction?.confidence??null,latency,outcome);
 await this.db.prepare('DELETE FROM s1_shadow_log WHERE id<=(SELECT coalesce(max(id),0)-10000 FROM s1_shadow_log)').run();
 })();
 }catch{this.emit('unavailable',0);}
 if(this.stuck)break;
 }}catch{this.emit('unavailable',0);}finally{this.running=false;}
 }
 async psi():Promise<Record<string,number>>{
 const now=Date.now();const split=now-86400000;
 const rows=await this.db.prepare('SELECT ts,features FROM s1_shadow_log WHERE ts>=?').all(now-this.config.retention_days*86400000) as {ts:number;features:string}[];
 const baseline=rows.filter(r=>r.ts<split),recent=rows.filter(r=>r.ts>=split);
 if(!baseline.length||!recent.length)return {};
 const result:Record<string,number>={};
 for(const [feature,bins] of Object.entries({argc_bucket:[0,1,2,3,4],subcommand_class:['read','write','other'],cwd_class:['present','none']})){
 const distribution=(data:typeof rows)=>bins.map(bin=>(data.filter(r=>JSON.parse(r.features)[feature]===bin).length+0.5)/(data.length+bins.length*0.5));
 const a=distribution(baseline),b=distribution(recent);
 result[feature]=a.reduce((sum,p,i)=>sum+(b[i]-p)*Math.log(b[i]/p),0);
 }
 return result;
 }
 async summary(){
 await this.db.prepare('DELETE FROM s1_shadow_log WHERE ts<?').run(Date.now()-this.config.retention_days*86400000);
 const rows=await this.db.prepare('SELECT outcome,count(*) AS count FROM s1_shadow_log WHERE ts>=? GROUP BY outcome').all(Date.now()-this.config.retention_days*86400000);
 const latency=await this.db.prepare('SELECT s1_latency_ms AS ms FROM s1_shadow_log ORDER BY s1_latency_ms').all() as {ms:number}[];
 const daily=await this.db.prepare("SELECT ts/86400000 AS day,count(*) AS escalations FROM s1_shadow_log WHERE s1_label='escalate' GROUP BY day").all();
 const agreement=await this.db.prepare("SELECT deterministic_decision,s1_label,count(*) AS count FROM s1_shadow_log GROUP BY deterministic_decision,s1_label").all();
 return {outcomes:rows,agreement,escalations_per_day:daily,p95_ms:latency.length?latency[Math.ceil(latency.length*.95)-1].ms:null};
 }
}
