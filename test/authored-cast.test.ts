import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresFixture } from './pg-helper.ts';
import { authoredCast,castMemberId } from '../server/authored-cast.ts';
import { knownEntityRows,loadContextSnapshot } from '../server/context-snapshot.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cast={version:1,sharedBackground:'乔安与麦芮共同经营咖啡馆，两人都认识玩家。',members:[
  {key:'owner',name:'乔安',description:'咖啡馆店主',personality:'谨慎，私下担心账目。',aliases:['Joan']},
  {key:'baker',name:'麦芮',description:'咖啡馆烘焙师',personality:'开朗，关心烤炉。',aliases:['Mary']},
]} as const;
test('authored cast requires explicit distinct identities; titles never infer people',()=>{
  assert.equal(authoredCast({name:'甲与乙'}),undefined);
  assert.throws(()=>authoredCast({cast:{...cast,members:[cast.members[0],cast.members[0]]}}),/Invalid authored cast/);
  assert.throws(()=>authoredCast({cast:{...cast,members:[{...cast.members[0],presentAtStart:false},cast.members[1]]}}),/Invalid authored cast/);
  assert.equal(castMemberId('root','owner',0),'root');
  assert.equal(castMemberId('root','baker',1),castMemberId('root','baker',3));
});
test('new authored ensemble has independent NPCs, personalities and authorised packets with one welcome message',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try{
    await f.migrationPool.query("UPDATE characters SET name='咖啡馆姐妹',source=$1 WHERE id='lin-wan'",[{cast}]);
    const created=await f.store.createSession('alice','lin-wan');
    const second=castMemberId('lin-wan','baker',1);
    assert.equal(created.session.characterId,'lin-wan');assert.match(created.session.title,/咖啡馆姐妹/);
    assert.equal(created.messages.length,1,'one card welcome, not one bubble per NPC');
    assert.deepEqual(created.world.scene?.presentCharacterIds,['lin-wan',second]);
    assert.deepEqual(created.world.entities?.filter(e=>e.kind==='npc').map(e=>e.name),['乔安','麦芮']);
    const packet=await f.store.previewInput('alice',created.session.id,'早上好');
    assert.equal(packet.character.name,'乔安');
    const other=packet.worldContext!.actorInputs[second];
    assert.equal(other.character.name,'麦芮');assert.match(other.contextPack!.card.personality,/开朗/);
    assert(!other.contextPack!.card.personality.includes('担心账目'));
    assert(!JSON.stringify(other.worldContext?.entities).includes('担心账目'));
    assert.equal(packet.worldContext!.actorInputs['lin-wan'].character.name,'乔安');
    assert.deepEqual(packet.worldContext!.actorInputs['lin-wan'].worldContext!.entities.find(e=>e.id===second)?.state.narrativeAliases,['Mary']);
  }finally{await f.cleanup();}
});
test('explicit old-world split preserves reviewed public memory, archives unsplit memory, and cannot consume another world source',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try{
    const created=await f.store.createSession('alice','lin-wan');
    const turn=await f.store.beginTurn('alice',created.session.id,'tea','我想喝红茶。');
    await f.store.commit(turn,'乔安将红茶递给玩家，麦芮端来蛋糕。',[]);
    await f.migrationPool.query("UPDATE world_entities SET state=state||$3::jsonb WHERE world_id=$1 AND id=$2",[created.world.id,'lin-wan',{arc:'旧合并摘要含未经分人的私人猜测。'}]);
    await f.migrationPool.query("UPDATE characters SET name='咖啡馆姐妹',source=$1 WHERE id='lin-wan'",[{cast}]);
    const revision=(await f.store.getWorld('alice',created.world.id)).revision;
    const memory={summary:'玩家想喝红茶；乔安递来红茶，麦芮端来蛋糕。',sourceTurnIds:[turn.id]};
    await assert.rejects(f.store.repairAuthoredCast('bob',created.world.id,revision,memory),{code:'WORLD_NOT_FOUND'});
    await assert.rejects(f.store.repairAuthoredCast('alice',created.world.id,revision,{...memory,sourceTurnIds:['00000000-0000-4000-8000-000000000000']}),{code:'CAST_MEMORY_INVALID'});
    const repaired=await f.store.repairAuthoredCast('alice',created.world.id,revision,memory);
    const second=castMemberId('lin-wan','baker',1);
    assert.deepEqual(repaired.scene?.presentCharacterIds,['lin-wan',second]);
    const primary=repaired.entities!.find(e=>e.id==='lin-wan')!;
    assert.equal(primary.name,'乔安');assert.equal(primary.state.arc,undefined);
    assert.match(JSON.stringify(primary.state.legacyEnsembleMemory),/私人猜测/);
    const packet=await f.store.previewInput('alice',created.session.id,'谢谢');
    for(const id of ['lin-wan',second]){
      const actor=packet.worldContext!.actorInputs[id];
      assert.match(actor.contextPack!.memory.summary,/红茶/);assert.match(actor.contextPack!.memory.summary,/蛋糕/);
      assert(!JSON.stringify(actor).includes('私人猜测'));
    }
    // Stale knowledge is not allowed to undo an authored identity correction.
    await f.migrationPool.query("UPDATE world_entity_knowledge SET snapshot=jsonb_set(snapshot,'{name}','\"旧合并名\"') WHERE world_id=$1 AND character_id=$2 AND entity_id=$3",[created.world.id,second,'lin-wan']);
    const snapshot=await loadContextSnapshot(f.store.pool,'alice',created.world.id);
    assert.equal(knownEntityRows(snapshot,second).find(e=>e.row.id==='lin-wan')!.row.name,'乔安');
    const again=await f.store.repairAuthoredCast('alice',created.world.id,repaired.revision,memory);
    assert.equal(again.entities!.filter(e=>e.kind==='npc').length,2);
    assert.equal((await f.store.getSession('alice',created.session.id)).messages.length,3,'repair does not rewrite chat history');
  }finally{await f.cleanup();}
});

test('one real scene message settles both authored NPC memories and a planned dish through the Harness reducer and PostgreSQL commit',async()=>{
  const modulePath=process.env.HARNESS_MODULE_PATH||resolve(process.env.HARNESS_ROOT||'../../roleplay-harness','dist/apps/agentic-v3/index.js');
  const base=pathToFileURL(modulePath);
  const [{reduceEventOps},{attributeSceneEvidence,sceneEvidenceReplies},{opsSources}]=await Promise.all([
    import(new URL('./event-reducer.js',base).href),import(new URL('./scene-response.js',base).href),import(new URL('./ops-sources.js',base).href),
  ]);
  const f=await postgresFixture({livingWorld:true});
  try{
    await f.migrationPool.query("UPDATE characters SET name='咖啡馆姐妹',source=$1 WHERE id='lin-wan'",[{cast}]);
    const s=await f.store.createSession('alice','lin-wan',undefined,{scene:{location:'客厅',presentCharacterIds:['lin-wan',castMemberId('lin-wan','baker',1)],mode:'ensemble'}});
    const second=castMemberId('lin-wan','baker',1);
    const turn=await f.store.beginTurn('alice',s.session.id,'natural-dinner','今晚吃三杯鸡，加米饭和汤吧。');
    const text='乔安说：“三杯鸡选好了，米饭也加上，稍后再下单。”\n\n麦芮说：“再配一份紫菜蛋花汤，我来看看购物车。”';
    const observations={'lin-wan':turn.input.userText,[second]:turn.input.userText};
    const dialogue={text,replies:[{characterId:'lin-wan',characterName:'咖啡馆姐妹',text}],changes:[],entityChanges:[],activities:[],usage:{},scene:turn.input.scene,observations,attributedEvidence:attributeSceneEvidence(turn.input,text)};
    await f.store.commitDialogue(turn,dialogue);
    const committed=await f.store.getTurn('alice',turn.id);
    assert.equal(committed.status,'committed');assert.equal(committed.assistantMessages?.length,1);
    const job=await f.store.claimSettlement();assert(job);
    const rootOther=job.input.worldContext!.entities.find(e=>e.id===second)!;
    assert.equal(rootOther.description,'','the focal NPC must receive only the other identity, not its private profile');
    const ownOther=job.input.worldContext!.actorInputs[second].worldContext!.entities.find(e=>e.id===second)!;
    assert.equal(ownOther.description,'咖啡馆烘焙师');
    const replies=sceneEvidenceReplies(job.input,job.dialogue);
    const sources=opsSources(job.input,replies,[],observations);
    const proof=(id:string)=>sources.segments.find((segment:any)=>segment.source==='actor'&&segment.characterId===id)!.id;
    // Fake extractor output, real attribution/reducer/storage. No paid model call.
    const commands={contractVersion:3,commands:[
      {id:'joan-memory',type:'memory',characterId:'lin-wan',summary:'记得今晚选了三杯鸡和米饭，尚未下单。',evidenceId:proof('lin-wan'),evidenceKind:'actual_action'},
      {id:'mary-memory',type:'memory',characterId:second,summary:'记得今晚还选了紫菜蛋花汤，正在查看购物车。',evidenceId:proof(second),evidenceKind:'actual_action'},
      {id:'main-dish',type:'item',subjectId:'lin-wan',key:'three-cup-chicken',name:'三杯鸡',description:'今晚已选定的主菜。',state:{status:'已选定，尚未下单'},event:{relation:'new',key:'tonight-main-dish',phase:'planned',summary:'选三杯鸡作为今晚主菜，稍后下单。'},evidenceId:proof('lin-wan'),evidenceKind:'proposal'},
    ]};
    const reduced=reduceEventOps(commands,job.input,replies,[],[],observations);
    assert.deepEqual(reduced.discardedEntityChanges,[]);assert.deepEqual(reduced.deferredCommands,[]);
    assert.equal(reduced.entityChanges.find((change:any)=>change.entity.id===second)!.entity.description,'咖啡馆烘焙师','own identity must survive public-view redaction');
    await f.store.saveSettlementResult(job,{...job.dialogue,...reduced});
    assert.equal(await f.store.completeSettlement(job),true,'all independent memory and intent commands must commit together');
    const world=await f.store.getWorld('alice',s.world.id);
    for(const [id,name] of [['lin-wan','乔安'],[second,'麦芮']]){
      const npc=world.entities!.find(e=>e.id===id)!;
      assert.equal(npc.name,name);assert.equal((npc.state.arcProvenance as any).status,'source_verified');assert.match(String(npc.state.arc),/记得今晚/);
    }
    const dish=world.entities!.find(e=>e.kind==='item'&&e.name==='三杯鸡')!;assert(dish);
    assert.equal((dish.state.pendingIntent as any).phase,'planned');assert.equal(dish.state.holderCharacterId,undefined,'selection does not create actual possession');
    assert.equal(world.settlements!.find(entry=>entry.turnId===turn.id)!.status,'completed');
    const snapshots=(await f.store.pool.query('SELECT character_id,summary FROM world_memory_snapshots WHERE world_id=$1 ORDER BY character_id',[s.world.id])).rows;
    assert.equal(snapshots.length,2);assert(snapshots.some(row=>row.character_id===second&&row.summary.includes('紫菜蛋花汤')));
    assert.equal((await f.store.getTurn('alice',turn.id)).assistantMessages?.[0].content,text);
  }finally{await f.cleanup();}
});
