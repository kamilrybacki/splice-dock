/** Dynamic data is rendered only through textContent, including exception names. */
export function renderAutomaticApprovals():string {
  return `<h1>Automatic approvals</h1><a href="/admin/approvals">Approval history</a>
  <p id="state"></p><p>Built-in exceptions (cannot be removed): requireStrong/WebAuthn tools.</p>
  <button id="revoke-all">Revoke all</button><div id="grants"></div>
  <h2>Exceptions</h2><div id="exceptions"></div><form id="add"><label>Tool <input name="tool" required></label><label>Verb <input name="verb_path" value="*" required></label><button>Add exception</button></form>
  <script>(function(){
    async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','x-splicedock-csrf':'1'},body:JSON.stringify(body)});if(!r.ok)throw new Error('Update failed');location.reload();}
    document.getElementById('revoke-all').onclick=()=>post('/api/v1/grants/all/revoke',{});
    document.getElementById('add').onsubmit=e=>{e.preventDefault();const data=new FormData(e.target);post('/api/v1/grant-exceptions',{tool:data.get('tool'),verb_path:data.get('verb_path')});};
    fetch('/api/v1/grants').then(r=>r.json()).then(view=>{
      document.getElementById('state').textContent=view.enabled?'Enabled. Grants expire after seven days without renewal.':'Disabled. All operations require manual approval.';
      for(const g of view.data){const row=document.createElement('p');const status=g.revoked_at?'revoked':g.suspended_at?'suspended':g.expires_at<=Date.now()?'expired':'active';row.textContent=[g.tool,g.verb_path,g.resource_kind,g.namespace,'prefix '+(g.name_prefix??'(none: never matches)'),g.profile,status,'uses '+g.use_count+'/'+g.use_count_max,'last use '+(g.last_used_at?new Date(g.last_used_at).toISOString():'never'),'expires '+new Date(g.expires_at).toISOString()].join(' | ');const b=document.createElement('button');b.textContent='Revoke';b.onclick=()=>post('/api/v1/grants/'+encodeURIComponent(g.id)+'/revoke',{});row.append(b);document.getElementById('grants').append(row);}
      for(const e of view.exceptions){const row=document.createElement('p');row.textContent=e.tool+' '+e.verb_path;const b=document.createElement('button');b.textContent='Remove';b.onclick=()=>post('/api/v1/grant-exceptions',{tool:e.tool,verb_path:e.verb_path,remove:true});row.append(b);document.getElementById('exceptions').append(row);}
    });
  })();</script>`;
}
