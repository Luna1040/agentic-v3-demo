import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';
import { initialStoryTime, unknownStoryTime, validStoryTime, validateStoryAdvance, resolveStoryTime, settlementWindow } from '../shared/story-time.ts';
import type { StoryTime, TemporalContext, EntityChange } from '../shared/living-world.ts';

const at = (day: number, minute: number): StoryTime => ({ day,minute,precision:'minute',source:{kind:'setup'} });
const explicit = (day:number,minute:number|null,quote:string,turnId='turn',period?:StoryTime['period']): StoryTime => ({ day,minute,precision:minute !== null ? 'minute' : period ? 'period' : 'day',...(period ? {period} : {}),source:{kind:'user_explicit',turnId,quote} });
const temporal = (story:StoryTime,gap:number,eligible=true): TemporalContext => ({story,real:{now:'2026-10-22T12:00:00.000Z',previousTurnAt:'2026-10-15T12:00:00.000Z',elapsedMs:gap},offlineEligible:eligible,realGapStoryMs:gap});

test('story time rejects performance durations, future arrangements, ambiguous clocks and contradictory precision',()=>{
  const prior=at(1,990);
  for(const quote of ['我跑完，用时17:20。','我一点也不累。','明天下午四点半见。','现在四点半还差五分。']) assert.throws(()=>validateStoryAdvance(prior,explicit(1,1040,quote),quote,'turn'));
  const quote='我到达时是四点半。';
  assert.throws(()=>validateStoryAdvance(initialStoryTime(),explicit(1,270,quote),quote,'turn'));
  assert.equal(validateStoryAdvance(prior,explicit(1,990,quote),quote,'turn').minute,990);
  assert.equal(validStoryTime({...at(1,270),period:'afternoon'}),false);
  assert.equal(validStoryTime({...initialStoryTime(),day:0}),false);
  const conflict='两小时后，现在是17:00。';
  assert.throws(()=>validateStoryAdvance(prior,explicit(1,1020,conflict),conflict,'turn'));
  const spoken='我说：“次日下午四点半我来操场。”', excerpt='次日下午四点半我来操场';
  assert.throws(()=>validateStoryAdvance(at(1,900),explicit(2,990,excerpt),spoken,'turn'));
  for(const text of ['我现在不是下午四点半。','我跑出16:38的成绩。']) assert.throws(()=>validateStoryAdvance(at(1,900),explicit(1,text.includes('成绩')?998:990,text),text,'turn'));
  const unrelated='第二天下午，我没有迟到，来到操场。';assert.equal(validateStoryAdvance(prior,explicit(2,null,unrelated,'turn','afternoon'),unrelated,'turn').day,2);
  const hungry='现在下午四点半，我还没吃饭。';assert.equal(validateStoryAdvance(at(1,900),explicit(1,990,hungry),hungry,'turn').minute,990);
});

test('explicit next days and elapsed durations are grounded once, while unknown history stays unassigned',()=>{
  let quote='第二天下午16:30，我来到操场。';
  assert.equal(validateStoryAdvance(at(1,990),explicit(2,990,quote),quote,'turn').day,2);
  assert.equal(validateStoryAdvance(unknownStoryTime(),explicit(1,990,quote),quote,'turn').day,1);
  quote='第三天下午，我来到操场。';
  assert.equal(validateStoryAdvance(at(2,990),explicit(3,null,quote,'turn','afternoon'),quote,'turn').day,3);
  quote='过了五分钟后，我回来。';
  assert.equal(validateStoryAdvance(at(1,990),explicit(1,995,quote),quote,'turn').minute,995);
  quote='第二天，一天后我来到这里。';
  assert.equal(validateStoryAdvance(at(1,990),explicit(2,null,quote),quote,'turn').day,2);
});

test('full real absence remains seven days; generation limits cannot shorten chronology or bypass an unfinished scene',()=>{
  const gap=7*86400000+120000;
  const full=resolveStoryTime(temporal(at(1,990),gap),undefined,'回来','turn');
  assert.equal(full.elapsedMs,gap);assert.equal(full.story.day,8);assert.equal(full.story.minute,992);
  const coarse=resolveStoryTime(temporal({...initialStoryTime(),precision:'period',period:'afternoon'},gap),undefined,'回来','turn');
  assert.equal(coarse.story.day,8);assert.equal(coarse.story.precision,'day');assert.equal(coarse.story.period,undefined);
  const unknown=resolveStoryTime(temporal(unknownStoryTime(),gap),undefined,'回来','turn');assert.equal(unknown.story.day,null);
  const held=resolveStoryTime(temporal(at(1,990),gap,false),undefined,'嗯','turn');assert.equal(held.elapsedMs,0);assert.equal(held.story.day,1);
  const quote='第二天下午16:30，我回来了。';
  const explicitTime=resolveStoryTime(temporal(at(1,990),gap),explicit(2,990,quote),quote,'turn');assert.equal(explicitTime.elapsedMs,86400000);assert.equal(explicitTime.story.day,2);
  assert.throws(()=>resolveStoryTime(temporal(at(1,990),gap),{...at(99,0),source:{kind:'real_gap',turnId:'turn'}},'回来','turn'));
});

async function fixture() {
  const f=await postgresFixture({livingWorld:true});
  try {
    const session=await f.store.createSession('alice','lin-wan',undefined,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:['lin-wan'],mode:'ensemble'}});
    const turn=await f.store.beginTurn('alice',session.session.id,`opening:${session.session.id}`,'开始场景',{}, {operation:'opening'});
    const other=randomUUID();
    await f.store.commit(turn,'林晚整理书架。',[],{entityChanges:[{op:'create',entity:{id:other,kind:'npc',name:'阿青',description:'抄写员',state:{definition:'谨慎可靠'}}}],scene:{location:'阅览室',presentCharacterIds:['lin-wan',other],mode:'ensemble'}});
    return {...f,session:session.session,other};
  } catch(error) {await f.cleanup();throw error;}
}

test('time snapshots survive cancel/retry and commit chronology independently of UTC records and encounter cursors',async()=>{
  const f=await fixture();try{
    const raw='现在是下午16:30，我来到阅览室。';
    const turn=await f.store.beginTurn('alice',f.session.id,'anchor',raw);
    const proposal=explicit(1,990,raw,turn.id);
    await f.store.cancelTurn('alice',turn.id);
    assert.equal((await f.store.getWorld('alice',f.session.worldId)).storyTime?.minute,null);
    const retry=await f.store.beginTurn('alice',f.session.id,'anchor',raw);assert.deepEqual(retry.input,turn.input);
    const result=await f.store.commit(retry,'她抬头回应。',[],{storyTime:proposal,observations:{'lin-wan':[raw],[f.other]:[raw]}});
    assert.equal(result.world.storyTime?.minute,990);
    assert.equal(result.world.episodes?.at(-1)?.storyTime?.minute,990);assert.match(result.world.episodes!.at(-1)!.recordedAt!,/^\d{4}-.*Z$/);
    const own=result.world.entities!.find(e=>e.id==='lin-wan')!;
    assert.equal(own.state.lastEncounterAt,retry.input.worldContext!.temporal!.real.now);assert.equal(own.state.lastSettledAt,retry.input.worldContext!.temporal!.lastSettled!.recordedAt);
    const next=await f.store.previewInput('alice',f.session.id,'继续');
    assert.equal(next.worldContext!.temporal!.offlineEligible,false);assert.equal(next.worldContext!.temporal!.realGapStoryMs,0);
    assert.equal((await readPastDialogue(f.store,'alice',f.session.id,'lin-wan',[turn.id])).at(-1)!.storyTime!.source.quote,undefined);
    assert.equal((await f.store.beginTurn('alice',f.session.id,'anchor',raw)).status,'committed');
    assert.equal((await f.store.getWorld('alice',f.session.worldId)).storyTime?.day,1);
  }finally{await f.cleanup();}
});

test('seven-day absence advances only on committed return, excludes model work and keeps last encounter separate from settlement',async()=>{
  const f=await fixture();try{
    const raw='现在是下午16:30，我先离开。'; const turn=await f.store.beginTurn('alice',f.session.id,'leave',raw);
    await f.store.commit(turn,'她目送你离开。',[],{storyTime:explicit(1,990,raw,turn.id),scene:{location:'阅览室',presentCharacterIds:['lin-wan',f.other],mode:'ensemble',playerPresent:false}});
    await f.store.pool.query("UPDATE turns SET updated_at=clock_timestamp()-interval '7 days' WHERE id=$1",[turn.id]);
    const back=await f.store.beginTurn('alice',f.session.id,'return','我回来了。');
    assert(back.input.worldContext!.temporal!.real.elapsedMs>=7*86400000);
    const frozen=back.input.worldContext!.temporal!;
    const computed=resolveStoryTime(frozen,undefined,back.input.userText,back.id);
    const out=await f.store.commit(back,'欢迎回来。',[],{storyTime:computed.story,scene:{location:'阅览室',presentCharacterIds:['lin-wan',f.other],mode:'ensemble',playerPresent:true},observations:{'lin-wan':[back.input.userText],[f.other]:[back.input.userText]}});
    assert.equal(out.world.storyTime!.day,8);assert.equal(out.world.entities!.find(e=>e.id==='lin-wan')!.state.lastSettledAt,back.input.worldContext!.temporal!.lastSettled!.recordedAt);
    const next=await f.store.previewInput('alice',f.session.id,'嗯');assert(next.worldContext!.temporal!.real.elapsedMs<60000);assert.equal(next.worldContext!.temporal!.realGapStoryMs,0);
  }finally{await f.cleanup();}
});

test('shared current entities change privately while an absent NPC keeps its old version and cannot overwrite the head',async()=>{
  const f=await fixture();try{
    const item=randomUUID(),create=await f.store.beginTurn('alice',f.session.id,'item','钥匙放在桌上。');
    await f.store.commit(create,'她点头。',[],{entityChanges:[{op:'create',entity:{id:item,kind:'item',name:'银匙',description:'桌上',state:{status:'桌上'},knownByCharacterIds:['lin-wan',f.other]}}]});
    const session=await f.store.createSession('alice','lin-wan',f.session.worldId,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:['lin-wan'],mode:'direct'}});
    const secret=await f.store.beginTurn('alice',session.session.id,'move','我把钥匙悄悄交给你。');
    const known=secret.input.worldContext!.entities.find(e=>e.id===item)!;
    const change:EntityChange={op:'update',baseVersion:known.version,witnessedByCharacterIds:['lin-wan'],entity:{id:item,kind:'item',name:'银匙',description:'秘密放进口袋',state:{status:'口袋中',holderCharacterId:'lin-wan'}}};
    await f.store.commit(secret,'她接过银匙。',[],{entityChanges:[change],observations:{'lin-wan':[secret.input.userText]}});
    const owner=(await f.store.getWorld('alice',f.session.worldId)).entities!.find(e=>e.id===item)!;assert.equal(owner.state.status,'口袋中');assert.equal(owner.version,2);
    const other=await f.store.createSession('alice',f.other,f.session.worldId,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:[f.other],mode:'direct'}});
    const stale=await f.store.beginTurn('alice',other.session.id,'stale','桌上那把钥匙呢？');
    const old=stale.input.worldContext!.entities.find(e=>e.id===item)!;assert.equal(old.version,1);assert.equal(old.state.status,'桌上');assert(!JSON.stringify(old).includes('秘密放进口袋'));
    await assert.rejects(f.store.commit(stale,'他猜测钥匙坏了。',[],{entityChanges:[{...change,baseVersion:1,witnessedByCharacterIds:[f.other],entity:{...change.entity,description:'坏了'}}]}),{code:'ENTITY_VERSION_CONFLICT'});
    assert.equal((await f.store.getWorld('alice',f.session.worldId)).entities!.find(e=>e.id===item)!.version,2);
  }finally{await f.cleanup();}
});

test('re-entering a shared place never reveals private room updates through scene knowledge refresh',async()=>{
  const f=await fixture();try{
    const room=(await f.store.getWorld('alice',f.session.worldId)).entities!.find(e=>e.kind==='location'&&e.name==='阅览室')!;
    const direct=await f.store.createSession('alice','lin-wan',f.session.worldId,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:['lin-wan'],mode:'direct'}});
    const turn=await f.store.beginTurn('alice',direct.session.id,'private-room','只告诉你：暗格密码是夜雨。');
    const text='林晚记下暗格的位置。';
    const result={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},scene:turn.input.scene,observations:{'lin-wan':turn.input.userText}};
    await f.store.commitDialogue(turn,result);
    const job=await f.store.claimSettlement();assert(job);
    const sourceRoom=job.input.worldContext!.entities.find(e=>e.id===room.id)!;
    await f.store.saveSettlementResult(job,{...result,entityChanges:[{op:'update',baseVersion:sourceRoom.version,witnessedByCharacterIds:['lin-wan'],entity:{id:room.id,kind:'location',name:'阅览室',description:'暗格密码夜雨。',state:{secretCode:'夜雨'}}}]});
    assert(await f.store.completeSettlement(job));
    const head=(await f.store.getWorld('alice',f.session.worldId)).entities!.find(e=>e.id===room.id)!;
    assert.equal(head.state.secretCode,'夜雨');
    const back=await f.store.createSession('alice',f.other,f.session.worldId,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:[f.other],mode:'direct'}});
    const next=await f.store.previewInput('alice',back.session.id,'我回来看书。');
    const observed=next.worldContext!.entities.find(e=>e.id===room.id)!;
    assert(observed,'returning NPC still recognises the place');
    assert.equal(observed.name,'阅览室');assert(!JSON.stringify(observed).includes('夜雨'));
    const owner=await f.store.previewInput('alice',direct.session.id,'密码是什么？');
    assert.equal(owner.worldContext!.entities.find(e=>e.id===room.id)!.state.secretCode,'夜雨','the actual listener retains the private update');
    // The durable background projection must retain the same knowledge boundary.
    const nextTurn=await f.store.beginTurn('alice',back.session.id,'return-room','我坐下来。');
    const nextText='阿青翻开书。';
    await f.store.commitDialogue(nextTurn,{...result,text:nextText,replies:[{characterId:f.other,characterName:'阿青',text:nextText}],scene:nextTurn.input.scene,observations:{[f.other]:nextTurn.input.userText}});
    const nextJob=await f.store.claimSettlement();assert(nextJob);
    assert(!JSON.stringify(nextJob.input.worldContext!.entities.find(e=>e.id===room.id)).includes('夜雨'));
  }finally{await f.cleanup();}
});

test('related cross-session episodes survive the recent window with source reasons and obey retraction',async()=>{
  const f=await fixture();try{
    const quest=randomUUID();const raw='明晚门廊还伞。';const first=await f.store.beginTurn('alice',f.session.id,'promise',raw);
    await f.store.commit(first,'我答应明晚在门廊等你。',[{kind:'event',text:raw,characterId:'lin-wan',visibility:'private',evidence:{source:'user',turnId:first.id}}],{observations:{'lin-wan':[raw],[f.other]:[raw]},entityChanges:[{op:'create',entity:{id:quest,kind:'quest',name:'门廊还伞',description:raw,state:{status:'active',ownerCharacterId:'lin-wan'},knownByCharacterIds:['lin-wan']}}]});
    for(let i=0;i<9;i++){const turn=await f.store.beginTurn('alice',f.session.id,`idle-${i}`,`读到第${i}页。`);await f.store.commit(turn,`她翻到下一页${i}。`,[],{observations:{'lin-wan':[turn.input.userText],[f.other]:[turn.input.userText]}});}
    const fresh=await f.store.createSession('alice','lin-wan',f.session.worldId,{dynamicOpening:true});
    const input=await f.store.previewInput('alice',fresh.session.id,'继续');
    const recalled=(await readPastDialogue(f.store,'alice',fresh.session.id,'lin-wan',[first.id])).find(e=>e.turnId===first.id)!;assert(recalled);assert.equal(recalled.userText,raw);assert(input.worldContext!.entities.some(e=>e.id===quest));assert.deepEqual(input.episodes,[]);
    const world=await f.store.getWorld('alice',f.session.worldId);const event=world.events.find(e=>e.sourceTurnId===first.id)!;
    await f.store.setMemoryStatus('alice',f.session.worldId,event.id,world.revision,'retracted');
    assert(!(await readPastDialogue(f.store,'alice',fresh.session.id,'lin-wan',[first.id])).some(e=>e.turnId===first.id));
    assert((await f.store.getWorld('alice',f.session.worldId)).episodes!.some(e=>e.turnId===first.id));
  }finally{await f.cleanup();}
});

test('an absent NPC keeps its pending story interval and an authenticated empty Pulse audit advances only its own cursor',async()=>{
  const f=await fixture();try{
    const raw='现在是下午16:30，我来到阅览室。';const first=await f.store.beginTurn('alice',f.session.id,'day1',raw);
    await f.store.commit(first,'她抬头。',[],{storyTime:explicit(1,990,raw,first.id)});
    const away=await f.store.createSession('alice',f.other,f.session.worldId,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:[f.other],mode:'direct'}});
    const jump='第四天下午16:30，我来到阅览室。';const later=await f.store.beginTurn('alice',away.session.id,'day4',jump);
    await f.store.commit(later,'阿青整理书架。',[],{storyTime:explicit(4,990,jump,later.id)});
    const returning=await f.store.createSession('alice','lin-wan',f.session.worldId,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:['lin-wan'],mode:'direct'}});
    const pending=await f.store.beginTurn('alice',returning.session.id,'return','我坐下。');
    const t=pending.input.worldContext!.temporal!,applied=resolveStoryTime(t,undefined,pending.input.userText,pending.id);
    assert.equal(applied.elapsedMs,0);assert.equal(t.settlementEligible,true);assert(settlementWindow(t,applied)>=3*86400000);
    const before=(await f.store.getWorld('alice',f.session.worldId)).entities!.find(e=>e.id==='lin-wan')!.state.lastSettledAt;
    await assert.rejects(f.store.commit(pending,'她点头。',[],{settledCharacterIds:['lin-wan']}),{code:'ACTIVITY_INVALID'});
    assert.equal((await f.store.getWorld('alice',f.session.worldId)).entities!.find(e=>e.id==='lin-wan')!.state.lastSettledAt,before);
    await f.store.cancelTurn('alice',pending.id);const retry=await f.store.beginTurn('alice',returning.session.id,'return','我坐下。');
    assert.deepEqual(retry.input,pending.input);
    await f.store.saveCall(retry,{id:randomUUID(),parentId:null,attemptId:retry.attempt,agent:'pulse',status:'completed',model:'fixture',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),input:{characters:[{id:'lin-wan'}]},output:{activities:[],settledCharacterIds:['lin-wan']}});
    const saved=await f.store.commit(retry,'她点头。',[],{settledCharacterIds:['lin-wan']});
    assert.equal(saved.world.activities!.length,0);assert.equal((saved.world.entities!.find(e=>e.id==='lin-wan')!.state.lastSettledStoryTime as StoryTime).day,4);
    const next=await f.store.previewInput('alice',returning.session.id,'继续');const nextTime=next.worldContext!.temporal!;
    assert.equal(settlementWindow({...nextTime,settlementEligible:true},resolveStoryTime(nextTime,undefined,next.userText,next.turnId)),0);
    assert.notEqual(saved.world.entities!.find(e=>e.id===f.other)!.state.lastSettledAt,retry.input.worldContext!.temporal!.real.now);
  }finally{await f.cleanup();}
});
