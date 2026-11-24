import { argvHash } from '../../../src/services/approvals/base.js';
import { describe, it, expect } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ConsentStore } from '../../../src/services/approvals/consent/store.js';

describe('consent persistence', () => {
  it('strong reservation requires WebAuthn, exact identity, digest and enabled service',async ()=>{
    const s=await SplicedockStore.open(':memory:');const c=await ConsentStore.open(s.consentDatabase());const now=Date.now();const hash=argvHash('repo_delete','/tmp',['delete']);
    await s.insertApproval({id:'strong',tool:'repo_delete',argv_hash:hash,argv_json:'["delete"]',rule:'approval_subcommands',matched:'delete',requested_at:now,expires_at:now+600000,profile:'p',token_id:'t',cwd:'/tmp'});await c.bind('strong');
    await c.db.prepare("UPDATE pending_approvals SET status='approved',consent_method='admin_api'").run();
    expect(await s.reserveBoundApproval('repo_delete',hash,'p','t','/tmp',now)).toBeNull();
    await c.db.prepare("UPDATE pending_approvals SET consent_method='webauthn'").run();
    expect(await s.reserveBoundApproval('repo_delete',hash,'p','other','/tmp',now)).toBeNull();
    expect(await s.reserveBoundApproval('repo_delete',hash,'p','t','/other',now)).toBeNull();
    expect(await s.reserveBoundApproval('repo_delete',hash,'p','t','/tmp',now,false)).toBeNull();
    await c.db.prepare("UPDATE pending_approvals SET argv_json='[\"mutated\"]'").run();
    expect(await s.reserveBoundApproval('repo_delete',hash,'p','t','/tmp',now)).toBeNull();await s.close();
  });
  it('migrates twice and preserves history; admin approval cannot authorize strong', async () => {
    const s = await SplicedockStore.open(':memory:');
    const c = await ConsentStore.open(s.consentDatabase());
    await ConsentStore.open(s.consentDatabase());
    await s.insertApproval({id:'test',tool:'repo_delete',argv_hash:'hash',argv_json:'[]',rule:'approval_subcommands',matched:'delete',requested_at:1,expires_at:1000,profile:'p',token_id:'t',cwd:'/tmp'});
    await c.bind('test');
    expect(await s.approveApproval('test','admin',2)).toBe(false);
    expect((await c.get('test'))?.level).toBe('strong');
    await s.close();
  });
});
