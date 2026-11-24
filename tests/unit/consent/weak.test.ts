import {it,expect} from 'vitest';
import {SplicedockStore} from '../../../src/services/database/adapters/store.js';
import {ConsentStore,hash} from '../../../src/services/approvals/consent-store.js';
import {WeakConsent} from '../../../src/services/approvals/adapters/fastify/weak.js';
it('dormant weak consent binds credentials per token, limits attempts and never executes',async ()=>{
 const db=await SplicedockStore.open(':memory:');const store=await ConsentStore.open(db.consentDatabase());const now=Date.now();
 for(const [id,token] of [['a','A'],['b','B'],['c','A']])await db.insertApproval({id,tool:'test',argv_hash:'hash',argv_json:'[]',rule:'approval_subcommands',matched:'x',requested_at:now,expires_at:now+600000,profile:'p',token_id:token,cwd:'/tmp'});
 await store.db.prepare('INSERT INTO consent_credentials(token_id,secret_hash,created_at) VALUES(?,?,?)').run('A',hash('fixture-A'),now);
 expect(await new WeakConsent(store).approve('a','fixture-A',now)).toBe(false);
 const weak=new WeakConsent(store,true);
 expect(await weak.approve('b','fixture-A',now)).toBe(false);
 expect(await weak.approve('a','fixture-A',now)).toBe(true);
 expect(await weak.approve('a','fixture-A',now)).toBe(false);
 for(let i=0;i<3;i++)await weak.approve('c','wrong',now);
 expect((await store.get('c'))?.status).toBe('rejected');expect(await weak.approve('c','fixture-A',now)).toBe(false);await db.close();
});

it("disabled weak issuance is denied",async ()=>{const db=await SplicedockStore.open(":memory:");const w=new WeakConsent(await ConsentStore.open(db.consentDatabase()));expect(await w.issue("missing")).toBeUndefined();await db.close();});

it('concurrent weak approvals sharing one credential approve exactly one',async ()=>{
 const db=await SplicedockStore.open(':memory:');const store=await ConsentStore.open(db.consentDatabase());const now=Date.now();
 for(const id of ['a','b'])await db.insertApproval({id,tool:'test',argv_hash:'hash',argv_json:'[]',rule:'approval_subcommands',matched:'x',requested_at:now,expires_at:now+600000,profile:'p',token_id:'T',cwd:'/tmp'});
 await store.db.prepare('INSERT INTO consent_credentials(token_id,secret_hash,created_at) VALUES(?,?,?)').run('T',hash('fixture-T'),now);
 const weak=new WeakConsent(store,true);
 expect((await Promise.all([weak.approve('a','fixture-T',now),weak.approve('b','fixture-T',now)])).filter(Boolean)).toHaveLength(1);await db.close();
});
