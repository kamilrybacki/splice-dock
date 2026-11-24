import {it,expect} from 'vitest';
import {SplicedockStore} from '../../../src/services/database/adapters/store.js';
import {ApprovalService} from '../../../src/services/approvals/base.js';
import {callCliPassthrough,setApprovalHookFactory,setApprovalSettler} from '../../../src/services/tools/adapters/cli/passthrough.js';
import {runWithCaller} from '../../../src/common/request/context.js';
import {createMetrics} from '../../../src/common/metrics.js';
import type {CliPassthroughToolConfig} from '../../../src/config/types.js';
it('carries context through policy, learns after real spawns and emits grant metrics',async()=>{
  const store=await SplicedockStore.open(':memory:'),metrics=createMetrics();
  const svc=new ApprovalService({store,grantsEnabled:true,sweepIntervalMs:0,onGrantUsed:(tool,verb)=>metrics.approvalGrantUsed.inc({tool,verb})});
  const cfg:CliPassthroughToolConfig={type:'cli_passthrough',name:'kubectl',description:'fixture',command:'echo',deny_subcommands:[],env:[],timeout_ms:5000,isolate_config:false,policy:{approval_subcommands:['delete'],on_violation:'approval',audit:false}};
  setApprovalHookFactory((tool,ctx)=>svc.makeHook(tool,ctx.cwd,undefined,ctx.requireStrong,ctx.approvalContext));setApprovalSettler(svc);
  const run=(name:string)=>runWithCaller({profile:'test',tokenId:'fixture',authenticated:true},()=>callCliPassthrough(cfg,'run',{args:['delete','job',name],approval_context:'clean up completed batch jobs',cwd:process.cwd()},['echo']));
  try {
    for(const name of ['one','two']){expect((await run(name)).isError).toBe(true);const row=(await svc.list({status:'pending'}))[0];expect(row.approval_context).toBe('clean up completed batch jobs');await svc.approve(row.id,'operator');expect((await run(name)).isError).toBe(false);}
    expect((await run('three')).isError).toBe(false);
    expect((await svc.list()).filter(r=>r.consent_method==='grant')).toHaveLength(1);
    expect(await metrics.registry.metrics()).toMatch(/splicedock_approval_grant_used_total\{[^}]*tool="kubectl",verb="delete"[^}]*\} 1/);
    const invalid=await callCliPassthrough(cfg,'run',{args:['delete','job','four'],approval_context:'x'.repeat(501)},['echo']);expect(invalid.isError).toBe(true);
  } finally {setApprovalHookFactory(null);setApprovalSettler(null);await store.close();}
});
