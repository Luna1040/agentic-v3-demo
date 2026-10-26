import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { postgresFixture } from './pg-helper.ts';
import { createApp } from '../server/app.ts';
import { appendRuntimeAudit } from '../server/runtime-audit.ts';
import { ServiceError,type StoryRuntime } from '../server/runtime.ts';

async function send(f:Awaited<ReturnType<typeof postgresFixture>>,sessionId:string,content='把信放好。'){
 const turn=await f.store.beginTurn('alice',sessionId,randomUUID(),content),text='林晚说：“我会收好这封信。”';
 const result={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},scene:turn.input.scene,observations:{'lin-wan':content}};
 await f.store.commitDialogue(turn,result);return {turn,result};
}
test('capture retains actual entity/memory/event transitions and raw candidates; audit is append-only and owner scoped',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');const capture=await f.store.startRuntimeCapture('alice',s.world.id);
  assert.equal(capture.capture?.expectedTurns,7);assert.equal(capture.turns.length,0);
  const {turn,result}=await send(f,s.session.id);const job=await f.store.claimSettlement();assert(job);
  await f.store.saveSettlementCall(job,{id:'worldops-call',parentId:null,attemptId:job.attempt,agent:'updater',status:'completed',model:'fixture',startedAt:new Date().toISOString(),input:{question:'保存信封'},output:{commands:['memory','item']}});
  const own=(await f.store.getWorld('alice',s.world.id)).entities!.find(e=>e.id==='lin-wan')!;const itemId=randomUUID();
  const event={id:'letter-event',kind:'item' as const,subjectId:'lin-wan',summary:'收好信封',phase:'planned' as const,sourceTurnId:turn.id,lastSourceTurnId:turn.id,evidenceIds:['letter-source'],entityId:itemId,version:1};
  const settlement={...result,entityChanges:[
   {op:'update' as const,entity:{id:'lin-wan',kind:'npc' as const,name:own.name,description:own.description,state:{arc:'林晚答应收好信封。'}},arcSource:{source:'actor' as const,characterId:'lin-wan',quote:result.text},witnessedByCharacterIds:['lin-wan']},
   {op:'create' as const,entity:{id:itemId,kind:'item' as const,name:'信封',description:'准备收好。',state:{pendingIntent:{phase:'planned',summary:'收好信封'}},knownByCharacterIds:['lin-wan']}},
  ],eventLedger:[event],deferredCommands:[{id:'raw-candidate',command:{type:'item',name:'尚未采用的候选'},reason:'待核查',evidenceIds:[]}]};
  await f.store.saveSettlementResult(job,settlement);assert(await f.store.completeSettlement(job));
  const view=await f.store.runtimeAudit('alice',s.world.id);assert.equal(view.turns.length,1);assert.equal(view.turns[0].id,turn.id);assert.equal(view.turns[0].userText,'把信放好。');assert.equal(view.calls,undefined);
  for(const kind of ['capture_started','queued','claimed','result_saved','committed','director_requested'])assert(view.events.some(e=>e.kind===kind),kind);
  const saved=view.events.find(e=>e.kind==='result_saved')!;assert.equal((saved.data.result as any).deferredCommands[0].command.name,'尚未采用的候选');
  const commit=view.events.find(e=>e.kind==='committed')!;const entity=(commit.data.entityChanges as any[]).find(e=>e.id===itemId);assert.equal(entity.before,null);assert.equal(entity.after.version,1);
  assert.equal((commit.data.eventChanges as any[])[0].after.phase,'planned');assert.equal((commit.data.memoryChanges as any).snapshots[0].summary,'林晚答应收好信封。');
  assert((commit.data.callIds as string[]).includes('worldops-call'));assert.equal(view.world.revision,view.worldRevision);assert.match(view.world.capturedAt,/Z$/);
  const exported=await f.store.runtimeAudit('alice',s.world.id,capture.capture!.id,true);assert.equal(exported.calls?.[0].record.id,'worldops-call');assert.equal(exported.callsTruncated,false);
  await assert.rejects(f.store.runtimeAudit('bob',s.world.id),{code:'WORLD_NOT_FOUND'});
  await assert.rejects(f.store.pool.query('UPDATE world_runtime_audit SET kind=$1 WHERE world_id=$2',['tampered',s.world.id]),{code:'42501'});
  await assert.rejects(f.migrationPool.query('DELETE FROM world_runtime_audit WHERE world_id=$1',[s.world.id]),{code:'42501'});
  const probe=await appendRuntimeAudit(f.store.pool,{ownerId:'alice',worldId:s.world.id,kind:'probe',data:{apiKey:'sk-sensitive-private-token',thinking:'hidden model thought',safe:'visible'}});
  const redacted=(await f.store.pool.query('SELECT data FROM world_runtime_audit WHERE id=$1',[probe])).rows[0].data;
  assert.equal(redacted.apiKey,'[REDACTED]');assert.equal(redacted.thinking,'[REDACTED]');assert.equal(redacted.safe,'visible');
 }finally{await f.cleanup();}
});

test('background audit insertion failure rolls back settlement state while committed dialogue remains durable',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');const {turn,result}=await send(f,s.session.id);const job=await f.store.claimSettlement();assert(job);const itemId=randomUUID();
  await f.store.saveSettlementResult(job,{...result,entityChanges:[{op:'create',entity:{id:itemId,kind:'item',name:'纸条',description:'实际变更',knownByCharacterIds:['lin-wan']}}]});
  await f.migrationPool.query("CREATE FUNCTION reject_committed_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='committed' THEN RAISE EXCEPTION 'audit storage unavailable'; END IF; RETURN NEW; END $$");
  await f.migrationPool.query('CREATE TRIGGER audit_fault BEFORE INSERT ON world_runtime_audit FOR EACH ROW EXECUTE FUNCTION reject_committed_audit()');
  await assert.rejects(f.store.completeSettlement(job),/audit storage unavailable/);
  assert.equal((await f.store.pool.query('SELECT count(*) n FROM world_entities WHERE id=$1',[itemId])).rows[0].n,'0');
  assert.equal((await f.store.getTurn('alice',turn.id)).assistantMessages?.[0].content,result.text);
  assert.equal((await f.store.runtimeAudit('alice',s.world.id)).events.filter(e=>e.kind==='committed').length,0);
  await f.migrationPool.query('DROP TRIGGER audit_fault ON world_runtime_audit');assert(await f.store.completeSettlement(job));
 }finally{await f.cleanup();}
});

test('real wait, rebase, split and failure observations preserve source/batch/attempt identities',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id),second=await send(f,s.session.id);const jobs=await f.store.claimSettlementBatch();assert.equal(jobs.length,2);
  await f.store.saveSettlementBatchResults(jobs,jobs.map(job=>job.dialogue));
  const running=await f.store.beginTurn('alice',s.session.id,'in-flight','等等。');assert.equal(await f.store.completeSettlementBatch(jobs),false);
  await f.store.finish(running,'cancelled','TEST_CANCELLED','保留之前的消息。');
  await f.store.splitSettlementBatch(jobs);
  const single=await f.store.claimSettlement();assert(single);assert.equal(single.turnId,first.turn.id);
  await f.store.saveSettlementResult(single,single.dialogue);
  await f.store.pool.query("UPDATE world_entities SET version=version+1 WHERE world_id=$1 AND id='lin-wan'",[s.world.id]);
  assert.equal(await f.store.completeSettlement(single),false);const rebased=await f.store.claimSettlement();assert(rebased);
  await f.store.failSettlement(rebased,new ServiceError('PROVIDER_TIMEOUT','测试超时。'));
  const view=await f.store.runtimeAudit('alice',s.world.id);
  for(const kind of ['wait','split','rebased','failed'])assert(view.events.some(e=>e.kind===kind),kind);
  assert(view.events.filter(e=>e.kind==='claimed').some(e=>(e.data.memberTurnIds as string[]).includes(second.turn.id)&&e.data.size===2));
  assert(view.events.filter(e=>e.kind==='split').every(e=>e.batchId===jobs[0].batchId&&e.attemptId));
 }finally{await f.cleanup();}
});

test('runtime audit API requires developer permission and excludes automatic openings from capture turn count',async()=>{
 const f=await postgresFixture({livingWorld:true});
 const runtime:StoryRuntime={status:{provider:'demo',model:'fixture',harness:{loaded:true,version:'test'},offlineSimulation:false},actor:async()=>({text:'test'}),updateWorld:async()=>({changes:[]})};
 const app=createApp({store:f.store,runtime,authenticate:req=>req.get('x-owner')||'alice',developer:{authorize:req=>req.get('x-dev')==='yes',defaultPrompts:{main:'m',actor:'a',updater:'u'},buildRuntime:async()=>runtime}});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 try{
  const s=await f.store.createSession('alice','lin-wan',undefined,{dynamicOpening:true});const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/worlds/${s.world.id}/runtime-audit`;
  assert.equal((await fetch(base)).status,403);assert.equal((await fetch(base,{headers:{'x-dev':'yes','x-owner':'bob'}})).status,404);
  const start=await fetch(base+'/capture',{method:'POST',headers:{'x-dev':'yes','content-type':'application/json'},body:JSON.stringify({expectedTurns:7})});assert.equal(start.status,201);
  const opening=await f.store.beginTurn('alice',s.session.id,`opening:${s.session.id}`,'自动开场',{}, {operation:'opening'});await f.store.finish(opening,'cancelled','TEST_CANCELLED','无需开场。');
  const chat=await send(f,s.session.id,'真正用户消息。');const reply=await fetch(base+'?includeCalls=1',{headers:{'x-dev':'yes'}});const view=await reply.json();
  assert.equal(reply.status,200);assert.equal(view.turns.length,1);assert.equal(view.turns[0].id,chat.turn.id);assert(Array.isArray(view.calls));
 }finally{await app.locals.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.cleanup();}
});
