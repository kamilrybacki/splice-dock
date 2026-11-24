export interface ShadowFeatures {tool:string;profile:string;subcommand_class:'read'|'write'|'other';argc_bucket:number;flags_present:readonly string[];cwd_class:'present'|'none'}
export type Prediction={label:'allow'|'escalate';confidence:number};
export type Provider=(features:Readonly<ShadowFeatures>,signal:AbortSignal)=>Promise<Prediction>;
