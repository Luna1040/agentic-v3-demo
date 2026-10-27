import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {postgresFixture} from './pg-helper.ts';
import {sceneCutRequested} from '../shared/scene-cut.ts';
import type {WorldTurnResult} from '../server/runtime.ts';

const harnessRoot=process.env.HARNESS_ROOT || resolve(process.cwd(),'../../roleplay-harness');
const reducer=await import(pathToFileURL(resolve(harnessRoot,'dist/apps/agentic-v3/event-reducer.js')).href);
const sources=await import(pathToFileURL(resolve(harnessRoot,'dist/apps/agentic-v3/ops-sources.js')).href);

for(const state of ['latest','manual','newer'] as const)test(`classroom-to-café scene cut after a backlog: ${state}`,async()=>{
  const f=await postgresFixture({livingWorld:true});
  try {
    const s=await f.store.createSession('alice','lin-wan',undefined,{scene:{location:'阶梯教室',presentCharacterIds:['lin-wan'],mode:'ensemble',playerPresent:true}});
    const send=async(raw:string,text:string)=>{
      const turn=await f.store.beginTurn('alice',s.session.id,randomUUID(),raw);
      const result:WorldTurnResult={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},attributedEvidence:[],observations:{'lin-wan':raw}};
      await f.store.commitDialogue(turn,result);return turn;
    };
    await send('先上课。','林晚翻开课本。');
    const turn=await send('快进到那天','咖啡馆里，弥漫着肉桂的暖香。\n\n靠窗的木桌旁，林晚早已坐在那里。');
    const before=(await f.store.getWorld('alice',s.world.id)).storyTime;
    const first=await f.store.claimSettlement();assert(first);await f.store.saveSettlementResult(first,first.dialogue);assert(await f.store.completeSettlement(first));
    if(state==='manual'){
      const world=await f.store.getWorld('alice',s.world.id);
      await f.store.setScene('alice',s.world.id,world.revision,world.scene!);
    }
    if(state==='newer')await send('我们先回教室。','林晚回到阶梯教室。');
    const job=await f.store.claimSettlement();assert(job);assert.equal(job.turnId,turn.id);
    const evidence=sources.opsSources(job.input,job.dialogue.replies,[],job.dialogue.observations);
    const place=evidence.segments.find((s:any)=>s.source==='actor'&&s.text.includes('咖啡馆'));
    const presence=evidence.segments.find((s:any)=>s.source==='actor'&&s.text.includes('林晚'));
    const reduced=reducer.reduceEventOps({contractVersion:3,commands:[{id:'discover-place',type:'discovery',kind:'location',key:'cafe',name:'咖啡馆',description:'当前场所',evidenceId:place.id,evidenceKind:'actual_action'}],sceneContext:{decision:'confirmed',name:'咖啡馆',evidenceId:place.id,presenceEvidenceId:presence.id}},job.input,job.dialogue.replies,[],[],job.dialogue.observations);
    assert.equal(reduced.scene?.location,'咖啡馆');assert.deepEqual(reduced.deferredCommands,[]);
    await f.store.saveSettlementResult(job,{...job.dialogue,...reduced});assert(await f.store.completeSettlement(job));
    const after=await f.store.getWorld('alice',s.world.id);
    assert.equal(after.scene?.location,state==='latest'?'咖啡馆':'阶梯教室');
    assert.deepEqual(after.storyTime,before);assert.equal(after.eventLedger?.length,0);
    const actor=after.entities!.find(e=>e.id==='lin-wan')!,cafe=after.entities!.find(e=>e.kind==='location'&&e.name==='咖啡馆')!;
    assert(cafe);assert.equal(actor.state.locationId===cafe.id,state==='latest');
  }finally{await f.cleanup();}
});

test('host and runtime use the same bounded scene-cut request rule',()=>{
  assert(sceneCutRequested('快进到那天'));
  for(const raw of ['继续。','如果能快进到那天。','不要快进到那天。','“快进到那天。”'])assert(!sceneCutRequested(raw));
});
