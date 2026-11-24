import { randomBytes } from 'node:crypto';
import { canonicalizeArgv } from '../../../policy/operation.js';
import type { ConsentRow } from '../../consent/store.js';
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function consentPage(r:ConsentRow):{html:string;nonce:string} {
  const nonce=randomBytes(24).toString('base64');
  const argv=canonicalizeArgv(JSON.parse(r.argv_json));
  const display=JSON.stringify({tool:r.tool,argv,cwd:r.cwd,profile:r.profile,tokenIdentity:r.token_id,expires_at:r.expires_at,op_hash:r.op_digest?.slice(0,16)},null,2);
  return {nonce,html:`<!doctype html><html><meta charset="utf-8"><title>Splicedock consent</title><h1>Review operation</h1><pre>${escape(display)}</pre><button id="approve">Approve with security key</button><button id="reject">Reject</button><p id="status"></p><script nonce="${nonce}">
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const bytes=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const post=async(p,body)=>{const r=await fetch(location.pathname+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});if(!r.ok)throw Error('Consent refused');return r.json()};
document.getElementById('approve').onclick=async()=>{try{const o=await post('/options');const id=o.id;delete o.id;o.challenge=bytes(o.challenge);o.allowCredentials=o.allowCredentials.map(c=>({...c,id:bytes(c.id)}));const c=await navigator.credentials.get({publicKey:o});await post('/verify',{id,response:{id:c.id,rawId:b64(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment,response:{clientDataJSON:b64(c.response.clientDataJSON),authenticatorData:b64(c.response.authenticatorData),signature:b64(c.response.signature),userHandle:c.response.userHandle?b64(c.response.userHandle):undefined}}});document.getElementById('status').textContent='Approved';}catch{document.getElementById('status').textContent='Consent refused';}};
document.getElementById('reject').onclick=async()=>{try{await post('/reject');document.getElementById('status').textContent='Rejected';}catch{document.getElementById('status').textContent='Consent refused';}};
</script></html>`};
}
