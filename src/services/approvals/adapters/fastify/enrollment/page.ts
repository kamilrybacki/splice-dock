import { randomBytes } from 'node:crypto';
export function enrollmentPage() {
  const nonce=randomBytes(24).toString('base64');
  return {nonce,html:`<!doctype html><html><meta charset="utf-8"><title>Enroll security key</title><h1>Enroll operator hardware key</h1><p>Use a physical FIDO2 key with a PIN. Enroll primary and backup separately. Synced passkeys and keys without an increasing signature counter are refused.</p><label>Label <input id="label" maxlength="64" value="primary"></label><button id="enroll">Enroll security key</button><p id="status"></p><script nonce="${nonce}">
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const bytes=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const post=async(p,body)=>{const r=await fetch('/api/v1/webauthn/register/'+p,{method:'POST',headers:{'Content-Type':'application/json','x-splicedock-csrf':'1'},body:JSON.stringify(body||{})});if(!r.ok)throw Error();return r.json()};
document.getElementById('enroll').onclick=async()=>{try{const o=await post('options');const id=o.id;delete o.id;o.challenge=bytes(o.challenge);o.user.id=bytes(o.user.id);o.excludeCredentials=o.excludeCredentials.map(c=>({...c,id:bytes(c.id)}));const c=await navigator.credentials.create({publicKey:o});await post('verify',{id,label:document.getElementById('label').value,response:{id:c.id,rawId:b64(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:b64(c.response.clientDataJSON),attestationObject:b64(c.response.attestationObject),transports:c.response.getTransports()}}});document.getElementById('status').textContent='Key registered';}catch{document.getElementById('status').textContent='Registration refused';}};
</script></html>`};
}
