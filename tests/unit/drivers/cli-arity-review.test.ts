import {describe,it,expect} from 'vitest';
import {compilePolicy,evaluatePolicy,PolicyCompileError} from '../../../src/services/policy/cli/rules.js';
import {flagTableFor,invocationFlagTable} from '../../../src/services/policy/cli/flags/arity.js';
describe('Review D command-dependent arity',()=>{
  it.each([
    [['pr','create'],'f','bool'],[['pr','create'],'F','value'],
    [['pr','merge'],'m','bool'],[['issue','edit'],'m','value'],
    [['auth','status'],'h','value'],[['pr','view'],'q','value'],
  ] as const)('resolves %j %s as %s',(argv,flag,arity)=>{
    expect(invocationFlagTable('gh',argv,flagTableFor('gh')).short.get(flag)).toBe(arity);
  });
  it('ambiguous shorthand before the command stays unknown',()=>{
    expect(invocationFlagTable('gh',['-f','pr','create'],flagTableFor('gh')).short.get('f')).toBeUndefined();
  });
  it('duplicate fill aliases cannot satisfy a single required option',()=>{
    const p=compilePolicy({max_args:256,audit:false,on_violation:'deny',require_args:['--fill']},{command:'gh'});
    expect(evaluatePolicy(['pr','create','--fill','-f'],p).ok).toBe(false);
    expect(evaluatePolicy(['pr','create','--fill'],p).ok).toBe(true);
  });
  it('unknown arity cannot hide duplicate required options',()=>{
    const p=compilePolicy({max_args:256,audit:false,on_violation:'deny',require_args:['--foo']});
    expect(evaluatePolicy(['--foo','--foo'],p).ok).toBe(false);
  });
  it('short clusters fail closed when required evidence is needed',()=>{
    const p=compilePolicy({max_args:256,audit:false,on_violation:'deny',require_args:['--namespace=ns']},{command:'kubectl'});
    expect(evaluatePolicy(['get','pods','-Anns'],p).ok).toBe(false);
  });
});

it('body-file aliases cannot override a required safe file',()=>{
 const p=compilePolicy({max_args:256,audit:false,on_violation:'deny',require_args:['--body-file=/safe']},{command:'gh'});
 expect(evaluatePolicy(['pr','create','--body-file=/safe','-F','/evil'],p).ok).toBe(false);
});
it.each(['require_args','require_any_of'] as const)('required draft must be enabled: %s',key=>{
 const p=compilePolicy({max_args:256,audit:false,on_violation:'deny',[key]:key==='require_args'?['--draft']:[['--draft']]},{command:'gh'});
 expect(evaluatePolicy(['pr','create','--draft=false'],p).ok).toBe(false);
 expect(evaluatePolicy(['pr','create','--draft'],p).ok).toBe(true);
});
it.each(['create','new'])('canonical pr %s aliases enforce body-file and draft',verb=>{
 const policy=(require_args:string[])=>compilePolicy({max_args:256,audit:false,on_violation:'deny',require_args},{command:'gh'});
 expect(evaluatePolicy(['pr',verb,'--body-file=/safe','-F','/evil'],policy(['--body-file=/safe'])).ok).toBe(false);
 expect(evaluatePolicy(['pr',verb,'-F','/safe'],policy(['--body-file=/safe'])).ok).toBe(true);
 expect(evaluatePolicy(['pr',verb,'-d=false'],policy(['--draft'])).ok).toBe(false);
 expect(evaluatePolicy(['pr',verb,'--draft','-d'],policy(['--draft'])).ok).toBe(false);
 expect(evaluatePolicy(['pr',verb,'--','--draft'],policy(['--draft'])).ok).toBe(false);
 expect(evaluatePolicy(['pr',verb,'--head=safe','-H','evil'],policy(['--head=safe'])).ok).toBe(false);
});

describe('bare requirements on value-taking flags are rejected at compile time',()=>{
  const compile=(policy:{require_args?:string[];require_any_of?:string[][];value_flags?:string[]},command?:string)=>
    compilePolicy({max_args:256,audit:false,on_violation:'deny',...policy},{command});
  it.each([
    ['require_args',{require_args:['--namespace']},'--namespace'],
    ['require_args',{require_args:['-n']},'-n'],
    ['require_any_of',{require_any_of:[['--context=a'],['--namespace']]},'--namespace'],
  ] as const)('%s %j names the flag',(field,policy,flag)=>{
    expect(()=>compile(policy,'kubectl')).toThrow(PolicyCompileError);
    expect(()=>compile(policy,'kubectl')).toThrow(new RegExp(`policy\\.${field}: bare requirement "${flag}" names a value-taking flag`));
  });
  it('a policy value_flags override makes a bare requirement unsatisfiable too',()=>{
    expect(()=>compile({require_args:['--foo'],value_flags:['--foo']})).toThrow(/bare requirement "--foo"/);
  });
  it.each([
    [{require_args:['--namespace=a']},'kubectl'],
    [{require_args:['-n=a']},'kubectl'],
    [{require_any_of:[['--namespace=a','-n=b']]},'kubectl'],
    [{require_args:['--fill']},'gh'],
    [{require_args:['--foo']},undefined],
    [{require_args:['get']},'kubectl'],
  ] as const)('accepts %j for %s',(policy,command)=>{
    expect(()=>compile(policy,command)).not.toThrow();
  });
  it('the =value form still enforces the exact value',()=>{
    const p=compile({require_args:['--namespace=a']},'kubectl');
    expect(evaluatePolicy(['get','pods','-n','a'],p).ok).toBe(true);
    expect(evaluatePolicy(['get','pods','--namespace=b'],p).ok).toBe(false);
  });
});

describe('kubectl required namespace conflicts with all-namespaces',()=>{
  const ns=(policy:{require_args?:string[];require_any_of?:string[][]})=>
    compilePolicy({max_args:256,audit:false,on_violation:'deny',...policy},{command:'kubectl'});
  it.each([
    [['get','pods','--namespace=s','-A']],
    [['get','pods','-n','s','--all-namespaces']],
    [['get','pods','--namespace','s','--all-namespaces=true']],
    [['get','pods','-A','-n=s']],
    // pflag ParseBool spellings; any value, even false, fails closed.
    [['get','pods','-n','s','--all-namespaces=1']],[['get','pods','-n','s','--all-namespaces=t']],
    [['get','pods','-n','s','--all-namespaces=TRUE']],[['get','pods','-n','s','--all-namespaces=True']],
    [['get','pods','-n','s','--all-namespaces=false']],
  ])('require_args denies %j as a conflict',argv=>{
    const d=evaluatePolicy(argv,ns({require_args:['--namespace=s']}));
    expect(d).toMatchObject({ok:false,rule:'require_args',matched:'--namespace=s'});
    expect(d.ok===false && d.message).toMatch(/conflicts with --all-namespaces/);
  });
  // The namespace gate reads short clusters exactly as kubectl does, so the
  // grouped -A is found and refused by name (it used to be refused earlier, as
  // ambiguous argv, by the generic arity pre-check).
  it.each([['-wA'],['-Aw']])('grouped short bools %s carrying -A are refused before any requirement check',flag=>{
    const d=evaluatePolicy(['get','pods','-n','s',flag],ns({require_args:['--namespace=s']}));
    expect(d).toMatchObject({ok:false,rule:'require_args',matched:'--namespace=s'});
    expect(d.ok===false && d.message).toMatch(/conflicts with --all-namespaces/);
  });
  it('require_any_of cannot be satisfied by a namespace that -A overrides',()=>{
    const d=evaluatePolicy(['get','pods','-n','s','-A'],ns({require_any_of:[['--namespace=s','--namespace=t']]}));
    expect(d).toMatchObject({ok:false,rule:'require_any_of'});
    expect(d.ok===false && d.message).toMatch(/conflicts with --all-namespaces/);
  });
  // A namespace anywhere in the requirements makes the policy a confinement
  // boundary: a non-namespace alternative cannot unlock -A (or --context).
  it('another satisfied alternative in the group does not unlock -A',()=>{
    const d=evaluatePolicy(['get','pods','--context=c','-A'],ns({require_any_of:[['--namespace=s','--context=c']]}));
    expect(d).toMatchObject({ok:false,rule:'require_any_of'});
  });
  it('the namespace alone is still allowed',()=>{
    expect(evaluatePolicy(['get','pods','-n','s'],ns({require_args:['--namespace=s']})).ok).toBe(true);
  });
  it('non-kubectl tools keep their own semantics',()=>{
    const p=compilePolicy({max_args:256,audit:false,on_violation:'deny',require_args:['--namespace=s'],boolean_flags:['--all-namespaces']},{command:'other'});
    expect(evaluatePolicy(['--namespace=s','--all-namespaces'],p).ok).toBe(true);
  });
});
it.each([
  [['issue','create','-l','ok'],true],[['pr','create','-l','ok'],true],
  [['issue','edit','1','-l','ok'],false],[['pr','edit','1','-l','ok'],false],
    [['issue','edit','1','-lok'],false],[['pr','edit','1','-l=ok'],false],
] as const)('gh -l satisfies --label only where gh 2.102 defines it: %j',(argv,ok)=>{
  const p=compilePolicy({max_args:256,audit:false,on_violation:'deny',require_args:['--label=ok']},{command:'gh'});
  expect(evaluatePolicy(argv,p).ok).toBe(ok);
});
