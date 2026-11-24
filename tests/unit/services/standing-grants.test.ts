import { describe, it, expect, vi } from 'vitest';
import { baseShapeKey, kubectlBaseShape, kubectlShape } from '../../../src/services/policy/shape/kubectl.js';
import { contextSimilarity } from '../../../src/services/policy/context/similarity.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
const caller = {profile:'test',tokenId:'fixture',authenticated:true};
const context = 'Clean up completed batch jobs after investigating failed scheduled runs';
const base = ['delete','jobs','fixture','-n','batch'];
describe('kubectl shape', () => {
  it.each(['--all','-A','--all-namespaces','-l=x','--selector=x','--field-selector=x','--force','--grace-period=0','--now','--cascade=orphan','-f=x','--filename=x','-k=x','--kustomize=x','--unknown','-lfoo','-A=true','--all=false'])('rejects %s', flag => {
    expect(kubectlShape([...base,flag],'delete',caller)).toBeNull();
  });
  it.each(['namespace','namespaces','node','nodes','clusterrolebinding','clusterrolebindings','crd','customresourcedefinitions','all','job.batch','jobs.batch','pods.v1','secret','secrets','configmap','configmaps','pvc','persistentvolumeclaim','serviceaccount','serviceaccounts','deployment','__proto__'])('refuses kind %s', kind => {
    expect(kubectlShape(['delete',kind,'fixture','-n','batch'],'delete',caller)).toBeNull();
  });
  it.each([['exec','pod','date'],['exec','pod','--','date']])('refuses exec %j',(...args)=>{
    expect(kubectlShape(args,'exec',caller)).toBeNull();
  });
  it.each(['pod','po','pods','job','jobs'])('accepts only tight aliases %s',kind=>{
    expect(kubectlShape(['delete',kind,'fixture'],'delete',caller)).not.toBeNull();
  });
  it.each(['--grace-period','--timeout','-l','--selector','--field-selector','-o','--output','--cascade','--context'])('base rejection parser consumes %s values without broadening authorization',flag=>{
    const argv=['delete',flag,'value','job','flagged','-nbatch'];
    expect(kubectlBaseShape(argv,'delete',caller)).toEqual(kubectlShape(base,'delete',caller));
    expect(kubectlShape(argv,'delete',caller)).toBeNull();
  });
  it('normalises kinds and names but keeps namespace and caller boundaries', () => {
    const shape = kubectlShape(base,'delete',caller);
    expect(shape).toEqual(kubectlShape(['delete','job/other','--namespace=batch'],'delete',caller));
    for(const args of [['delete','job','x'],['delete','pods','x','-n','batch'],[...base,'pod/other']]) expect(kubectlShape(args,'delete',caller)).not.toEqual(shape);
    expect(kubectlShape(base,'delete',{...caller,profile:'other'})).not.toEqual(shape);
    expect(kubectlShape(base,'delete',{...caller,tokenId:'other'})).not.toEqual(shape);
  });
});
describe('context similarity', () => {
  it('normalises identifiers, retains topic and requires meaningful context', () => {
    expect(contextSimilarity('remove completed jobs 123','Remove completed jobs 456')).toBe(1);
    expect(contextSimilarity(context,'publish a new marketing announcement')).toBeLessThan(0.5);
    expect(contextSimilarity('',context)).toBe(0);
  });
});
describe('standing grants lifecycle', () => {
  async function setup(enabled=true) {
    let now=1000000;
    const store=await SplicedockStore.open(':memory:');
    const svc=new ApprovalService({store,grantsEnabled:enabled,sweepIntervalMs:0,now:()=>now});
    const request=(name:string,ctx:string|undefined=context,who=caller,tool='kubectl',verb='delete',strong=false)=>svc.makeHook(tool,'/workspace',who,strong,ctx)({tool,argv:[verb,'job',name,'-n','batch'],rule:'approval_subcommands',matched:verb});
    const execute=async (name:string)=>{const out=await request(name);await svc.approve(out.id!,'operator');const approved=await request(name);expect(approved.approved).toBe(true);await svc.finalize(approved.id!);await svc.executionResult(approved.id!,true);};
    return {store,svc,request,execute,advance:()=>{now+=7*86400000+1;}};
  }
  it('promotes executed approvals, matches bounded context and records grant use', async () => {
    const {store,svc,request,execute}=await setup();await execute('one');expect(await svc.listGrants()).toHaveLength(0);await execute('two');expect(await svc.listGrants()).toHaveLength(1);
    const out=await request('three');expect(out.approved).toBe(true);
    expect(await store.consentDatabase().prepare('SELECT consent_method,approved_by FROM pending_approvals WHERE id=?').get(out.id)).toMatchObject({consent_method:'grant',approved_by:expect.stringMatching(/^grant:/)});
    expect((await svc.get(out.id!))?.consent_method).toBe('grant');
    expect((await svc.list()).find(r=>r.id===out.id)?.approval_context).toBe(context);
    expect((await request('empty','')).approved).toBe(false);
    expect((await request('foreign',context,{...caller,tokenId:'other'})).approved).toBe(false);
    await store.close();
  });
  it.each(['--all','-A','--all-namespaces','-l','--selector','--field-selector','--force','--grace-period=0','--now','--cascade=orphan','-f','--filename','-k','--kustomize','--unknown'])('falls back to manual even with an active grant for %s',async flag=>{
    const {store,svc,execute}=await setup();await execute('one');await execute('two');
    const out=await svc.makeHook('kubectl','/workspace',caller,false,context)({tool:'kubectl',argv:['delete','job','third', '-n','batch',flag],rule:'approval_subcommands',matched:'delete'});
    expect(out.approved).toBe(false);expect((await svc.get(out.id!))?.status).toBe('pending');await store.close();
  });
  it('missing context cannot match an active grant',async ()=>{
    const {store,svc,execute}=await setup();await execute('one');await execute('two');
    expect((await svc.makeHook('kubectl','/workspace',caller)({tool:'kubectl',argv:['delete','job','third','-n','batch'],rule:'approval_subcommands',matched:'delete'})).approved).toBe(false);await store.close();
  });
  it.each(['40P01', '40001'])('retries a rejected transaction on %s without losing the decision', async code => {
    const {store,svc,request}=await setup();
    const pending=await request('retry');
    const rejected=vi.spyOn(svc.grants,'rejected');
    rejected.mockRejectedValueOnce(Object.assign(new Error('retry'),{code}));
    rejected.mockRejectedValueOnce(Object.assign(new Error('retry'),{code}));
    expect(await svc.reject(pending.id!,'operator')).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(3);
    expect((await svc.get(pending.id!))?.status).toBe('rejected');
    await store.close();
  });
  it('surfaces rejection retry exhaustion and rolls back the decision', async () => {
    const {store,svc,request}=await setup();
    const pending=await request('retry');
    const rejected=vi.spyOn(svc.grants,'rejected').mockRejectedValue(Object.assign(new Error('retry exhausted'),{code:'40P01'}));
    await expect(svc.reject(pending.id!,'operator')).rejects.toThrow('retry exhausted');
    expect(rejected).toHaveBeenCalledTimes(3);
    expect((await svc.get(pending.id!))?.status).toBe('pending');
    await store.close();
  });
  it('rejection revokes and blocks promotion for seven days', async () => {
    const {store,svc,request,execute}=await setup();await execute('one');await execute('two');const pending=await request('new','unrelated maintenance investigation');await svc.reject(pending.id!,'operator');
    expect((await request('three')).approved).toBe(false);await execute('four');await execute('five');expect((await svc.listGrants()).filter(g=>!g.revoked_at)).toHaveLength(0);await store.close();
  });
  it('expires without renewal and suspends after three consecutive failures', async () => {
    const {store,svc,request,execute,advance}=await setup();await execute('one');await execute('two');
    for(let i=0;i<3;i++){const out=await request('failure'+i);expect(out.approved).toBe(true);await svc.finalize(out.id!);await svc.executionResult(out.id!,false);}
    expect((await request('blocked')).approved).toBe(false);advance();expect((await request('expired')).approved).toBe(false);await store.close();
  });
  it('does not reuse released grant approvals after revocation', async () => {
    const {store,svc,request,execute}=await setup();await execute('one');await execute('two');
    const out=await request('three');await svc.release(out.id!);await svc.grants.revoke(undefined,'operator');
    expect((await request('three')).approved).toBe(false);await store.close();
  });
  it('expiry and exhausted use budget stop matching without renewing old evidence',async ()=>{
    const {store,svc,request,execute,advance}=await setup();await execute('one');await execute('two');
    await store.consentDatabase().prepare('UPDATE standing_grants SET use_count=use_count_max').run();expect((await request('budget')).approved).toBe(false);
    advance();expect((await request('expired')).approved).toBe(false);await execute('fresh-one');expect(await svc.listGrants()).toHaveLength(1);await execute('fresh-two');expect(await svc.listGrants()).toHaveLength(2);await store.close();
  });

  it('never matches an active grant across namespaces',async ()=>{
    const {store,svc,execute}=await setup();await execute('one');await execute('two');
    const out=await svc.makeHook('kubectl','/workspace',caller,false,context)({argv:['delete','job','third','-n','other'],rule:'approval_subcommands',matched:'delete'});
    expect(out.approved).toBe(false);await store.close();
  });
  it('two failed approved executions never promote',async ()=>{
    const {store,svc,request}=await setup();
    for(const name of ['one','two']){const out=await request(name);await svc.approve(out.id!,'operator');await svc.finalize((await request(name)).id!);await svc.executionResult(out.id!,false);}
    expect(await svc.listGrants()).toHaveLength(0);await store.close();
  });
  it.each([['delete','job','flagged','-n','batch','--force'],['-n','batch','delete','--force','job','flagged']])('flagged rejection blocks base shape and fresh successes promote after seven days (%j)',async (...argv)=>{
    const {store,svc,request,execute,advance}=await setup();await execute('one');await execute('two');
    const rejected=await svc.makeHook('kubectl','/workspace',caller,false,context)({argv,rule:'approval_subcommands',matched:'delete'});
    expect(await store.consentDatabase().prepare('SELECT shape_key FROM pending_approvals WHERE id=?').get(rejected.id)).toMatchObject({shape_key:null});
    await svc.reject(rejected.id!,'operator');expect((await request('blocked')).approved).toBe(false);
    await execute('blocked-one');await execute('blocked-two');expect((await svc.listGrants()).filter(g=>!g.revoked_at)).toHaveLength(0);
    advance();await execute('fresh-one');expect(await svc.listGrants()).toHaveLength(1);await execute('fresh-two');expect(await svc.listGrants()).toHaveLength(2);await store.close();
  });
  it.each([
    ['delete','--grace-period','0','job','flagged','-n','batch'],
    ['delete','job','flagged','-A'],
    ['delete','job','flagged','-nbatch','--force'],
    ['delete','-l','app=x','job','-n','batch'],
    ['delete','job','flagged','-n','batch','-n','other'],
    ['delete','job,pod','flagged','-n','batch'],
    ['delete','job','flagged','--all-namespaces'],
    ['delete','job','flagged','--namespace'],
    ['delete','--unknown','value','job','flagged','-n','batch'],
  ])('rejection revokes live grants and blocks subsequent plain requests (%j)',async (...argv)=>{
    const {store,svc,request,execute}=await setup();await execute('one');await execute('two');
    const grants=await svc.listGrants();
    expect(grants).toHaveLength(1);
    const rejected=await svc.makeHook('kubectl','/workspace',caller,false,context)({argv,rule:'approval_subcommands',matched:'delete'});
    expect(rejected.approved).toBe(false);
    await svc.reject(rejected.id!,'operator');
    expect((await svc.listGrants()).filter(g=>g.revoked_at===null)).toHaveLength(0);
    for(const grant of grants)expect(await store.consentDatabase().prepare('SELECT 1 FROM grant_blocks WHERE shape_key=?').get(baseShapeKey(grant))).toBeDefined();
    expect((await request('next')).approved).toBe(false);
    await execute('blocked-one');await execute('blocked-two');
    expect((await svc.listGrants()).filter(g=>g.revoked_at===null)).toHaveLength(0);
    await store.close();
  });
  it.each(['-A','--all-namespaces','-nbatch'])('ambiguous namespace %s revokes every matching base without crossing caller or verb boundaries',async flag=>{
    const {store,svc,execute}=await setup();await execute('one');await execute('two');
    const original=(await svc.listGrants())[0];
    const db=store.consentDatabase();
    // Clone a real grant to exercise multiple namespaces/kinds and scope boundaries.
    const clone=async (id:string,profile:string,token:string,verb:string,kind:string,namespace:string)=>{
      await db.prepare(`INSERT INTO standing_grants(id,profile,token_id,tool,verb_path,resource_kind,namespace,object_count_max,flags_allowed,created_at,created_by,source_approval,context_refs,expires_at)
        SELECT ?,?,?,tool,?,?,?,object_count_max,flags_allowed,created_at,created_by,source_approval,context_refs,expires_at FROM standing_grants WHERE id=?`).run(id,profile,token,verb,kind,namespace,original.id);
    };
    await clone('other-base',caller.profile,caller.tokenId,'delete','pod','other');
    await clone('foreign-profile','other',caller.tokenId,'delete','job','batch');
    await clone('foreign-token',caller.profile,'other','delete','job','batch');
    await clone('other-verb',caller.profile,caller.tokenId,'drain','job','batch');
    const rejected=await svc.makeHook('kubectl','/workspace',caller,false,context)({argv:['delete','job','flagged',flag],rule:'approval_subcommands',matched:'delete'});
    await svc.reject(rejected.id!,'operator');
    const rows=await svc.listGrants();
    expect(rows.filter(g=>g.revoked_at===null).map(g=>g.id).sort()).toEqual(['foreign-profile','foreign-token','other-verb']);
    for(const grant of rows.filter(g=>g.revoked_at!==null))expect(await db.prepare('SELECT 1 FROM grant_blocks WHERE shape_key=?').get(baseShapeKey(grant))).toBeDefined();
    await store.close();
  });
  it('release expires a grant reservation after the flag is disabled',async ()=>{
    const {store,svc,request,execute}=await setup();await execute('one');await execute('two');const out=await request('three');
    const disabled=new ApprovalService({store,grantsEnabled:false,sweepIntervalMs:0});
    expect(await disabled.release(out.id!)).toBe(true);expect((await svc.get(out.id!))?.status).toBe('expired');await store.close();
  });
  it('supersedes pending approvals atomically on grant match',async ()=>{
    const {store,svc,request,execute}=await setup();const pending=await request('later');await execute('one');await execute('two');
    expect((await request('later')).approved).toBe(true);expect((await svc.get(pending.id!))?.status).toBe('rejected');expect(await svc.approve(pending.id!,'operator')).toBe(false);await store.close();
  });
  it('does not count pre-flag successes after enabling',async ()=>{
    const {store,svc,execute}=await setup(false);await execute('one');await execute('two');
    const enabled=new ApprovalService({store,grantsEnabled:true,sweepIntervalMs:0,now:()=>1000000});
    const run=async (name:string)=>{const hook=enabled.makeHook('kubectl','/workspace',caller,false,context);const input={argv:['delete','job',name,'-n','batch'],rule:'approval_subcommands' as const,matched:'delete'};const out=await hook(input);await enabled.approve(out.id!,'operator');await enabled.finalize((await hook(input)).id!);await enabled.executionResult(out.id!,true);};
    await run('fresh-one');expect(await enabled.listGrants()).toHaveLength(0);await run('fresh-two');expect(await enabled.listGrants()).toHaveLength(1);expect(await svc.listGrants()).toHaveLength(1);await store.close();
  });
  it('success resets failures and duplicate result reports count only once',async ()=>{
    const {store,svc,request,execute}=await setup();await execute('one');await execute('two');
    const result=async (name:string,ok:boolean)=>{const out=await request(name);expect(out.approved).toBe(true);await svc.finalize(out.id!);await svc.executionResult(out.id!,ok);await svc.executionResult(out.id!,ok);};
    await result('fail-one',false);await result('fail-two',false);await result('success',true);await result('fail-three',false);await result('fail-four',false);
    expect((await svc.listGrants())[0].suspended_at).toBeNull();await result('fail-five',false);expect((await svc.listGrants())[0].suspended_at).not.toBeNull();await store.close();
  });
  it('config exceptions can be removed in WebUI and strong tools remain exceptions',async ()=>{
    const store=await SplicedockStore.open(':memory:');
    const svc=new ApprovalService({store,grantsEnabled:true,grantExceptions:[{tool:'kubectl',verb_path:'delete'}],sweepIntervalMs:0});
    expect(await svc.grants.exception('kubectl','delete',false)).toBe(true);
    await svc.grants.setException('kubectl','delete',false,'operator');expect(await svc.grants.exception('kubectl','delete',false)).toBe(false);
    expect(await svc.grants.exception('kubectl','delete',true)).toBe(true);await store.close();
  });
  it('flag off preserves manual flow and no context never promotes', async () => {
    for(const enabled of [false,true]){const {store,svc,request}=await setup(enabled);for(let i=0;i<3;i++){const name=String(i);const out=await request(name,'');await svc.approve(out.id!,'operator');await svc.finalize((await request(name,'')).id!);}expect(await svc.listGrants()).toHaveLength(0);await store.close();}
    const {store,svc,execute,request}=await setup(false);await execute('one');await execute('two');expect((await request('three')).approved).toBe(false);expect(await svc.listGrants()).toHaveLength(0);await store.close();
  });
  it.each([['kubectl','drain',false],['kubectl','delete',true]])('never promotes exceptions %s %s', async (tool,verb,strong)=>{
    const {store,svc,request}=await setup();for(let i=0;i<2;i++){const out=await request(String(i),context,caller,tool,verb,strong);if(!strong){await svc.approve(out.id!,'operator');await svc.finalize((await request(String(i),context,caller,tool,verb,strong)).id!);}}expect(await svc.listGrants()).toHaveLength(0);await store.close();
  });
});
