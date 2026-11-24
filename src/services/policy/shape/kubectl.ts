import type { CallerIdentity } from '../../../common/request/context.js';
import type { OperationShape } from './base.js';
const ALLOWED = ['-n', '--namespace', '--wait'] as const;
export const GRANTABLE_KUBECTL_PAIRS: Readonly<Record<string, Readonly<Record<string,string>>>> = {
  delete: {pod:'pod',po:'pod',pods:'pod',job:'job',jobs:'job'},
};
function kind(value:string):string {return GRANTABLE_KUBECTL_PAIRS.delete[value] ?? value;}
/** Rejections apply to the base operation even when extra flags make it ungrantable.
 * This extractor can only deny/reset evidence; it never authorizes execution. */
export function kubectlBaseShape(argv: readonly string[], verb: string, caller: CallerIdentity): OperationShape | null {
  const namespaceArgs: string[] = [];
  const positional: string[] = [];
  const valueFlags = new Set(['--grace-period','--timeout','-l','--selector','--field-selector','-o','--output','--cascade','--context','-f','--filename','-k','--kustomize']);
  const booleanFlags = new Set(['--force','--now','--all','--wait']);
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i];
    const flag=arg.split('=')[0];
    // A namespace spanning the cluster cannot safely identify one base grant.
    if(flag==='-A' || flag==='--all-namespaces')return null;
    if(arg==='-n' || arg==='--namespace')namespaceArgs.push(arg,argv[++i] ?? '');
    else if(arg.startsWith('--namespace=') || arg.startsWith('-n='))namespaceArgs.push(arg);
    else if(arg.startsWith('-n'))namespaceArgs.push('-n',arg.slice(2));
    else if(valueFlags.has(flag)) {
      if(!arg.includes('=') && (!argv[++i] || argv[i].startsWith('-')))return null;
    } else if(booleanFlags.has(flag))continue;
    // Unknown options may take values: do not mistake one for the resource kind.
    else if(arg.startsWith('-'))return null;
    else positional.push(arg);
  }
  // Over-blocking an ambiguous rejection is safe; granting uses the strict parser.
  if (positional[0] !== verb || !positional[1]) return null;
  return kubectlShape([verb,positional[1].split('/')[0],'rejection',...namespaceArgs],verb,caller);
}
/** Deliberately conservative: unknown syntax, flags or resource mixtures require consent. */
export function kubectlShape(argv: readonly string[], verb: string, caller: CallerIdentity): OperationShape | null {
  if (!caller.authenticated || !caller.profile || !caller.tokenId) return null;
  const positional:string[]=[];
  let namespace='<default>', seenNamespace=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg.startsWith('-')) {
      const [flag,...values]=arg.split('=');
      if(!(ALLOWED as readonly string[]).includes(flag))return null;
      let value=values.length ? values.join('=') : undefined;
      if(flag==='--wait') {if(value!==undefined && value!=='true' && value!=='false')return null;continue;}
      value ??= argv[++i];
      if(seenNamespace || !value || !/^[a-z0-9][a-z0-9-]*$/.test(value))return null;
      namespace=value;seenNamespace=true;
    } else positional.push(arg);
  }
  if(positional.shift()!==verb || verb.includes(' '))return null;
  const first=positional.shift();if(!first)return null;
  const parts=first.split('/');if(parts.length>2)return null;
  if(!Object.hasOwn(GRANTABLE_KUBECTL_PAIRS,verb) || !Object.hasOwn(GRANTABLE_KUBECTL_PAIRS[verb],parts[0]))return null;
  const resource=GRANTABLE_KUBECTL_PAIRS[verb][parts[0]];
  const names=parts.length===2 ? [first,...positional] : positional;
  if(!names.length || names.length>5)return null;
  for(const name of names){const pieces=name.split('/');if(pieces.length>2 || (pieces.length===2 && kind(pieces[0])!==resource) || !/^[a-z0-9][a-z0-9.-]*$/.test(pieces.at(-1)!))return null;}
  return {profile:caller.profile,token_id:caller.tokenId,tool:'kubectl',verb_path:verb,resource_kind:resource,namespace,object_count_max:5,flags_allowed:ALLOWED};
}

const READONLY_KUBECTL_KINDS = ['pods', 'services', 'deployments', 'namespaces', 'nodes'];
/** Breaker exemption: exactly `kubectl get <kind>` for a few plain kinds. */
export function kubectlReadonlyProbe(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === 'get' && READONLY_KUBECTL_KINDS.includes(argv[1]!);
}
