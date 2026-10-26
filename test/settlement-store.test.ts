import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';
import { StoryStore } from '../server/store.ts';
import { ServiceError, type WorldTurnResult } from '../server/runtime.ts';

async function dialogue(store:StoryStore,sessionId:string,text='把纸条放在桌上。') {
  const turn=await store.beginTurn('alice',sessionId,randomUUID(),text);
  const result:WorldTurnResult={text:'林晚收好了纸条。',usage:{},changes:[],replies:[{characterId:'lin-wan',characterName:'林晚',text:'林晚收好了纸条。'}],entityChanges:[],activities:[],observations:{'lin-wan':text},scene:turn.input.scene};
  await store.commit(turn,result.text,[],{...result,settlement:result});
  return {turn,result};
}

test('dialogue commit is durable before settlement, foreground does not wait, FIFO summaries include previous items',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');
    const first=await dialogue(f.store,s.session.id);
    const job=await f.store.claimSettlement(); assert(job);
    const itemId=randomUUID();
    await f.store.saveSettlementResult(job,{...first.result,entityChanges:[{op:'create',entity:{id:itemId,kind:'item',name:'纸条',description:'已收好。',state:{holderCharacterId:'lin-wan'},knownByCharacterIds:['lin-wan']}}]});
    const next=await f.store.beginTurn('alice',s.session.id,randomUUID(),'好。');
    assert.deepEqual(next.input.episodes,[]);
    assert((await f.store.readDialogue('alice',{worldId:next.worldId,sourceTurnId:next.id,characterId:'lin-wan'})).episodes.some(row=>row.turnId===first.turn.id));
    assert.equal(await f.store.completeSettlement(job),false);
    await f.store.yieldSettlement(job);
    const last={...first.result,observations:{'lin-wan':'好。'}};
    await f.store.commit(next,last.text,[],{...last,settlement:last});
    await f.store.pool.query("UPDATE world_settlements SET next_attempt_at=clock_timestamp() WHERE id=$1",[job.id]);
    const resumed=await f.store.claimSettlement(); assert(resumed); assert.equal(resumed.turnId,first.turn.id);
    // A pure dialogue revision must reuse extraction: authorized facts and source
    // evidence did not change, so no additional model request is required.
    assert(resumed.result);
    await f.store.saveSettlementResult(resumed,{...first.result,entityChanges:[{op:'create',entity:{id:itemId,kind:'item',name:'纸条',description:'已收好。',state:{holderCharacterId:'lin-wan'},knownByCharacterIds:['lin-wan']}}]});
    const before=(await f.store.pool.query('SELECT updated_at FROM turns WHERE id=$1',[first.turn.id])).rows[0].updated_at;
    assert.equal(await f.store.completeSettlement(resumed),true);
    const after=(await f.store.pool.query('SELECT updated_at FROM turns WHERE id=$1',[first.turn.id])).rows[0].updated_at;
    assert.equal(before.toISOString(),after.toISOString());
    const second=await f.store.claimSettlement(); assert(second); assert.equal(second.turnId,next.id);
    assert(second.input.worldContext!.entities.some(row=>row.id===itemId));
    assert.equal((await f.store.getTurn('alice',first.turn.id)).status,'committed');
  } finally {await f.cleanup();}
});

test('settlement CAS rejects stale entities, clears stale checkpoints, and never changes saved dialogue',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); const first=await dialogue(f.store,s.session.id);
    const job=await f.store.claimSettlement(); assert(job);
    await f.store.saveSettlementResult(job,first.result);
    await f.store.pool.query("UPDATE world_entities SET version=version+1 WHERE world_id=$1 AND id='lin-wan'",[s.session.worldId]);
    assert.equal(await f.store.completeSettlement(job),false);
    assert.equal(await f.store.renewSettlement(job),false);
    const rebased=await f.store.claimSettlement(); assert(rebased);
    assert.equal(rebased.result,null); assert.equal(rebased.checkpoint,null);
    assert.equal(rebased.input.worldContext!.entities.find(row=>row.id==='lin-wan')!.version,2);
    const turn=await f.store.getTurn('alice',first.turn.id); assert.equal(turn.status,'committed'); assert.equal(turn.assistantMessages?.[0].content,first.result.text);
  } finally {await f.cleanup();}
});

test('expired lease is fenced, peer resumes durable result without another model request',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); const first=await dialogue(f.store,s.session.id);
    const job=await f.store.claimSettlement({runtimeFingerprint:'v1'}); assert(job);
    await f.store.saveSettlementResult(job,first.result);
    await f.store.pool.query("UPDATE world_settlements SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    const other=await f.peer().claimSettlement({runtimeFingerprint:'v1'}); assert(other);
    assert.notEqual(other.attempt,job.attempt); assert.deepEqual(other.result,first.result);
    assert.equal(await f.store.renewSettlement(job),false);
    await assert.rejects(f.store.saveSettlementResult(job,first.result),{code:'SETTLEMENT_LEASE_LOST'});
    assert.equal(await f.store.completeSettlement(other),true);
    assert.equal(await f.store.claimSettlement(),null);
  } finally {await f.cleanup();}
});

test('background failures are bounded, redact provider errors, retain original evidence and support manual retry',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); const first=await dialogue(f.store,s.session.id);
    for(let i=0;i<3;i++) {
      const job=await f.store.claimSettlement(); assert(job);
      await f.store.failSettlement(job,new Error('secret-provider-credential'));
      await f.store.pool.query('UPDATE world_settlements SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.id]);
    }
    assert.equal(await f.store.claimSettlement(),null);
    const world=await f.store.getWorld('alice',s.session.worldId);
    assert.equal(world.settlements?.[0].status,'failed'); assert(!JSON.stringify(world.settlements).includes('secret-provider'));
    assert(world.episodes?.some(row=>row.turnId===first.turn.id));
    assert.equal((await f.store.getTurn('alice',first.turn.id)).status,'committed');
    await f.store.retrySettlements('alice',s.session.worldId);
    const resumed=await f.store.claimSettlement(); assert(resumed);
    await f.store.failSettlement(resumed,new ServiceError('SETTLEMENT_INTERRUPTED','shutdown'));
    const restarted=await f.store.claimSettlement(); assert(restarted); assert.equal(restarted.attempts,1);
  } finally {await f.cleanup();}
});

test('old unresolved exchange remains in actor retrieval after the recent window, without changing turn order',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); const first=await dialogue(f.store,s.session.id,'这封信是我的。');
    for(let i=0;i<8;i++) await dialogue(f.store,s.session.id,`继续 ${i}`);
    const input=await f.store.previewInput('alice',s.session.id,'嗯。');
    assert(input.contextPack!.memory.pendingTurnIds.includes(first.turn.id));
    assert((await readPastDialogue(f.store,'alice',s.session.id,'lin-wan',[first.turn.id])).some(row=>row.turnId===first.turn.id && row.userText==='这封信是我的。'));
    assert(input.episodes!.length<=8);
  } finally {await f.cleanup();}
});

test('foreign Harness settlement errors retain only allowlisted codes and fixed safe messages without changing retry limits',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');const first=await dialogue(f.store,s.session.id);
    for(const [index,code] of ['UPDATER_OUTPUT_INVALID','CHECKPOINT_FAILED','CALL_RECORDING_FAILED'].entries()) {
      const job=await f.store.claimSettlement();assert(job);
      const callId=randomUUID();
      await f.store.saveSettlementCall(job,{id:callId,parentId:null,attemptId:job.attempt,agent:'updater',status:'running',model:'test',startedAt:new Date().toISOString(),input:{}});
      const error=Object.assign(new Error('Authorization: Bearer secret-provider-credential'),{name:'StoryRuntimeError',code,output:{raw:'secret-output',headers:{authorization:'secret-header'}}});
      await f.store.failSettlement(job,error);
      const world=await f.store.getWorld('alice',s.world.id);const state=world.settlements!.find(row=>row.turnId===first.turn.id)!;
      assert.equal(state.error?.code,code);assert(state.error!.message.includes('原始回复已保留'));
      assert.equal(state.attempts,index+1);assert.equal(state.status,index===2?'failed':'pending');
      const trace=await f.store.getTrace('alice',first.turn.id);assert.equal(trace.calls.find(call=>call.id===callId)!.error?.code,code);
      assert(!JSON.stringify({state,trace}).includes('secret-'));
      await f.store.pool.query('UPDATE world_settlements SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.id]);
    }
    assert.equal(await f.store.claimSettlement(),null);
    assert.equal((await f.store.getTurn('alice',first.turn.id)).status,'committed');
    for(const code of ['UNKNOWN_SECRET_CODE','constructor','SETTLEMENT_INTERRUPTED']) {
      await f.store.retrySettlements('alice',s.world.id);const job=await f.store.claimSettlement();assert(job);
      await f.store.failSettlement(job,{code,message:'secret-message',headers:{authorization:'secret-header'}});
      const state=(await f.store.getWorld('alice',s.world.id)).settlements![0];
      assert.equal(state.error?.code,'SETTLEMENT_FAILED');assert.equal(state.attempts,1);assert(!JSON.stringify(state).includes('secret'));
    }
  }finally{await f.cleanup();}
});

test('late movement cannot undo a manual scene edit and retains its historical evidence',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); const first=await dialogue(f.store,s.session.id);
    const world=await f.store.getWorld('alice',s.session.worldId);
    await f.store.setScene('alice',s.session.worldId,world.revision,{location:null,presentCharacterIds:['lin-wan'],mode:'direct',playerPresent:false});
    const job=await f.store.claimSettlement(); assert(job);
    await f.store.saveSettlementResult(job,{...first.result,actorLocations:[{characterId:'lin-wan',locationId:null,evidence:{source:'actor',characterId:'lin-wan',quote:first.result.text}}]});
    assert.equal(await f.store.completeSettlement(job),true);
    const after=await f.store.getWorld('alice',s.session.worldId);
    assert.equal(after.scene?.mode,'direct'); assert.equal(after.scene?.playerPresent,false);
    const saved=(await f.store.pool.query('SELECT result FROM world_settlements WHERE id=$1',[job.id])).rows[0].result;
    assert.equal(saved.movementDisposition,'historical_only_newer_world_state');
    assert.equal(saved.actorLocations[0].evidence.quote,first.result.text);
  } finally {await f.cleanup();}
});

test('long user evidence settles without truncation or a database length failure',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');
    const text='这封信我会自己交给她。'.repeat(130);
    assert(text.length>1200);
    const first=await dialogue(f.store,s.session.id,text);
    const job=await f.store.claimSettlement(); assert(job);
    await f.store.saveSettlementResult(job,{...first.result,changes:[{kind:'fact',text,visibility:'private',characterId:'lin-wan',evidence:{source:'user',turnId:first.turn.id}}]});
    assert.equal(await f.store.completeSettlement(job),true);
    const world=await f.store.getWorld('alice',s.session.worldId);
    assert.equal(world.events[0].text,text);
    assert.equal(world.episodes?.[0].userText,text);
  } finally {await f.cleanup();}
});

test('bounded batches claim one world FIFO and atomically apply overlapping updates chronologically',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');
    const seed=await dialogue(f.store,s.session.id); const initial=await f.store.claimSettlement(); assert(initial);
    const item={id:randomUUID(),kind:'item' as const,name:'信封',description:'信封',state:{holderCharacterId:'lin-wan'},knownByCharacterIds:['lin-wan']};
    await f.store.saveSettlementResult(initial,{...seed.result,entityChanges:[{op:'create',entity:item}]}); assert(await f.store.completeSettlement(initial));
    const sources=[]; for(let i=0;i<4;i++) sources.push(await dialogue(f.store,s.session.id,`信封处理 ${i}`));
    const jobs=await f.store.claimSettlementBatch(undefined,99); assert.equal(jobs.length,3);
    assert.deepEqual(jobs.map(job=>job.turnId),sources.slice(0,3).map(source=>source.turn.id));
    assert.equal(new Set(jobs.map(job=>job.batchId)).size,1);
    assert.deepEqual(await f.peer().claimSettlementBatch(),[]);
    const results=jobs.map((job,index)=>({...job.dialogue,entityChanges:[{op:'update' as const,baseVersion:1,entity:{...item,description:`信封第 ${index+1} 步`,state:{holderCharacterId:'lin-wan',progress:index+1}}}]}));
    await f.store.saveSettlementBatchResults(jobs,results);
    await assert.rejects(f.store.completeSettlement(jobs[0]),{code:'SETTLEMENT_ORDER'});
    await f.store.saveSettlementCall(jobs[0],{id:'batch-call',parentId:null,input:{},agent:'updater',model:'test',attemptId:jobs[0].attempt,status:'completed',startedAt:new Date().toISOString(),output:{}});
    assert((await f.store.getTrace('alice',jobs[1].turnId)).calls.some(call=>call.id==='batch-call'));
    const next=await f.store.beginTurn('alice',s.session.id,randomUUID(),'等一下。');
    assert.equal(await f.store.completeSettlementBatch(jobs),false);
    await f.store.finish(next,'cancelled','TEST','test');
    assert.equal(await f.store.completeSettlementBatch(jobs),true);
    const world=await f.store.getWorld('alice',s.session.worldId); const after=world.entities!.find(entity=>entity.id===item.id)!;
    assert.equal(after.state.progress,3); assert.equal(after.version,4);
    assert.equal((await f.store.claimSettlementBatch())[0].turnId,sources[3].turn.id);
  } finally {await f.cleanup();}
});

test('batch external version conflict never partially applies or changes saved dialogue',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); await dialogue(f.store,s.session.id); await dialogue(f.store,s.session.id);
    const jobs=await f.store.claimSettlementBatch(); assert.equal(jobs.length,2);
    await f.store.saveSettlementBatchResults(jobs,jobs.map(job=>job.dialogue));
    await f.store.pool.query("UPDATE world_entities SET version=version+1 WHERE world_id=$1 AND id='lin-wan'",[s.session.worldId]);
    assert.equal(await f.store.completeSettlementBatch(jobs),false);
    const rows=(await f.store.pool.query('SELECT status,result FROM world_settlements WHERE world_id=$1',[s.session.worldId])).rows;
    assert(rows.every(row=>row.status==='pending' && row.result===null));
    for(const job of jobs) assert.equal((await f.store.getTurn('alice',job.turnId)).status,'committed');
    const again=await f.store.claimSettlementBatch(); assert.deepEqual(again.map(job=>job.id),jobs.map(job=>job.id));
  } finally {await f.cleanup();}
});

test('semantic conflict rolls back whole batch, then permanently splits without losing source evidence',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); await dialogue(f.store,s.session.id); await dialogue(f.store,s.session.id);
    const jobs=await f.store.claimSettlementBatch();
    const results=jobs.map(job=>({...job.dialogue,entityChanges:[{op:'create' as const,entity:{id:randomUUID(),kind:'item' as const,name:'同一封信',description:'信',knownByCharacterIds:['lin-wan']}}]}));
    await f.store.saveSettlementBatchResults(jobs,results);
    await assert.rejects(f.store.completeSettlementBatch(jobs),{code:'ENTITY_NAME_CONFLICT'});
    assert(!(await f.store.getWorld('alice',s.session.worldId)).entities!.some(entity=>entity.name==='同一封信'));
    await f.store.splitSettlementBatch(jobs);
    const first=await f.store.claimSettlementBatch(); assert.equal(first.length,1); assert.equal(first[0].attempts,2);
    await f.store.saveSettlementResult(first[0],first[0].dialogue); assert(await f.store.completeSettlementBatch(first));
    const second=await f.store.claimSettlementBatch(); assert.equal(second.length,1); assert.equal(second[0].turnId,jobs[1].turnId);
    for(const job of jobs) assert.equal((await f.store.getTurn('alice',job.turnId)).assistantMessages?.[0].content,job.dialogue.text);
  } finally {await f.cleanup();}
});

test('batch recovery preserves immutable membership and a newer failed source cannot be bypassed',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); for(let i=0;i<2;i++) await dialogue(f.store,s.session.id);
    const jobs=await f.store.claimSettlementBatch(); await f.store.saveSettlementBatchResults(jobs,jobs.map(job=>job.dialogue));
    await dialogue(f.store,s.session.id);
    await f.store.pool.query("UPDATE world_settlements SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE batch_id=$1",[jobs[0].batchId]);
    const recovered=await f.peer().claimSettlementBatch(); assert.equal(recovered.length,2); assert(recovered.every(job=>job.result));
    await f.store.pool.query("UPDATE world_settlements SET status='failed' WHERE id=$1",[recovered[0].id]);
    assert.deepEqual(await f.store.claimSettlementBatch(),[]);
  } finally {await f.cleanup();}
});

test('background offline activities require frozen time and Pulse evidence, preserve current time and newer cursor',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); const first=await dialogue(f.store,s.session.id,'十分钟后，我回到这里。');
    const job=await f.store.claimSettlement(); assert(job);
    const result={activities:[{characterId:'lin-wan',text:'林晚打算稍后整理信件。',kind:'invitation' as const,elapsedMs:0,elapsedStoryMs:60000}],settledCharacterIds:['lin-wan']};
    await assert.rejects(f.store.saveSettlementOffline(job,result),{code:'ACTIVITY_INVALID'});
    await f.store.saveSettlementCall(job,{id:'pulse-test',parentId:null,input:{},attemptId:job.attempt,agent:'pulse',model:'test',status:'completed',startedAt:new Date().toISOString(),output:{settledCharacterIds:['lin-wan']}});
    await assert.rejects(f.store.saveSettlementOffline(job,{...result,activities:[{...result.activities[0],elapsedStoryMs:86400000}]}),{code:'ACTIVITY_INVALID'});
    await f.store.saveSettlementOffline(job,result);
    await f.store.saveSettlementResult(job,first.result);
    const current=await f.store.getWorld('alice',s.session.worldId);
    const future='2099-01-01T00:00:00.000Z';
    await f.store.pool.query("UPDATE world_entities SET state=state || jsonb_build_object('lastSettledAt',$2::text) WHERE world_id=$1 AND id='lin-wan'",[s.session.worldId,future]);
    assert(await f.store.completeSettlement(job));
    const after=await f.store.getWorld('alice',s.session.worldId);
    assert.deepEqual(after.storyTime,current.storyTime); assert.deepEqual(after.scene,current.scene);
    assert.equal(after.entities!.find(entity=>entity.id==='lin-wan')!.state.lastSettledAt,future);
    const source=(await f.store.pool.query('SELECT activities FROM turns WHERE id=$1',[first.turn.id])).rows[0];
    assert.equal(source.activities.length,1); assert.equal(source.activities[0].sourceTurnId,first.turn.id);
  } finally {await f.cleanup();}
});
