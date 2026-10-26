import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture } from './pg-helper.ts';
import { candidateRecoveryCharacters } from '../server/unresolved-candidates.ts';

test('candidate recovery audience cannot broadcast private memory or unsupported recipients',()=>{
  const row={character_id:'a',episode_participant_ids:['a','b'],activities:[],candidate_commands:[
    {command:{type:'memory',characterId:'b'},recoveryCharacterIds:['a','b','outsider']},
    {command:{type:'defer'},recoveryCharacterIds:['a']},
  ]};
  assert.deepEqual(candidateRecoveryCharacters(row),['b']);
  assert.deepEqual(candidateRecoveryCharacters({...row,candidate_commands:[{command:{type:'item'}}]}),['a'],'legacy commands only recover for the source actor');
  assert.deepEqual(candidateRecoveryCharacters({...row,candidate_commands:[{command:{type:'defer',evidenceKind:'actual_action'},recoveryCharacterIds:['b']}]}),['b'],'failure to archive an actual action is not an ordinary undecided proposal');
});

test('completed jobs retain scoped unresolved source indexes while deliberate defer is not a missing fact',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try{
    const s=await f.store.createSession('alice','lin-wan');const second=randomUUID();
    await f.store.pool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES('alice',$1,$2,'npc','阿青','抄写员','{}',$3)",[s.world.id,second,[second]]);
    await f.store.setScene('alice',s.world.id,s.world.revision,{location:'客厅',presentCharacterIds:['lin-wan',second],mode:'ensemble'},s.session.id);
    const settle=async(command:Record<string,unknown>,recoveryCharacterIds?:string[])=>{
      const turn=await f.store.beginTurn('alice',s.session.id,randomUUID(),'好呀。');
      const text='林晚点了点头。';
      const dialogue={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},observations:{'lin-wan':'好呀。',[second]:'好呀。'},scene:turn.input.scene};
      await f.store.commitDialogue(turn,dialogue);
      const job=await f.store.claimSettlement();assert(job);
      await f.store.saveSettlementResult(job,{...dialogue,deferredCommands:[{id:'candidate',command,reason:'保留证据待核对',evidenceIds:[],...(recoveryCharacterIds?{recoveryCharacterIds}:{})}]});
      assert(await f.store.completeSettlement(job));return turn;
    };
    const memory=await settle({type:'memory',characterId:second,summary:'仅阿青的私人解释。'},['lin-wan',second]);
    const gap=await settle({type:'source_gap',source:'actor',characterId:second},[second]);
    const item=await settle({type:'item',subjectId:'lin-wan',name:'未应用的物品'});
    const decidedLater=await settle({type:'defer',reason:'玩家还没有决定。'},['lin-wan',second]);
    const world=await f.store.getWorld('alice',s.world.id);
    assert.equal(world.settlementBacklog?.pendingTurns,0);assert.equal(world.settlementBacklog?.unresolvedCommands,3);assert.equal(world.settlementBacklog?.unresolvedTurns,3);
    assert.equal(world.settlements!.find(entry=>entry.turnId===memory.id)!.unresolvedCommands,1);
    assert.equal(world.settlements!.find(entry=>entry.turnId===decidedLater.id)!.unresolvedCommands,0);
    const input=await f.store.previewInput('alice',s.session.id,'接着聊吧。');
    const primary=input.contextPack!.memory.pendingTurnIds;
    const other=input.worldContext!.actorInputs[second].contextPack!.memory.pendingTurnIds;
    assert(primary.includes(item.id));assert(!primary.includes(memory.id));assert(!primary.includes(gap.id));
    assert(other.includes(memory.id));assert(other.includes(gap.id));assert(!other.includes(item.id));
    assert(!primary.includes(decidedLater.id));assert(!other.includes(decidedLater.id));
    assert(primary.length<=32&&other.length<=32);
    assert(!JSON.stringify(input).includes('仅阿青的私人解释'),'candidate text is never promoted into default memories');
    assert(!world.entities!.some(entity=>entity.name==='未应用的物品'));
  }finally{await f.cleanup();}
});

test('open event identity survives recent closed history in world, actor and settlement views; overflow stays bounded',async()=>{
  const f=await postgresFixture({livingWorld:true});
  try{
    const s=await f.store.createSession('alice','lin-wan');
    const turn=await f.store.beginTurn('alice',s.session.id,'old-plan','以后一起去书店。');
    const text='林晚说：“可以，以后去。”';
    const dialogue={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},observations:{'lin-wan':turn.input.userText},scene:turn.input.scene};
    await f.store.commitDialogue(turn,dialogue);
    const insert=async(id:string,phase:string)=>{
      const record={id,kind:'commitment',subjectId:'lin-wan',summary:id,phase,sourceTurnId:turn.id,lastSourceTurnId:turn.id,evidenceIds:['source'],version:1};
      await f.store.pool.query('INSERT INTO world_story_events(owner_id,world_id,id,version,record,source_turn_id,last_source_turn_id) VALUES($1,$2,$3,1,$4,$5,$5)',['alice',s.world.id,id,record,turn.id]);
    };
    await insert('old-open-plan','planned');
    for(let i=0;i<105;i++)await insert(`closed-${i}`,'completed');
    const world=await f.store.getWorld('alice',s.world.id);assert.equal(world.eventLedger!.length,100);assert(world.eventLedger!.some(event=>event.id==='old-open-plan'));
    const packet=await f.store.previewInput('alice',s.session.id,'继续。');assert(packet.eventLedger!.some(event=>event.id==='old-open-plan'));
    const job=await f.store.claimSettlement();assert(job);assert(job.input.eventLedger!.some(event=>event.id==='old-open-plan'));
    await f.store.saveSettlementResult(job,dialogue);assert(await f.store.completeSettlement(job));
    for(let i=0;i<100;i++)await insert(`open-${i}`,'in_progress');
    const overflow=await f.store.getWorld('alice',s.world.id);assert.equal(overflow.eventLedger!.length,100);assert.equal(overflow.eventLedgerOverflow!.openEvents,101);assert.equal(overflow.eventLedgerOverflow!.omittedOpenEvents,1);
    assert(overflow.eventLedger!.every(event=>['planned','in_progress'].includes(event.phase)));
    const next=await f.store.previewInput('alice',s.session.id,'还有什么？');assert.equal((next.contextPack!.memory as any).openEventsOmitted,1);assert.equal(next.eventLedger!.length,100);
  }finally{await f.cleanup();}
});
