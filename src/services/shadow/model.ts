import type { Prediction, Provider, ShadowFeatures } from '../../contracts/outbound/shadow-model.js';

/** No endpoint or credentials are inferred from process environment. Deployment must explicitly inject a self-hosted adapter. */
export const unavailable:Provider=async()=>{throw new Error('unavailable');};
export function modelAdapter(infer:(input:Readonly<ShadowFeatures>,signal:AbortSignal)=>Promise<unknown>):Provider {
 return async(input,signal)=>{
 const value=await infer(input,signal);
 if(!value||typeof value!=='object')throw new Error('invalid_response');
 const p=value as Prediction;
 if(!['allow','escalate'].includes(p.label)||typeof p.confidence!=='number'||!Number.isFinite(p.confidence)||p.confidence<0||p.confidence>1)throw new Error('invalid_response');
 return {label:p.label,confidence:p.confidence};
 };
}
