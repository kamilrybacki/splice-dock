export interface Observation {tool:string;profile:string;argv:readonly string[];cwd:string|null}
export interface ShadowFeatures {tool:string;profile:string;subcommand_class:'read'|'write'|'other';argc_bucket:number;flags_present:readonly string[];cwd_class:'present'|'none'}
/** Caller supplies only configured tool/profile names. Argument values never cross the provider boundary. */
export function features(o:Observation):ShadowFeatures {
 const verb=o.argv[0]??'';
 return Object.freeze({tool:o.tool,profile:o.profile,subcommand_class:['get','list','show','view','status'].includes(verb)?'read':['delete','create','edit','apply','update'].includes(verb)?'write':'other',argc_bucket:Math.min(4,Math.ceil(Math.log2(o.argv.length+1))),flags_present:Object.freeze(['--force','--dry-run','--all','--yes'].filter(f=>o.argv.includes(f))),cwd_class:o.cwd?'present' as const:'none' as const});
}
