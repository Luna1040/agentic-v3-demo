import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const moduleAt=(name:string)=>import(pathToFileURL(resolve(process.env.HARNESS_ROOT||'../../roleplay-harness',`dist/apps/agentic-v3/${name}.js`)).href);
const entity=(id:string,kind:string,name:string,state:Record<string,unknown>={})=>({id,kind,name,state,description:'',knownByCharacterIds:['a'],sourceTurnId:'old',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});

test('unsupported precise NPC reporting is qualified while dialogue, valid clocks and future terms stay intact',async()=>{
 const {qualifyClockClaims}=await moduleAt('clock-claims');
 const story={day:1,minute:990,precision:'minute',source:{kind:'setup'}};
 const raw='阿梅莉记为四点三十三分到场、换鞋利索';
 assert.equal(qualifyClockClaims(raw,story).text,'阿梅莉记为四点三十三分〔未核实报时〕到场、换鞋利索');
 for(const raw of ['现在下午四点半到场。','明天六点半到场。','昨日四点三十三分到场。','时间未知'])assert.equal(qualifyClockClaims(raw,story).text,raw);
 assert.equal(qualifyClockClaims(qualifyClockClaims(raw,story).text,story).text,qualifyClockClaims(raw,story).text);
});
function input(quest=false):any{return {turnId:'turn',character:{id:'a',name:'阿梅莉',description:'',greeting:''},history:[],userText:'我接受训练。',world:{id:'w',revision:2,events:[]},scene:{location:'教师休息室',presentCharacterIds:['a'],mode:'ensemble',playerPresent:true},worldContext:{clock:{},actorInputs:{},entities:[entity('a','npc','阿梅莉'),entity('room','location','教师休息室'),entity('item','item','烟盒',{status:'桌上',locationId:'room'}),...(quest?[entity('q','quest','五千米训练',{status:'active',progression:{phase:'今日已完成',completedMilestones:['昨日完成五千米'],nextStep:null}})]:[]) ]}};}
async function fixture(quest=false,appointment=false){const x=input(quest),replies=[{characterId:'a',characterName:'阿梅莉',text:'她把变形的烟盒塞进办公桌最底层的抽屉，关上了抽屉。'+(appointment?'\n\n“明天早上六点半，来田径场训练。”':'')}];
 const {opsSources}=await moduleAt('ops-sources');const sources=opsSources(x,replies,[],{a:x.userText});
 const raw:any={contractVersion:2,
  followUpReviews:[appointment?{characterId:'a',decision:quest?'already_current':'applied',pendingResponsibility:{ownerId:quest?'$player':'a',description:'明早六点半的训练安排尚待兑现'},executionEvidence:'none',...(quest?{questId:'q'}:{}),evidenceId:sources.segments[1].id,reason:quest?'已有未完成训练事项；本轮新时刻须另由appointmentReviews与任务命令审查':'提出新的晨跑安排，引用本轮任务创建命令'}:{characterId:'a',decision:'none',pendingResponsibility:null,executionEvidence:'observed_action',evidenceId:sources.segments[0].id,reason:'本轮只完成烟盒收纳，没有后续承诺或待办'}],
  itemTransferReviews:[{evidenceId:sources.segments[0].id,decision:'applied',reason:'物品已收纳'}],appointmentReviews:appointment?[{evidenceId:sources.segments[1].id,decision:'applied',reason:'新训练时刻须有同源任务命令'}]:[],characterUpdates:[{characterId:'a',summary:'烟盒锁入抽屉。'+(appointment?'并提出明早训练安排。':''),evidenceId:sources.segments[0].id}],itemReviews:[{id:'item',decision:'revised',state:{status:'锁在办公桌抽屉内',locationId:'room'},evidenceId:sources.segments[0].id}],discoveries:[],questReviews:quest?[{id:'q',decision:'unchanged'}]:[],actorLocations:[]};
 return {x,replies,sources,raw,validate:(await moduleAt('world-ops')).validateReviewedOps};}
test('one current reply updates the item, creates a new appointment and refreshes own summary through typed commands',async()=>{
 const f=await fixture(false,true);f.raw.discoveries=[{kind:'quest',key:'morning',name:'晨跑',description:'次日六点半集合',status:'proposed',ownerCharacterId:'a',storyDue:{day:2,minute:390,precision:'minute'},nextStep:'赴约',evidenceId:f.sources.segments[1].id}];
 const result=f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true);
 assert.equal(result.entityChanges.length,3);assert.equal(result.entityChanges.find((e:any)=>e.entity.id==='item').entity.state.status,'锁在办公桌抽屉内');
 assert(result.entityChanges.some((e:any)=>e.entity.kind==='quest'&&e.entity.state.storyDue.minute===390));
 assert.equal(result.entityChanges.find((e:any)=>e.entity.id==='a').arcSource.source,'actor');
});
test('missing item/summary/discovery coverage and read-only write confusion fail before committing a successful turn',async()=>{
 for(const mutate of [(x:any)=>x.itemReviews=[],(x:any)=>delete x.characterUpdates,(x:any)=>delete x.discoveries,(x:any)=>x.characterUpdates[0].characterView='wrong field']){
   const f=await fixture();mutate(f.raw);assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true));
 }
});
test('future appointment revision preserves completed history without pretending another milestone completed',async()=>{
 const f=await fixture(true,true);f.raw.followUpReviews=[{characterId:'a',decision:'applied',pendingResponsibility:{ownerId:'$player',description:'明早六点半赴约训练'},executionEvidence:'none',evidenceId:f.sources.segments[1].id,reason:'以同源terms命令记录既有训练事项的新时刻'}];f.raw.questReviews=[{id:'q',decision:'terms',storyDue:{day:2,minute:390,precision:'minute'},nextStep:'明早六点半赴约',evidenceId:f.sources.segments[1].id}];
 const result=f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true);
 const q=result.entityChanges.find((e:any)=>e.entity.id==='q').entity.state;
 assert.equal(q.storyDue.minute,390);assert.deepEqual(q.progression.completedMilestones,['昨日完成五千米']);assert.equal(q.status,'active');
 f.raw.questReviews[0].addMilestones=['明早训练完成'];assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true));
});
test('invalid candidate cannot disappear into a successful no-op after strict contract expansion',async()=>{
 const f=await fixture();f.raw.itemReviews[0].state.locationId='foreign-place';
 assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true),/validation incomplete/);
});

test('a new transfer cannot disappear into summary-only output; later negation does not hide the action',async()=>{
 const {itemTransferSignals}=await moduleAt('appointment-signals');
 assert.deepEqual(itemTransferSignals([{id:'e1',source:'actor',text:'她将烟盒扫进口袋。她没有坐下，只扶着椅背。'}]),['e1']);
 const f=await fixture();delete f.raw.itemTransferReviews;f.raw.itemReviews[0]={id:'item',decision:'unchanged',reason:'漏了动作'};
 assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true),/current item transfers/);
});

test('authorized player paper and backpack placements are review signals even when the Actor does not repeat them',async()=>{
 const {itemTransferSignals}=await moduleAt('appointment-signals');
 for(const text of ['我从书包里抽出那几张卷子，放到她指的空桌上，用镇纸压好。','我把书包放到她指的长椅上，又蹲下来把鞋带系紧。'])
  assert.deepEqual(itemTransferSignals([{id:'u',source:'user',text}]),['u']);
 for(const text of ['“我把卷子放到桌上。”','我准备把书包放到椅子上。','我想象自己把书包放到椅子上。'])assert.deepEqual(itemTransferSignals([{id:'u',source:'user',text}]),[]);
});

test('two witnessed steps of the same item can explicitly cite one final-state command, never a missing command',async()=>{
 const f=await fixture();f.x.userText='我把烟盒放到桌上。';
 const sources=(await moduleAt('ops-sources')).opsSources(f.x,f.replies,[],{a:f.x.userText});
 f.raw.itemTransferReviews.push({evidenceId:sources.segments.find((s:any)=>s.source==='user').id,decision:'applied',itemEvidenceId:sources.segments[0].id,reason:'玩家放桌上后阿梅莉已收进抽屉；只写最终状态'});
 assert(f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true).entityChanges.length>0);
 f.raw.itemTransferReviews[1].itemEvidenceId=sources.segments[1].id;
 assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true),/without a sourced/);
});

test('redundant current-location proposal does not require fabricating an arrival or fail valid writes',async()=>{
 const f=await fixture();f.raw.actorLocations=[{characterId:'a',locationId:'room',evidence:{source:'actor',characterId:'a',quote:'她在教师休息室……'}}];
 const result=f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true);
 assert.deepEqual(result.actorLocations,[]);assert(!result.issues.some((s:string)=>s.includes('no-op')),'same-place no-op must not trigger a paid arbiter');
 assert.equal(result.entityChanges.length,2);
});

test('future-time source signals cannot be silently skipped or claim a nonexistent quest write',async()=>{
 const f=await fixture(true,true);delete f.raw.appointmentReviews;
 assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true),/appointment signals/);
 f.raw.appointmentReviews=[{evidenceId:f.sources.segments[1].id,decision:'applied',reason:'已安排晨跑'}];
 assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true),/without a sourced/);
 f.raw.appointmentReviews=[{evidenceId:f.sources.segments[1].id,decision:'already_current',questId:'q',reason:'已经有过训练所以不用记'}];
 assert.throws(()=>f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true),/not present/);
});

test('one quest can receive independently evidenced progress and future terms without erasing either',async()=>{
 for(const reverse of [false,true]){
  const f=await fixture(true,true);f.x.userText='我跑完五千米。';
  const sources=(await moduleAt('ops-sources')).opsSources(f.x,f.replies,[],{a:f.x.userText});
  f.raw.questReviews=[{id:'q',decision:'progress',phase:'今日完成',addMilestones:['今日跑完五千米'],nextStep:null,status:'active',result:'完成今日训练',evidenceId:sources.segments.find((s:any)=>s.source==='user').id},
   {id:'q',decision:'terms',description:'明早六点半继续训练',storyDue:{day:2,minute:390,precision:'minute'},nextStep:'明早赴约',evidenceId:sources.segments[1].id}];
  if(reverse)f.raw.questReviews.reverse();
  f.raw.appointmentReviews[0].decision='applied';
  f.raw.followUpReviews=[{characterId:'a',decision:'applied',pendingResponsibility:{ownerId:'$player',description:'明早六点半继续训练'},executionEvidence:'none',evidenceId:sources.segments[1].id,reason:'本人提出新训练时刻，由同源terms命令落档；玩家完成进度另用玩家证据'}];
  const result=f.validate(f.raw,f.x,f.replies,[],[],{a:f.x.userText},true),qs=result.entityChanges.filter((e:any)=>e.entity.id==='q');
  assert.equal(qs.length,1);assert.equal(qs[0].entity.description,'明早六点半继续训练');
  assert.equal(qs[0].entity.state.storyDue.minute,390);
  assert.deepEqual(qs[0].entity.state.progression.completedMilestones,['昨日完成五千米','今日跑完五千米']);
  assert.equal(qs[0].entity.state.progression.nextStep,'明早赴约');assert.equal(qs[0].entity.state.result,'完成今日训练');
 }
});

test('accepting a future task is a current speech act, but cannot complete its promised work',async()=>{
 const {isAcceptanceProgress}=await moduleAt('acceptance');
 assert.equal(isAcceptanceProgress('“我能做到。十圈我会跑完。”','proposed','active',['学生当场承诺接受十圈条件']),true);
 assert.equal(isAcceptanceProgress('“我能做到。十圈我会跑完。”','proposed','completed',['学生已跑完十圈']),false);
 assert.equal(isAcceptanceProgress('我心想我能做到。','proposed','active',['学生承诺接受条件']),false);
});
