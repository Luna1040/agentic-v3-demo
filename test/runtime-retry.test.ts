import test from 'node:test';
import assert from 'node:assert/strict';
import {postgresFixture} from './pg-helper.ts';
import {MEMORY_POLICY} from '../server/runtime.ts';

test('a timed-out Actor can rebase after earlier background settlement without duplicating the message',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');
  const first=await f.store.beginTurn('alice',s.session.id,'one','你好');
  const text='林晚放下书。';const result={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},observations:{'lin-wan':'你好'}};
  await f.store.commitDialogue(first,result);const job=await f.store.claimSettlement();assert(job);
  const failed=await f.store.beginTurn('alice',s.session.id,'two','我最近不开心',{build:'before'});
  await f.store.saveCall(failed,{id:'timeout-call',parentId:null,input:{},attemptId:failed.attempt,agent:'actor',status:'failed',model:'fixture',startedAt:new Date().toISOString(),output:{provider:{httpStatus:200},dialogueReads:[]}});
  await f.store.finish(failed,'failed','PROVIDER_TIMEOUT','超时');
  await f.store.saveSettlementResult(job,result);assert(await f.store.completeSettlement(job));
  const retry=await f.store.beginTurn('alice',s.session.id,'two','我最近不开心',{build:'fixed'});
  assert.equal(retry.id,failed.id);assert(retry.input.world.revision>failed.input.world.revision);
  assert.equal(Number((await f.store.pool.query("SELECT count(*) n FROM messages WHERE turn_id=$1 AND role='user'",[failed.id])).rows[0].n),1);
  const row=(await f.store.pool.query('SELECT runtime_history FROM turns WHERE id=$1',[failed.id])).rows[0];
  assert.deepEqual(row.runtime_history[0].input,failed.input);
 }finally{await f.cleanup();}
});

test('a pre-model failed turn can use a repaired runtime without duplicating input or losing attempt provenance',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');
  const original=await f.store.beginTurn('alice',s.session.id,'same','继续。',{build:'before',orchestration:'scene-actor-first-v1'});
  assert.equal(original.phase,'responding');
  await f.store.finish(original,'failed','ACTOR_INPUT_INVALID','NPC self view failed validation.');
  const count=Number((await f.store.pool.query('SELECT count(*) n FROM messages WHERE session_id=$1',[s.session.id])).rows[0].n);
  const retry=await f.store.beginTurn('alice',s.session.id,'same','继续。',{build:'fixed',orchestration:'scene-actor-first-v1'});
  assert.equal(retry.id,original.id);assert.notEqual(retry.attempt,original.attempt);
  assert.deepEqual(retry.input,original.input);assert.equal(retry.runtimeMetadata.build,'fixed');
  assert.equal(retry.phase,'responding');
  assert.equal(Number((await f.store.pool.query('SELECT count(*) n FROM messages WHERE session_id=$1',[s.session.id])).rows[0].n),count);
  const trace=await f.store.getTrace('alice',retry.id);
  assert.equal(trace.calls.length,0);
  const history=trace.metadata!.priorRuntimeAttempts as any[];
  assert.equal(history.length,1);assert.equal(history[0].attemptId,original.attempt);
  assert.deepEqual(history[0].runtimeMetadata,{build:'before',orchestration:'scene-actor-first-v1',memoryPolicy:MEMORY_POLICY});
  assert.equal(history[0].errorCode,'ACTOR_INPUT_INVALID');
  await assert.rejects(f.store.saveDraft(original,'旧执行不能再写入'),{code:'TURN_LEASE_LOST'});
  const text='林晚翻开书，继续讲到刚才那一页。';
  await f.store.commitDialogue(retry,{text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},observations:{'lin-wan':'继续。'}});
  assert.equal((await f.store.beginTurn('alice',s.session.id,'same','继续。',{build:'later'})).status,'committed');
  assert.equal((await f.store.getTurn('alice',retry.id)).assistantMessages?.length,1);
 }finally{await f.cleanup();}
});

for(const state of ['draft','checkpoint','completed-call','failed-output','cancelled','world-changed'] as const)
test(`runtime upgrade refuses unsafe retry: ${state}`,async()=>{
 const f=await postgresFixture();
 try{
  const s=await f.store.createSession('alice','lin-wan');
  const original=await f.store.beginTurn('alice',s.session.id,'same','继续。',{build:'before'});
  if(state==='draft')await f.store.saveDraft(original,'已经生成的正文');
  if(state==='checkpoint')await f.store.pool.query('UPDATE turns SET runtime_checkpoint=$2 WHERE id=$1',[original.id,{text:''}]);
  if(state==='completed-call'||state==='failed-output')await f.store.saveCall(original,{id:'old-call',parentId:null,input:{},attemptId:original.attempt,agent:'actor',status:state==='completed-call'?'completed':'failed',model:'fixture',startedAt:new Date().toISOString(),output:{text:'已有模型结果'}});
  await f.store.finish(original,state==='cancelled'?'cancelled':'failed','FIXTURE','已停止');
  if(state==='world-changed')await f.store.pool.query('UPDATE worlds SET revision=revision+1 WHERE id=$1',[s.world.id]);
  await assert.rejects(f.store.beginTurn('alice',s.session.id,'same','继续。',{build:'fixed'}),{code:state==='world-changed'?'WORLD_CHANGED':'RUNTIME_CHANGED'});
  const row=(await f.store.pool.query('SELECT runtime_metadata,runtime_history,attempt FROM turns WHERE id=$1',[original.id])).rows[0];
  assert.equal(row.runtime_metadata.build,'before');assert.deepEqual(row.runtime_history,[]);assert.equal(row.attempt,original.attempt);
 }finally{await f.cleanup();}
});
