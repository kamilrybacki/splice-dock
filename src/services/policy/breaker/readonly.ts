/** Closed, deliberately small exemption vocabulary. No flags, plugins or HTTP APIs. */
export function breakerReadonly(tool:string,argv:readonly string[]):boolean {
 if(tool==='gh')return argv.length===2 && ['repo view','repo list','pr list','issue list','run list'].includes(argv.join(' '));
 if(tool==='kubectl')return argv.length===2 && argv[0]==='get' && ['pods','services','deployments','namespaces','nodes'].includes(argv[1]!);
 return false;
}
