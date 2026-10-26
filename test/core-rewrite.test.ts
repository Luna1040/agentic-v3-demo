import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {postgresFixture,readPastDialogue} from './pg-helper.ts';
import {requestDirection,readPreparedDirection,applyStoryProgress} from '../server/director.ts';
import type {WorldTurnResult} from '../server/runtime.ts';
import {dependenciesMatch} from '../server/context-snapshot.ts';
import {validMovementEvidence} from '../server/movement.ts';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

async function send(f:Awaited<ReturnType<typeof postgresFixture>>,sessionId:string,text='继续。') {
 const turn=await f.store.beginTurn('alice',sessionId,randomUUID(),text);
 const result:WorldTurnResult={text:'林晚放下书。',replies:[{characterId:'lin-wan',characterName:'林晚',text:'林晚放下书。'}],changes:[],entityChanges:[],activities:[],usage:{},scene:turn.input.scene,observations:{'lin-wan':text}};
 await f.store.commitDialogue(turn,result);return {turn,result};
}

test('establishing an already occupied room fills the scene without fabricating a move',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');const turn=await f.store.beginTurn('alice',s.session.id,randomUUID(),'你好');
  const result:WorldTurnResult={text:'林晚在客厅的沙发上坐着。',replies:[{characterId:'lin-wan',characterName:'林晚',text:'林晚在客厅的沙发上坐着。'}],changes:[],entityChanges:[],activities:[],usage:{},attributedEvidence:[],observations:{'lin-wan':'你好'}};
  await f.store.commitDialogue(turn,result);
  const job=await f.store.claimSettlement();assert(job);const id=randomUUID();
  await f.store.saveSettlementResult(job,{...result,attributedEvidence:[],scene:{...turn.input.scene!,location:'客厅'},entityChanges:[{op:'create',entity:{id,kind:'location',name:'客厅',description:'当下交谈所在的房间',state:{},knownByCharacterIds:['lin-wan']},witnessedByCharacterIds:['lin-wan']}]});
  assert(await f.store.completeSettlement(job));
  const world=await f.store.getWorld('alice',s.world.id);
  assert.equal(world.scene?.location,'客厅');assert.equal(world.scene?.playerPresent,turn.input.scene?.playerPresent);
  assert.equal(world.entities?.find(e=>e.id==='lin-wan')?.state.locationId,id);
  assert.equal(world.eventLedger?.length,0);
 }finally{await f.cleanup();}
});

test('mainline spans ordinary turns, advances without Main call, redirect supersedes it',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id);
  const input=await f.store.previewInput('alice',s.session.id,'继续');
  const plan={planType:'mainline',version:1,id:'class',status:'active',goal:'上课并收尾',targetTurns:10,currentStageId:'walk',basedOnTurnId:first.turn.id,invalidWhen:['用户改变方向'],stages:[{id:'walk',goal:'到课堂',completionCondition:'进入教室',status:'active',budgetTurns:2},{id:'class',goal:'参与课堂',completionCondition:'课堂结束',status:'pending',budgetTurns:8}]};
  await f.store.pool.query("UPDATE world_directions SET status='completed',plan=$2,guard=$3 WHERE world_id=$1",[s.world.id,plan,{focusId:'lin-wan',profile:input.playerProfile??null}]);
  const second=await send(f,s.session.id,'路上继续聊天。');
  const prepared=await readPreparedDirection(f.store.pool,'alice',await f.store.previewInput('alice',s.session.id,'然后呢')) as any;
  assert.equal(prepared.id,'class');assert.equal(prepared.elapsedTurns,1);
  assert.equal((await f.store.pool.query('SELECT status FROM world_directions WHERE world_id=$1',[s.world.id])).rows[0].status,'completed');
  await applyStoryProgress(f.store.pool,'alice',s.world.id,second.turn.id,{planId:'class',stageId:'walk',decision:'advance'});
  const advanced=(await f.store.pool.query('SELECT plan,status FROM world_directions WHERE world_id=$1',[s.world.id])).rows[0];
  assert.equal(advanced.plan.currentStageId,'class');assert.equal(advanced.status,'completed');
  await applyStoryProgress(f.store.pool,'alice',s.world.id,second.turn.id,{planId:'class',stageId:'class',decision:'redirect',reason:'用户决定回家'});
  assert.equal(await readPreparedDirection(f.store.pool,'alice',input),undefined);
  const redirected=(await f.store.pool.query('SELECT status,plan FROM world_directions WHERE world_id=$1',[s.world.id])).rows[0];
  assert.equal(redirected.status,'pending');assert.equal(redirected.plan.status,'abandoned');
 }finally{await f.cleanup();}
});

test('production dialogue commits one message, preserves event identity and original evidence across turns',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id,'等会儿去教室。');
  const job=await f.store.claimSettlement();assert(job);
  const event={id:'trip-1',kind:'movement' as const,subjectId:'lin-wan',summary:'去教室',phase:'planned' as const,sourceTurnId:first.turn.id,lastSourceTurnId:first.turn.id,evidenceIds:['source-1'],version:1};
  await f.store.saveSettlementResult(job,{...first.result,eventLedger:[event]});
  assert(await f.store.completeSettlement(job));
  const second=await send(f,s.session.id,'还有件事。');
  assert.equal(second.turn.input.eventLedger?.[0].id,'trip-1');
  const j2=await f.store.claimSettlement();assert(j2);
  await f.store.saveSettlementResult(j2,{...second.result,eventLedger:[]});assert(await f.store.completeSettlement(j2));
  const rows=(await f.store.pool.query('SELECT record FROM world_story_events WHERE world_id=$1',[s.world.id])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].record.version,1);assert.equal(rows[0].record.phase,'planned');
  assert.equal((await f.store.getTurn('alice',first.turn.id)).assistantMessages?.length,1);
  assert.equal(j2.evidence?.throughSeq,Number((await f.store.pool.query('SELECT seq FROM turns WHERE id=$1',[second.turn.id])).rows[0].seq));
 }finally{await f.cleanup();}
});

test('durable model result survives transient persistence error and unrelated entity does not invalidate it',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id);
  const job=await f.store.claimSettlement();assert(job);await f.store.saveSettlementResult(job,first.result);
  await f.store.failSettlement(job,new Error('temporary connection lost'));
  await f.store.pool.query('UPDATE world_settlements SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.id]);
  const resumed=await f.store.claimSettlement();assert(resumed?.result);assert.deepEqual(resumed.result,first.result);
  await f.store.pool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES('alice',$1,$2,'item','远方的物品','', '{}','{}')",[s.world.id,randomUUID()]);
  assert(await f.store.completeSettlement(resumed));
  assert(dependenciesMatch({'lin-wan':1},{'lin-wan':1,unrelated:8}));
 }finally{await f.cleanup();}
});

test('single scene message gives witnessed NPC memory, blocks private thought, and scopes archive reads',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const npc=randomUUID();
  await f.store.pool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES('alice',$1,$2,'npc','米拉','同学','{}',$3)",[s.world.id,npc,['lin-wan',npc]]);
  await f.store.setScene('alice',s.world.id,s.world.revision,{mode:'ensemble',location:'教室',presentCharacterIds:['lin-wan',npc]},s.session.id);
  const turn=await f.store.beginTurn('alice',s.session.id,randomUUID(),'你好。');
  const speech='林晚说：“下课一起吃饭。”',thought='林晚心想，秘密不能告诉米拉。',text=speech+'\n'+thought;
  const result:WorldTurnResult={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},scene:turn.input.scene,observations:{'lin-wan':'你好。',[npc]:'你好。'},attributedEvidence:[
   {id:'speech',source:'actor',turnId:turn.id,characterId:'lin-wan',text:speech,start:0,end:speech.length,audienceCharacterIds:['lin-wan',npc]},
   {id:'thought',source:'actor',turnId:turn.id,characterId:'lin-wan',text:thought,start:speech.length+1,end:text.length,audienceCharacterIds:['lin-wan']}
  ]};
  await f.store.commitDialogue(turn,result);const job=await f.store.claimSettlement();assert(job);
  const change={op:'update' as const,entity:{id:npc,kind:'npc' as const,name:'米拉',description:'同学',state:{arc:'记得林晚邀请下课一起吃饭。'}},arcSource:{source:'actor' as const,characterId:'lin-wan',quote:speech},witnessedByCharacterIds:[npc]};
  await f.store.saveSettlementResult(job,{...result,entityChanges:[{...change,arcSource:{...change.arcSource,quote:thought}}]});
  await assert.rejects(f.store.completeSettlement(job),{code:'ARC_SOURCE_INVALID'});
  await f.store.saveSettlementResult(job,{...result,entityChanges:[change]});assert(await f.store.completeSettlement(job));
  const memory=(await f.store.pool.query('SELECT * FROM world_memory_snapshots WHERE world_id=$1 AND character_id=$2',[s.world.id,npc])).rows[0];
  assert.equal(memory.summary,'记得林晚邀请下课一起吃饭。');
  const archive=await readPastDialogue(f.store,'alice',s.session.id,npc,[turn.id]);
  assert(JSON.stringify(archive).includes(speech));assert(!JSON.stringify(archive).includes(thought));
 }finally{await f.cleanup();}
});

test('offline receipt survives trace completion failure and commits without replaying Pulse',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id,'十分钟后，我回到这里。');
  const job=await f.store.claimSettlement();assert(job);
  const offline={activities:[{characterId:'lin-wan',text:'林晚打算整理信件。',kind:'invitation' as const,elapsedMs:0,elapsedStoryMs:60000}],settledCharacterIds:['lin-wan']};
  await f.store.saveSettlementCall(job,{id:'pulse-receipt',parentId:null,input:{},attemptId:job.attempt,agent:'pulse',model:'test',status:'running',startedAt:new Date().toISOString()});
  await f.store.saveSettlementOffline(job,offline,true);
  await f.store.failSettlement(job,{code:'CALL_RECORDING_FAILED'});
  await f.store.pool.query('UPDATE world_settlements SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.id]);
  const resumed=await f.store.claimSettlement();assert(resumed);assert.deepEqual(resumed.offlineResult,offline);
  await f.store.saveSettlementResult(resumed,first.result);assert(await f.store.completeSettlement(resumed));
  const calls=(await f.store.pool.query("SELECT record->>'status' AS status FROM agent_calls WHERE turn_id=$1 AND record->>'agent'='pulse'",[first.turn.id])).rows;
  assert.deepEqual(calls,[{status:'failed'}]);
  assert.equal((await f.store.getWorld('alice',s.world.id)).activities?.length,1);
 }finally{await f.cleanup();}
});

test('background sees present NPC event identity and accepts its own verified offstage activity memory',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const npc=randomUUID();
  await f.store.pool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES('alice',$1,$2,'npc','米拉','同学','{}',$3)",[s.world.id,npc,[npc]]);
  const first=await send(f,s.session.id);
  const quote='米拉独自在教室整理了书架。';
  // Fixture represents the already verified durable Pulse result on this source.
  await f.store.pool.query('UPDATE turns SET activities=$2 WHERE id=$1',[first.turn.id,JSON.stringify([{characterId:npc,kind:'completed',text:quote,elapsedMs:1000}])]);
  const job=await f.store.claimSettlement();assert(job);
  const patch={op:'update' as const,entity:{id:npc,kind:'npc' as const,name:'米拉',description:'同学',state:{arc:'独自整理了书架。'}},arcSource:{source:'pulse' as const,characterId:npc,quote},witnessedByCharacterIds:[npc]};
  await f.store.saveSettlementResult(job,{...first.result,entityChanges:[patch]});assert(await f.store.completeSettlement(job));
  const world=await f.store.getWorld('alice',s.world.id);
  await f.store.setScene('alice',s.world.id,world.revision,{mode:'ensemble',location:'教室',presentCharacterIds:['lin-wan',npc]},s.session.id);
  const second=await send(f,s.session.id);const event={id:'mira-trip',kind:'movement',subjectId:npc,summary:'米拉去教室',phase:'planned',sourceTurnId:first.turn.id,lastSourceTurnId:first.turn.id,evidenceIds:['saved-source'],version:1};
  await f.store.pool.query('INSERT INTO world_story_events(owner_id,world_id,id,version,record,source_turn_id,last_source_turn_id) VALUES($1,$2,$3,1,$4,$5,$5)',['alice',s.world.id,event.id,event,first.turn.id]);
  const next=await f.store.claimSettlement();assert(next);assert.equal(next.turnId,second.turn.id);
  assert(next.input.eventLedger?.some(row=>row.id==='mira-trip'));
 }finally{await f.cleanup();}
});

test('new cancelled commitment is a valid terminal occurrence and bold names remain exact movement evidence',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id);const job=await f.store.claimSettlement();assert(job);
  const id=randomUUID();
  const event={id:'cancel-1',kind:'commitment' as const,subjectId:'lin-wan',summary:'取消去教室',phase:'cancelled' as const,sourceTurnId:first.turn.id,lastSourceTurnId:first.turn.id,evidenceIds:['source-1'],entityId:id,version:1};
  await f.store.saveSettlementResult(job,{...first.result,eventLedger:[event],entityChanges:[{op:'create',entity:{id,kind:'quest',name:'去教室',description:'已经取消',state:{status:'failed'},knownByCharacterIds:['lin-wan']}}]});
  assert(await f.store.completeSettlement(job));
  const quote='**林晚**走进教室。';assert(validMovementEvidence(quote,quote,'教室','林晚'));
 }finally{await f.cleanup();}
});

test('in-flight Main revision is superseded by new input and manual scene edits fence same-source attempts',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id);
  const input=await f.store.previewInput('alice',s.session.id,'继续');const attempt=randomUUID();
  const plan={planType:'mainline',version:1,id:'route',status:'active',goal:'去上课',targetTurns:10,currentStageId:'walk',basedOnTurnId:first.turn.id,invalidWhen:[],stages:[{id:'walk',goal:'去上课',completionCondition:'到教室',status:'active',budgetTurns:10}]};
  await f.store.pool.query("UPDATE world_directions SET plan=$2,guard=$3,status='running',attempt=$4,claimed_turn_id=requested_turn_id WHERE world_id=$1",[s.world.id,plan,{focusId:'lin-wan',profile:input.playerProfile??null},attempt]);
  const second=await send(f,s.session.id,'我不去上课了。');
  assert.equal((await f.store.pool.query('SELECT requested_turn_id FROM world_directions WHERE world_id=$1',[s.world.id])).rows[0].requested_turn_id,second.turn.id);
  const world=await f.store.getWorld('alice',s.world.id);
  await f.store.setScene('alice',s.world.id,world.revision,{location:'图书馆',presentCharacterIds:['lin-wan'],mode:'ensemble'},s.session.id);
  const row=(await f.store.pool.query('SELECT plan,attempt,status FROM world_directions WHERE world_id=$1',[s.world.id])).rows[0];
  assert.equal(row.attempt,null);assert.equal(row.plan.status,'abandoned');assert.equal(row.status,'pending');
  assert.equal((await f.store.pool.query("UPDATE world_directions SET status='completed',plan=$3 WHERE world_id=$1 AND attempt=$2",[s.world.id,attempt,plan])).rowCount,0);
 }finally{await f.cleanup();}
});

test('background NPC discovery gives self knowledge and the next real Harness scene streams successfully',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try {
  const s=await f.store.createSession('alice','lin-wan');const first=await send(f,s.session.id);const job=await f.store.claimSettlement();assert(job);
  const id=randomUUID();
  await f.store.saveSettlementResult(job,{...first.result,entityChanges:[{op:'create',entity:{id,kind:'npc',name:'艾米丽',description:'新认识的同学',state:{definition:'艾米丽性格开朗，有自己的秘密。',worldRole:{anchorEntityId:'lin-wan',relation:'同学',goal:'一起上课'}},knownByCharacterIds:['lin-wan']},witnessedByCharacterIds:['lin-wan']}]});
  assert(await f.store.completeSettlement(job));
  const persisted=(await f.store.pool.query('SELECT known_by_character_ids FROM world_entities WHERE world_id=$1 AND id=$2',[s.world.id,id])).rows[0];
  assert(persisted.known_by_character_ids.includes(id));
  // An older generated NPC may have missed this invariant. Projection repairs
  // its own view without broadening anybody else's knowledge.
  await f.store.pool.query('UPDATE world_entities SET known_by_character_ids=$3 WHERE world_id=$1 AND id=$2',[s.world.id,id,['lin-wan']]);
  const next=await f.store.beginTurn('alice',s.session.id,randomUUID(),'我们继续。');
  const own=next.input.worldContext!.actorInputs[id].worldContext!.entities.find(entity=>entity.id===id)!;
  assert(own.knownByCharacterIds.includes(id));
  const {createStoryRuntime}=await import(pathToFileURL(process.env.HARNESS_MODULE_PATH||resolve(process.env.HARNESS_ROOT||'../../roleplay-harness','dist/apps/agentic-v3/index.js')).href);
  const runtime=createStoryRuntime({mode:'demo',delayMs:0});let chunks=0;
  const response=await runtime.streamDialogue(next.input,{attemptId:next.attempt,signal:new AbortController().signal,onTextDelta:()=>{chunks++;},onCall:(record:any)=>f.store.saveCall(next,record),onCheckpoint:(checkpoint:any)=>f.store.saveCheckpoint(next,checkpoint)});
  assert.equal(response.replies.length,1);assert(chunks>0);
  await f.store.commitDialogue(next,response);
  assert.equal((await f.store.getTurn('alice',next.id)).assistantMessages?.length,1);
 }finally{await f.cleanup();}
});
