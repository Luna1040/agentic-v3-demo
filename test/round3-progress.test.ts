import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const load=(name:string)=>import(pathToFileURL(resolve(process.env.HARNESS_ROOT||'../../roleplay-harness',`dist/apps/agentic-v3/${name}.js`)).href);
test('mixed feeling sentence does not erase observable completed laps, and never falls back to full text',async()=>{
 const {preserveCompletedActions}=await load('progress-observation');
 const raw='我起步时刻意收着，没有急着追速度。前两圈下来，腿虽然酸，呼吸倒比昨天稳些。我经过她身边时点了点头。';
 const result=preserveCompletedActions(raw,['我起步时刻意收着，没有急着追速度。','我经过她身边时点了点头。'],'a');
 assert.deepEqual(result.recovered,['前两圈下来']);assert(JSON.stringify(result.observation).includes('前两圈下来'));
 assert(!JSON.stringify(result.observation).includes('腿虽然酸'));
});
test('protected progress cannot recover thought, fantasy, denied or offstage activity',async()=>{
 const {preserveCompletedActions}=await load('progress-observation');
 for(const raw of ['我心里想着我跑完了两圈。','我没有跑完两圈。','我离开她的视线，完成了训练。','我偷偷跑完了两圈。','“我跑完两圈。”'])assert.deepEqual(preserveCompletedActions(raw,'','a').recovered,[],raw);
});
test('direction is an enum plus a world-local anchor, and cannot carry private narration',async()=>{
 const {validateScenePlan}=await load('world-validation');
 const x:any={turnId:'t',character:{id:'a'},userText:'我抬起头，心里担心那封信。',scene:{location:'门廊',presentCharacterIds:['a'],mode:'ensemble',playerPresent:true},world:{id:'w'},worldContext:{entities:[{id:'a',name:'甲',kind:'npc',state:{},knownByCharacterIds:['a']}],actorInputs:{}}};
 const raw={scene:x.scene,speakers:['a'],entities:[],observations:{a:['我抬起头']},direction:{kind:'offer_next_step',anchorId:'a'}};
 const plan=validateScenePlan(raw,x);assert.equal(plan.direction.kind,'offer_next_step');assert(!plan.scene.situation.includes('信'));
 const flat=validateScenePlan({...raw,direction:'offer_next_step',directionAnchorId:'a'},x);assert.deepEqual(flat.direction,plan.direction);
 assert.throws(()=>validateScenePlan({...raw,direction:{...raw.direction,privateText:'秘密'}},x));
 assert.throws(()=>validateScenePlan({...raw,direction:{kind:'new_encounter',anchorId:'a'}},x),/锚点必须指向本轮登记的新 NPC/);
});
