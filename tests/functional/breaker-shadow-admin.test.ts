import {it,expect} from 'vitest';
import {createAdminServer} from '../../src/adapters/inbound/admin/server.js';
import {splicedockConfigSchema} from '../../src/config/schema.js';
import {SplicedockStore} from '../../src/adapters/outbound/persistence/store.js';
import {ToolRegistry} from '../../src/application/registry/tool-registry.js';
import {ProfileRegistry} from '../../src/application/registry/profile-registry.js';
import {ToolService} from '../../src/application/tools/tool-service.js';
import {ProfileService} from '../../src/application/profiles/profile-service.js';
import {PolicyStore} from '../../src/application/policy/policy-store.js';
import {AuditBuffer} from '../../src/application/audit/audit-buffer.js';
import {ToolMetrics} from '../../src/application/metrics/tool-metrics.js';
import {CircuitBreaker} from '../../src/application/policy/circuit-breaker.js';
import {ShadowObserver} from '../../src/application/shadow/queue.js';
it('breaker controls and shadow summary require trusted admin authentication',async()=>{
 const c=splicedockConfigSchema.parse({});const store=await SplicedockStore.open(':memory:');
 const tools=new ToolRegistry(),profiles=new ProfileRegistry();
 const breaker=await CircuitBreaker.create(store.consentDatabase(),c.server.breaker);await breaker.record(undefined,true);
 const shadow=await ShadowObserver.create(store.consentDatabase(),c.server.shadow);
 const env=c.server.admin_token_env,previous=process.env[env];process.env[env]='local-test-admin';
 const server=await createAdminServer(tools,profiles,new ToolService(tools),new ProfileService(profiles,tools),new Map(),c,undefined,{store,breaker,shadow,policyStore:new PolicyStore(store),auditBuffer:new AuditBuffer(),toolMetrics:new ToolMetrics(store)});
 try{
 for(const [method,url] of [['GET','/api/v1/shadow/summary'],['GET','/api/v1/breaker'],['POST','/api/v1/breaker/global/reset']] as const){
 expect((await server.inject({method,url})).statusCode).toBe(401);
 expect((await server.inject({method,url,headers:{authorization:'Bearer invalid'}})).statusCode).toBe(401);
 expect((await server.inject({method,url,headers:{authorization:'Bearer local-test-admin'}})).statusCode).toBe(200);
 }
 expect((await store.consentDatabase().prepare('SELECT actor FROM breaker_audit ORDER BY id DESC LIMIT 1').get() as {actor:string}).actor).toBe('admin');
 }finally{await server.close();await store.close();if(previous===undefined)delete process.env[env];else process.env[env]=previous;}
});
