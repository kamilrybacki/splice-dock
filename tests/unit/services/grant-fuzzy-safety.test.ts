import { builtinShapes } from '../../../src/builtin-backends.js';
import { describe, it, expect } from 'vitest';
import { kubectlBaseShape, kubectlShape } from '../../../src/services/policy/shape/kubectl.js';
import { escalates } from '../../../src/services/policy/context/escalation.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
const caller = {profile:'test',tokenId:'fixture',authenticated:true};
const context = 'Clean up completed batch jobs after investigating failed scheduled runs';
async function setup() {
  let now=1000000;
  const store=await SplicedockStore.open(':memory:');
  const svc=new ApprovalService({store,grantsEnabled:true,grantNamespaces:['batch','other'],sweepIntervalMs:0,shapes:builtinShapes,now:()=>now});
  const request=(...argv:string[])=>svc.makeHook('kubectl','/workspace',caller,false,context)({tool:'kubectl',argv,rule:'approval_subcommands',matched:'delete'});
  const execute=async (...argv:string[])=>{const out=await request(...argv);await svc.approve(out.id!,'operator');const approved=await request(...argv);expect(approved.approved).toBe(true);await svc.finalize(approved.id!);await svc.executionResult(approved.id!,true);};
  const live=async ()=>(await svc.listGrants()).filter(g=>g.revoked_at===null);
  return {store,svc,request,execute,live,advance:()=>{now+=7*86400000+1;}};
}
describe('mixed-kind kubectl rejection', () => {
  it.each([
    ['delete','job/a','pod/b','-n','batch'],
    ['delete','pod/b','jobs/a','-n','batch'],
    ['delete','job','a','pod/b','-n','batch'],
    ['delete','job/a','b','-n','batch'],
  ])('has no precise base shape (%j)',(...argv)=>{
    expect(kubectlBaseShape(argv,'delete',caller)).toBeNull();
  });
  it.each([
    [['delete','job/a','jobs/b','-n','batch'],['delete','job','x','-n','batch']],
    [['delete','pods','a','po/b','c','-n','batch'],['delete','pod','x','-n','batch']],
  ])('keeps a precise base shape for one kind (%j)',(argv,plain)=>{
    expect(kubectlBaseShape(argv,'delete',caller)).toEqual(kubectlShape(plain,'delete',caller));
  });
  it('revokes a grant of every kind named in the rejected command',async ()=>{
    const {store,svc,request,execute,live}=await setup();
    await execute('delete','pod','job-one','-n','batch');await execute('delete','pod','job-two','-n','batch');await execute('delete','pod','job-three','-n','batch');
    expect(await live()).toHaveLength(1);
    const rejected=await request('delete','job/a','pod/b','-n','batch');
    expect(rejected.approved).toBe(false);await svc.reject(rejected.id!,'operator');
    expect(await live()).toHaveLength(0);
    expect((await request('delete','pod','job-b','-n','batch')).approved).toBe(false);
    await store.close();
  });
});
describe('ambiguous rejection without an existing grant', () => {
  it.each([
    ['delete','job','--all','-A'],
    ['delete','job/a','pod/b','-n','batch'],
    ['delete','job','flagged','-nbatch'],
  ])('resets learning evidence for the caller scope (%j)',async (...argv)=>{
    const {store,svc,request,execute,live,advance}=await setup();
    await execute('delete','job','job-one','-n','batch');
    const rejected=await request(...argv);await svc.reject(rejected.id!,'operator');
    await execute('delete','job','job-two','-n','batch');await execute('delete','job','job-three','-n','batch');await execute('delete','job','job-four','-n','batch');
    expect(await live()).toHaveLength(0);
    // Other bases in the same caller/tool/verb scope are blocked as well.
    await execute('delete','pod','job-one','-n','other');await execute('delete','pod','job-two','-n','other');await execute('delete','pod','job-three','-n','other');
    expect(await live()).toHaveLength(0);
    advance();
    await execute('delete','job','job-fresh-one','-n','batch');await execute('delete','job','job-fresh-two','-n','batch');expect(await live()).toHaveLength(0);
    await execute('delete','job','job-fresh-three','-n','batch');expect(await live()).toHaveLength(1);
    await store.close();
  });
  it('does not match a grant in a scope-blocked caller scope',async ()=>{
    const {store,svc,request,execute}=await setup();
    await execute('delete','job','job-one','-n','batch');await execute('delete','job','job-two','-n','batch');await execute('delete','job','job-three','-n','batch');
    const original=(await svc.listGrants())[0];
    const rejected=await request('delete','job','--all','-A');await svc.reject(rejected.id!,'operator');
    await store.consentDatabase().prepare(`INSERT INTO standing_grants(id,profile,token_id,tool,verb_path,resource_kind,namespace,object_count_max,flags_allowed,name_prefix,created_at,created_by,source_approval,context_refs,expires_at)
      SELECT 'late',profile,token_id,tool,verb_path,'pod','other',object_count_max,flags_allowed,'job-',created_at,created_by,source_approval,context_refs,expires_at FROM standing_grants WHERE id=?`).run(original.id);
    expect((await request('delete','pod','job-x','-n','other')).approved).toBe(false);
    await store.close();
  });
  it('a precise rejection does not block other bases of the scope',async ()=>{
    const {store,svc,request,execute,live}=await setup();
    const rejected=await request('delete','job','flagged','-n','batch');await svc.reject(rejected.id!,'operator');
    await execute('delete','pod','job-one','-n','other');await execute('delete','pod','job-two','-n','other');await execute('delete','pod','job-three','-n','other');
    expect(await live()).toHaveLength(1);
    await store.close();
  });
});
describe('identifier-only context escalates', () => {
  it.each([
    ['123','987'],
    ['0xdeadbeef','42'],
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301','deadbeefcafe'],
    ['123 456','123 456'],
    ['1e3','9e8'],
    ['1.5e-3 v2','2E+9 x86'],
    ['restart 1 2 3 4 5 6 7 8','publish 11 12 13 14 15 16 17 18'],
    ['restart 1e3 2e3 3e3 4e3','publish 5e9 6e9 7e9 8e9'],
  ])('identifiers alone or as padding are not a reason (%s vs %s)',(a,b)=>{
    expect(escalates(a,b)).toBe(true);
  });
  it('differing identifiers inside a meaningful context do not escalate',()=>{
    expect(escalates('restart job 123','restart job 456')).toBe(false);
    expect(escalates('restart job 3f2504e0-4f89-11d3-9a0c-0305e82c3301','restart job 0xdeadbeef')).toBe(false);
  });
});
