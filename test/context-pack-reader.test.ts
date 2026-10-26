import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {postgresFixture} from './pg-helper.ts';
import type {WorldTurnResult} from '../server/runtime.ts';

async function exchange(store:any,sessionId:string,text:string,reply='林晚说：“好。”',settlement=false) {
  const turn=await store.beginTurn('alice',sessionId,randomUUID(),text);
  const result:WorldTurnResult={text:reply,changes:[],usage:{},replies:[{characterId:'lin-wan',characterName:'林晚',text:reply}],entityChanges:[],activities:[],observations:{'lin-wan':text},scene:turn.input.scene};
  await store.commit(turn,reply,[],{...result,...(settlement?{settlement:result}:{})}); return turn;
}

test('Studio preview reader includes latest committed dialogue but freezes owner/world/actor and excludes later turns',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');const old=await exchange(f.store,s.session.id,'试跑前的最新原文');
    const input=await f.store.previewInput('alice',s.session.id,'试跑问题');
    const request={worldId:input.world.id,sourceTurnId:input.turnId,characterId:input.character.id};
    assert.deepEqual((await f.store.readDialogueForSource(request)).episodes.map(e=>e.turnId),[old.id]);
    const later=await exchange(f.store,s.session.id,'试跑冻结后的原文');
    assert.deepEqual((await f.store.readDialogueForSource(request)).episodes.map(e=>e.turnId),[old.id]);
    await assert.rejects(f.store.readDialogue('bob',request),{code:'DIALOGUE_SCOPE'});
    await assert.rejects(f.store.readDialogue('alice',{...request,characterId:'other'}),{code:'DIALOGUE_SCOPE'});
    await assert.rejects(f.store.readDialogue('alice',{...request,turnIds:[later.id]}),{code:'DIALOGUE_SCOPE'});
    const other=await f.store.createSession('alice','lin-wan');
    await assert.rejects(f.store.readDialogueForSource({...request,worldId:other.world.id}),{code:'DIALOGUE_SCOPE'});
    assert.equal((await f.store.pool.query('SELECT count(*)::int AS n FROM turns WHERE id=$1',[input.turnId])).rows[0].n,0);
    assert.deepEqual((await f.store.readDialogueForSource({...request,query:'a'.repeat(400)})).episodes,[]);
    await assert.rejects(f.store.readDialogueForSource({...request,query:'a'.repeat(401)}),{code:'DIALOGUE_SCOPE'});
  } finally {await f.cleanup();}
});

test('Studio preview capabilities expire after five minutes and retain at most 200 scopes',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');await exchange(f.store,s.session.id,'已经发生');
    const input=await f.store.previewInput('alice',s.session.id,'试跑');
    const request={worldId:input.world.id,sourceTurnId:input.turnId,characterId:input.character.id};
    const scopes=(f.store as any).dialoguePreviews as Map<string,any>;
    assert(scopes.get(input.turnId).expiresAt>Date.now());assert(scopes.get(input.turnId).expiresAt<=Date.now()+300000);
    scopes.get(input.turnId).expiresAt=Date.now()-1;
    await assert.rejects(f.store.readDialogueForSource(request),{code:'DIALOGUE_SCOPE'});assert.equal(scopes.size,0);
    for(let i=0;i<201;i++) scopes.set(randomUUID(),{ownerId:'alice',worldId:input.world.id,characterIds:['lin-wan'],beforeSeq:'1',expiresAt:Date.now()+300000});
    const first=scopes.keys().next().value!;
    await f.store.previewInput('alice',s.session.id,'新的试跑');
    assert.equal(scopes.size,200);assert(!scopes.has(first));
    await assert.rejects(f.peer().readDialogueForSource(request),{code:'DIALOGUE_SCOPE'});
  } finally {await f.cleanup();}
});

test('Studio frozen boundary also excludes an older unfinished turn that commits after the preview',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');const earlier=await exchange(f.store,s.session.id,'后来才完成的旧回合');
    await f.store.pool.query("UPDATE turns SET status='failed' WHERE id=$1",[earlier.id]);
    const current=await exchange(f.store,s.session.id,'试跑前已完成');
    const input=await f.store.previewInput('alice',s.session.id,'试跑');
    await f.store.pool.query("UPDATE turns SET status='committed' WHERE id=$1",[earlier.id]);
    const request={worldId:input.world.id,sourceTurnId:input.turnId,characterId:input.character.id};
    assert.deepEqual((await f.store.readDialogueForSource(request)).episodes.map(e=>e.turnId),[current.id]);
    await assert.rejects(f.store.readDialogueForSource({...request,turnIds:[earlier.id]}),{code:'DIALOGUE_SCOPE'});
  } finally {await f.cleanup();}
});

test('default context contains authored card and existing compact memory, no automatic dialogue transcript',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan'); const old=await exchange(f.store,s.session.id,'ONLY_IN_ORIGINAL_秘密线索','林晚收好了信封。',true);
    await f.store.pool.query("UPDATE world_entities SET state=state || $2::jsonb WHERE world_id=$1 AND id='lin-wan'",[s.session.worldId,{arc:'林晚保管着信封。',arcProvenance:{kind:'character_view',status:'source_verified',turnId:old.id,source:'actor',characterId:'lin-wan',quote:'林晚收好了信封。'}}]);
    const input=await f.store.previewInput('alice',s.session.id,'然后呢？');
    for(const packet of [input,...Object.values(input.worldContext!.actorInputs)]) {
      assert.deepEqual(packet.history,[]);assert.deepEqual(packet.episodes,[]);assert.deepEqual(packet.world.events,[]);
      assert.equal(packet.contextPack!.characterId,packet.character.id);assert.equal(packet.contextPack!.card.personality,packet.character.definition);
      assert(packet.contextPack!.card.openingBackground);assert.equal(packet.contextPack!.memory.summary,'林晚保管着信封。');
      assert(packet.contextPack!.memory.pendingTurnIds.includes(old.id));assert(!JSON.stringify(packet).includes('ONLY_IN_ORIGINAL_秘密线索'));
    }
    assert.equal((await f.store.getTurn('alice',old.id)).userMessage.content,'ONLY_IN_ORIGINAL_秘密线索');
  } finally {await f.cleanup();}
});

test('reader enforces owner/world/frozen cutoff and returns only past observed user fragments',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');
    const old=await f.store.beginTurn('alice',s.session.id,randomUUID(),'我说：“明天见。”心里想着密码0837。');
    await f.store.commit(old,'林晚说：“明天见。”',[],{observations:{'lin-wan':'我说：“明天见。”'}});
    const source=await exchange(f.store,s.session.id,'查询这一轮'); const later=await exchange(f.store,s.session.id,'未来SECRET');
    const request={worldId:s.session.worldId,sourceTurnId:source.id,characterId:'lin-wan',turnIds:[old.id]};
    const result=await f.store.readDialogue('alice',request);assert.equal(result.episodes.length,1);assert.equal(result.episodes[0].userText,'我说：“明天见。”');assert(!JSON.stringify(result).includes('0837'));
    await assert.rejects(f.store.readDialogue('bob',request),{code:'DIALOGUE_SCOPE'});
    await assert.rejects(f.store.readDialogue('alice',{...request,characterId:'unrelated'}),{code:'DIALOGUE_SCOPE'});
    await assert.rejects(f.store.readDialogue('alice',{...request,turnIds:[later.id]}),{code:'DIALOGUE_SCOPE'});
    await assert.rejects(f.store.readDialogue('alice',{...request,turnIds:[source.id]}),{code:'DIALOGUE_SCOPE'});
    const other=await f.store.createSession('alice','lin-wan');
    await assert.rejects(f.store.readDialogue('alice',{...request,worldId:other.session.worldId}),{code:'DIALOGUE_SCOPE'});
    assert.deepEqual(await f.store.readDialogueForSource(request),result);
    assert.deepEqual((await f.store.readDialogue('alice',{...request,turnIds:undefined,query:'0837'})).episodes,[]);
  } finally {await f.cleanup();}
});

test('empty query means only latest three authorized past turns; explicit oversized requests cannot widen range',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');const old=[];
    for(let i=0;i<5;i++) old.push(await exchange(f.store,s.session.id,`第${i}轮`));
    const source=await exchange(f.store,s.session.id,'读取之前');
    const request={worldId:s.session.worldId,sourceTurnId:source.id,characterId:'lin-wan'};
    const result=await f.store.readDialogue('alice',{...request,query:'   '});
    assert.deepEqual(result.episodes.map(e=>e.turnId),old.slice(-3).map(e=>e.id));assert(result.truncated);
    await assert.rejects(f.store.readDialogue('alice',{...request,limit:100}),{code:'DIALOGUE_SCOPE'});
    await assert.rejects(f.store.readDialogue('alice',{...request,turnIds:old.map(e=>e.id)}),{code:'DIALOGUE_SCOPE'});
    await assert.rejects(f.store.readDialogue('alice',{...request,ownerId:'bob'} as any),{code:'DIALOGUE_SCOPE'});
    assert(JSON.stringify(result).length<=12000);
  } finally {await f.cleanup();}
});

test('a known current NPC cannot retrieve another character private past participation',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');const privateTurn=await exchange(f.store,s.session.id,'只有林晚知道的事');
    const newcomer=randomUUID();const introduction=await f.store.beginTurn('alice',s.session.id,randomUUID(),'有人来了');
    await f.store.commit(introduction,'林晚点头。',[],{scene:{...introduction.input.scene!,presentCharacterIds:['lin-wan',newcomer],mode:'ensemble'},observations:{'lin-wan':'有人来了',[newcomer]:'有人来了'},entityChanges:[{op:'create',entity:{id:newcomer,kind:'npc',name:'程叶',description:'新来的访客。'}}]});
    const source=await exchange(f.store,s.session.id,'现在');
    assert(source.input.worldContext!.actorInputs[newcomer]);
    await assert.rejects(f.store.readDialogue('alice',{worldId:s.session.worldId,sourceTurnId:source.id,characterId:newcomer,turnIds:[privateTurn.id]}),{code:'DIALOGUE_SCOPE'});
    const result=await f.store.readDialogue('alice',{worldId:s.session.worldId,sourceTurnId:source.id,characterId:newcomer});
    assert(!JSON.stringify(result).includes('只有林晚知道的事'));
  } finally {await f.cleanup();}
});

test('rebased background jobs keep their frozen summary rather than importing a later turn arc',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');
    await f.store.pool.query("UPDATE world_entities SET state=state || '{\"arc\":\"过去已知的S1\"}'::jsonb WHERE world_id=$1 AND id='lin-wan'",[s.session.worldId]);
    const source=await exchange(f.store,s.session.id,'当前对话','林晚点头。',true);
    assert.equal(source.input.contextPack!.memory.summary,'过去已知的S1');
    const later=await exchange(f.store,s.session.id,'后来的剧情');
    await f.store.pool.query("UPDATE world_entities SET state=state || $2::jsonb,version=version+1 WHERE world_id=$1 AND id='lin-wan'",[s.session.worldId,{arc:'未来才知道的S2',arcProvenance:{kind:'character_view',status:'source_verified',turnId:later.id,source:'actor',characterId:'lin-wan',quote:'林晚说：“好。”'}}]);
    const job=await f.store.claimSettlement();assert(job);
    assert.equal(job.input.contextPack!.memory.summary,'过去已知的S1');
    assert.equal(job.input.worldContext!.actorInputs['lin-wan'].contextPack!.memory.summary,'过去已知的S1');
    assert(!JSON.stringify(job.input).includes('未来才知道的S2'));
  } finally {await f.cleanup();}
});

test('background settlement inherits a verified earlier pending turn summary that completed after its foreground input froze',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');
    const previous=await exchange(f.store,s.session.id,'我写下好，把纸条推回。','林晚画了一只小猫。',true);
    const source=await exchange(f.store,s.session.id,'然后点头。','林晚收好了纸条。',true);
    assert.equal(source.input.contextPack!.memory.summary,'');
    const first=await f.store.claimSettlement();assert(first);assert.equal(first.turnId,previous.id);
    const npc=first.input.worldContext!.entities.find(e=>e.id==='lin-wan')!;
    await f.store.saveSettlementResult(first,{...first.dialogue,entityChanges:[{op:'update',entity:{id:npc.id,kind:'npc',name:npc.name,description:npc.description,state:{arc:'玩家写下好，林晚画了一只小猫。'}},baseVersion:npc.version,arcSource:{source:'actor',characterId:npc.id,quote:'林晚画了一只小猫。'}}]});
    assert.equal(await f.store.completeSettlement(first),true);
    const next=await f.store.claimSettlement();assert(next);assert.equal(next.turnId,source.id);
    for(const packet of [next.input,...Object.values(next.input.worldContext!.actorInputs)]) {
      assert.equal(packet.contextPack!.memory.summary,'玩家写下好，林晚画了一只小猫。');
      assert.equal(packet.contextPack!.memory.sourceTurnId,previous.id);
      assert.equal((packet.worldContext!.entities.find(e=>e.id===packet.character.id)!.state.characterView as any).summary,packet.contextPack!.memory.summary);
      assert.deepEqual(packet.contextPack!.card,source.input.contextPack!.card);
    }
    assert.equal((await f.store.storedTurn('alice',source.id)).input.contextPack!.memory.summary,'');
    // A historical retry must recover the committed predecessor even when the
    // live NPC view has since moved beyond this source turn.
    await f.store.yieldSettlement(next);
    const later=await exchange(f.store,s.session.id,'后来出现的新剧情');
    await f.store.pool.query("UPDATE world_entities SET state=state || $2::jsonb,version=version+1 WHERE world_id=$1 AND id='lin-wan'",[s.world.id,{arc:'未来摘要不应泄漏',arcProvenance:{kind:'character_view',status:'source_verified',turnId:later.id,source:'actor',characterId:'lin-wan',quote:'林晚说：“好。”'}}]);
    await f.store.pool.query('UPDATE world_settlements SET next_attempt_at=clock_timestamp() WHERE id=$1',[next.id]);
    const replay=await f.store.claimSettlement();assert(replay);
    assert.equal(replay.input.contextPack!.memory.summary,'玩家写下好，林晚画了一只小猫。');
    assert.equal(replay.input.contextPack!.memory.sourceTurnId,previous.id);
    assert.equal((replay.input.worldContext!.entities.find(e=>e.id==='lin-wan')!.state.characterView as any).summary,replay.input.contextPack!.memory.summary);
    assert(!JSON.stringify(replay.input).includes('未来摘要不应泄漏'));
  }finally{await f.cleanup();}
});

test('unverified, same-turn, cross-world and wrong-character current summaries cannot replace the frozen background memory',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');const prior=await exchange(f.store,s.session.id,'过去');
    const source=await exchange(f.store,s.session.id,'本轮','林晚点头。',true);
    const other=await f.store.createSession('alice','lin-wan');const foreign=await exchange(f.store,other.session.id,'别的世界');
    const base={kind:'character_view',status:'source_verified',source:'actor',characterId:'lin-wan',quote:'林晚说：“好。”'};
    for(const provenance of [undefined,{...base,turnId:source.id},{...base,turnId:foreign.id},{...base,turnId:prior.id,characterId:'someone-else'}]) {
      await f.store.pool.query("UPDATE world_entities SET state=(state-'arcProvenance') || $2::jsonb,version=version+1 WHERE world_id=$1 AND id='lin-wan'",[s.session.worldId,{arc:'不得承接的摘要',...(provenance?{arcProvenance:provenance}:{})}]);
      const job=await f.store.claimSettlement();assert(job);assert.equal(job.turnId,source.id);
      assert.equal(job.input.contextPack!.memory.summary,'');assert(!JSON.stringify(job.input).includes('不得承接的摘要'));
      await f.store.yieldSettlement(job);
      await f.store.pool.query('UPDATE world_settlements SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.id]);
    }
  }finally{await f.cleanup();}
});

test('oversized original dialogue remains archived and is omitted whole within the reader character ceiling',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan');const old=await exchange(f.store,s.session.id,'长'.repeat(7900),'原'.repeat(11000));
    const source=await exchange(f.store,s.session.id,'稍后查询');
    const result=await f.store.readDialogue('alice',{worldId:s.session.worldId,sourceTurnId:source.id,characterId:'lin-wan',turnIds:[old.id]});
    assert(result.truncated);assert.deepEqual(result.episodes,[]);assert(JSON.stringify(result).length<=12000);
    assert.equal((await f.store.getTurn('alice',old.id)).assistantMessage!.content.length,11000);
  } finally {await f.cleanup();}
});
