// A half-open breaker counts a recovery probe only when a distinct approval
// is irreversibly consumed (the child process spawned). A reservation that is
// released after a pre-spawn failure must never advance recovery, otherwise
// one strong consent replayed N times satisfies all N probes.
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SplicedockStore} from '../../src/services/database/adapters/store.js';
import {ApprovalService} from '../../src/services/approvals/base.js';
import type {SqlDb} from "../../src/services/database/base.js";
import {CircuitBreaker} from '../../src/services/policy/breaker/index.js';
import {callCliPassthrough,setApprovalHookFactory,setApprovalSettler,setCircuitBreaker} from '../../src/services/tools/adapters/cli/passthrough.js';
import {runWithCaller} from '../../src/common/request/context.js';
import type {CliPassthroughToolConfig} from '../../src/config/types.js';

const PROBES=3;
const WINDOW_MS=60_000;
const cfg={enabled:true,mode:'enforce' as const,window_seconds:WINDOW_MS/1000,deny_threshold:1,cooldown_seconds:1800,half_open_probes:PROBES,scopes:['global','profile:test','token'],read_allowlist:[]};
const caller={profile:'test',tokenId:'one',authenticated:true};
const UNSET_REF='SPLICEDOCK_TEST_PROBE_UNSET_REF';
const REL_KCFG_REF='SPLICEDOCK_TEST_PROBE_REL_KCFG';

let store:SplicedockStore;
let db:SqlDb;
let breaker:CircuitBreaker;
let tmp:string;

const tool=(over:Partial<CliPassthroughToolConfig>={}):CliPassthroughToolConfig=>({type:'cli_passthrough',name:'echo',description:'test',command:'echo',deny_subcommands:[],env:[],timeout_ms:5000,...over} as CliPassthroughToolConfig);
const run=(config:CliPassthroughToolConfig,args:string[])=>runWithCaller(caller,()=>callCliPassthrough(config,'run',{args},[config.command]));
const state=async ()=>(await breaker.list()).find(r=>r.family==='token')!;
const statusOf=async (id:string)=>(await db.prepare('SELECT status FROM pending_approvals WHERE id=?').get(id) as {status:string}).status;
const text=(out:{content:{text:string}[]})=>out.content[0]!.text;

/** Ask the wrapper for the operation, then seed the WebAuthn consent the
 *  operator would give for the strong row it created. */
async function approveStrong(config:CliPassthroughToolConfig,args:string[]):Promise<string>{
  const out=await run(config,args);
  expect(out.isError).toBe(true);
  const id=/approval id: ([0-9a-f-]+)/.exec(text(out))?.[1];
  if(!id)throw new Error(`no approval id in: ${text(out)}`);
  const row=await db.prepare('SELECT level,status FROM pending_approvals WHERE id=?').get(id) as {level:string;status:string};
  expect(row).toEqual({level:'strong',status:'pending'});
  await db.prepare("UPDATE pending_approvals SET status='approved',consent_method='webauthn',approved_at=? WHERE id=?").run(Date.now(),id);
  return id;
}

/** Backdate the half-open window so the next force() may close the breaker. */
async function windowElapsed():Promise<void>{await db.prepare('UPDATE breaker_state SET window_at=window_at-?').run(WINDOW_MS+1);}

beforeEach(async ()=>{
  store=await SplicedockStore.open(':memory:');db=store.consentDatabase();
  breaker=await CircuitBreaker.create(db,cfg);
  const svc=new ApprovalService({store,sweepIntervalMs:0,strongTools:[]});
  setCircuitBreaker(breaker);setApprovalHookFactory((t,c)=>svc.makeHook(t,c.cwd,undefined,c.requireStrong));setApprovalSettler(svc);
  tmp=mkdtempSync(join(tmpdir(),'breaker-probe-'));
  delete process.env[UNSET_REF];
  // Trip, then end the cooldown so the next force() moves to half_open.
  await breaker.record(caller,true);
  expect((await state()).state).toBe('open');
  await db.prepare('UPDATE breaker_state SET cooldown_until=0').run();
  expect(await breaker.force(caller,'echo',['x'])).toBe(true);
  expect(await state()).toMatchObject({state:'half_open',probes:0});
});
afterEach(async ()=>{
  setCircuitBreaker(null);setApprovalHookFactory(null);setApprovalSettler(null);
  delete process.env[UNSET_REF];delete process.env[REL_KCFG_REF];
  await store.close();rmSync(tmp,{recursive:true,force:true});
});

describe('half-open recovery probes count consumed approvals only',()=>{
  it('one approval retried after vault failures never advances recovery (finding repro)',async()=>{
    const config=tool({env:[{name:'PROBE_TOKEN',from:`env:${UNSET_REF}`}]});
    const id=await approveStrong(config,['hello']);
    for(let i=0;i<PROBES;i++){
      expect(text(await run(config,['hello']))).toBe('vault_unavailable');
      expect(await statusOf(id)).toBe('approved');
    }
    expect((await state()).probes).toBe(0);
    await windowElapsed();
    // Another operation must still need strong approval.
    expect(await breaker.force(caller,'other',['op'])).toBe(true);
    expect((await state()).state).toBe('half_open');
  });

  it('a relative KUBECONFIG released before spawn does not advance recovery',async()=>{
    process.env[REL_KCFG_REF]='relative/kubeconfig';
    const config=tool({env:[{name:'KUBECONFIG',from:`env:${REL_KCFG_REF}`}]});
    const id=await approveStrong(config,['hello']);
    for(let i=0;i<PROBES;i++){
      expect(text(await run(config,['hello']))).toContain('KUBECONFIG must be an absolute path');
      expect(await statusOf(id)).toBe('approved');
    }
    expect((await state()).probes).toBe(0);
  });

  it('a spawn failure before the child starts does not advance recovery',async()=>{
    const bin=join(tmp,'broken-tool');
    writeFileSync(bin,'#!/nonexistent/splicedock-test-interpreter\n');chmodSync(bin,0o755);
    const config=tool({name:'broken',command:bin});
    const id=await approveStrong(config,['hello']);
    for(let i=0;i<PROBES;i++){
      expect((await run(config,['hello'])).isError).toBe(true);
      expect(await statusOf(id)).toBe('approved');
    }
    expect((await state()).probes).toBe(0);
  });

  it('a child that spawned and then timed out spent its approval and counts once',async()=>{
    const config=tool({name:'sleep',command:'sleep',timeout_ms:1000});
    const id=await approveStrong(config,['5']);
    expect((await run(config,['5'])).isError).toBe(true);
    expect(await statusOf(id)).toBe('consumed');
    expect((await state()).probes).toBe(1);
  });

  it('a consumed approval counts once, and its reuse is refused',async()=>{
    const config=tool();
    const id=await approveStrong(config,['hello']);
    expect((await run(config,['hello'])).isError).toBe(false);
    expect(await statusOf(id)).toBe('consumed');
    expect((await state()).probes).toBe(1);
    expect(text(await run(config,['hello']))).toContain('Approval required');
    expect((await state()).probes).toBe(1);
  });

  it('distinct consumed approvals close the breaker after the window, and not before N',async()=>{
    const config=tool();
    const ids=new Set<string>();
    for(let i=0;i<PROBES;i++){
      const id=await approveStrong(config,['hello']);
      ids.add(id);
      expect((await run(config,['hello'])).isError).toBe(false);
      expect(await statusOf(id)).toBe('consumed');
      expect((await breaker.list()).map(r=>r.probes)).toEqual([i+1,i+1,i+1]);
      if(i===PROBES-2){
        const saved=(await state()).window_at;await windowElapsed();
        expect(await breaker.force(caller,'other',['op'])).toBe(true);
        expect((await state()).state).toBe('half_open');
        await db.prepare('UPDATE breaker_state SET window_at=?').run(saved);
      }
    }
    expect(ids.size).toBe(PROBES);
    await windowElapsed();
    expect(await breaker.force(caller,'other',['op'])).toBe(false);
    expect((await state()).state).toBe('closed');
  });

  it('a released attempt followed by a consumed one counts exactly once',async()=>{
    const config=tool({env:[{name:'PROBE_TOKEN',from:`env:${UNSET_REF}`}]});
    const id=await approveStrong(config,['hello']);
    expect(text(await run(config,['hello']))).toBe('vault_unavailable');
    expect((await state()).probes).toBe(0);
    process.env[UNSET_REF]='value';
    expect((await run(config,['hello'])).isError).toBe(false);
    expect(await statusOf(id)).toBe('consumed');
    expect((await state()).probes).toBe(1);
  });
});

describe('CircuitBreaker.approved is idempotent per approval id',()=>{
  beforeEach(async ()=>{
    for(const id of ['a','b','c','d','e']){
      await store.insertApproval({id,tool:'echo',argv_hash:'test',argv_json:'[]',rule:'approval_subcommands',matched:'test',requested_at:Date.now(),expires_at:Date.now()+60000,profile:caller.profile,token_id:caller.tokenId,cwd:process.cwd()});
      await db.prepare("UPDATE pending_approvals SET level='strong',status='consumed',consent_method='webauthn',consumed_at=? WHERE id=?").run(Date.now(),id);
    }
  });
  it.each([
    "level='weak'", "consent_method='admin_api'", "status='approved'",
    "status='reserved'", "consumed_at=NULL", "profile='other'", "token_id='other'",
  ])('persisted eligibility refuses %s',async change=>{
    await db.exec(`UPDATE pending_approvals SET ${change} WHERE id='a'`);
    await breaker.approved(caller,'a');await breaker.approved(caller,'missing');
    expect((await breaker.list()).map(r=>r.probes)).toEqual([0,0,0]);
  });

  it('counts one id once, distinct ids separately, and only while half-open',async ()=>{
    await breaker.approved(caller,'a');await breaker.approved(caller,'a');await breaker.approved(caller,'a');
    expect((await state()).probes).toBe(1);
    await breaker.approved(caller,'b');
    expect((await state()).probes).toBe(2);
    await breaker.approved(caller,'c');await breaker.approved(caller,'d');
    expect((await state()).probes).toBe(PROBES);
    await windowElapsed();
    expect(await breaker.force(caller,'other',['op'])).toBe(false);
    expect(await state()).toMatchObject({state:'closed',probes:0});
    await breaker.approved(caller,'e');
    expect((await state()).probes).toBe(0);
  });

  it('a database created before the probe ledger gains it when the breaker starts',async ()=>{
    await db.exec('DROP TABLE breaker_probe_ids');
    const upgraded=await CircuitBreaker.create(db,cfg);
    await upgraded.approved(caller,'a');await upgraded.approved(caller,'a');
    expect((await state()).probes).toBe(1);
    await upgraded.approved(caller,'b');await upgraded.approved(caller,'c');
    await windowElapsed();
    expect(await upgraded.force(caller,'other',['op'])).toBe(false);
    expect((await state()).state).toBe('closed');
  });

  it('a reopened breaker forgets the ids counted in the previous half-open window',async ()=>{
    await breaker.approved(caller,'a');
    await breaker.record(caller,true);
    expect((await state()).state).toBe('open');
    await db.prepare('UPDATE breaker_state SET cooldown_until=0').run();
    await breaker.force(caller,'echo',['x']);
    expect(await state()).toMatchObject({state:'half_open',probes:0});
    expect((await db.prepare('SELECT count(*) n FROM breaker_probe_ids').get() as {n:number}).n).toBe(0);
    await breaker.approved(caller,'a');
    expect((await state()).probes).toBe(1);
  });
});
