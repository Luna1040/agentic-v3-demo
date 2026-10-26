import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture } from './pg-helper.ts';
import type { EntityChange } from '../shared/living-world.ts';

test('a stale and a new witness learn public v3 without receiving private v2; partial writes cannot echo old descriptions over the head',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');const second=randomUUID(),third=randomUUID(),item=randomUUID();
  for(const [id,name] of [[second,'阿青'],[third,'小舟']])await f.store.pool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES('alice',$1,$2,'npc',$3,'朋友','{}',$4)",[s.world.id,id,name,[id]]);
  await f.store.setScene('alice',s.world.id,s.world.revision,{location:'客厅',presentCharacterIds:['lin-wan',second],mode:'ensemble'},s.session.id);
  const settle=async(sessionId:string,changes:EntityChange[],userText='我把钥匙放好了。')=>{
   const turn=await f.store.beginTurn('alice',sessionId,randomUUID(),userText),id=turn.input.character.id,text=`${turn.input.character.name}看向钥匙。`;
   const result={text,replies:[{characterId:id,characterName:turn.input.character.name,text}],changes:[],entityChanges:[],activities:[],usage:{},scene:turn.input.scene,observations:Object.fromEntries(turn.input.scene!.presentCharacterIds.map(id=>[id,userText]))};
   await f.store.commitDialogue(turn,result);const job=await f.store.claimSettlement();assert(job);
   await f.store.saveSettlementResult(job,{...result,entityChanges:changes});assert(await f.store.completeSettlement(job));return turn;
  };
  await settle(s.session.id,[{op:'create',entity:{id:item,kind:'item',name:'银钥匙',description:'放在桌上的钥匙。',state:{status:'桌上',history:{milestones:['首次展示']}},knownByCharacterIds:['lin-wan',second]}}]);
  const privateSession=await f.store.createSession('alice','lin-wan',s.world.id,{dynamicOpening:true,scene:{location:'客厅',presentCharacterIds:['lin-wan'],mode:'direct'}});
  await settle(privateSession.session.id,[{op:'update',baseVersion:1,witnessedByCharacterIds:['lin-wan'],entity:{id:item,kind:'item',name:'银钥匙',description:'暗格密码夜雨。',state:{status:'盒中',secretCode:'夜雨',history:{milestones:['首次展示','秘密检查'],privateNote:'暗格位于书房'}}}}]);
  const publicSession=await f.store.createSession('alice','lin-wan',s.world.id,{dynamicOpening:true,scene:{location:'客厅',presentCharacterIds:['lin-wan',second,third],mode:'ensemble'}});
  await settle(publicSession.session.id,[{op:'update',baseVersion:2,witnessedByCharacterIds:['lin-wan',second,third],entity:{id:item,kind:'item',name:'银钥匙',description:'暗格密码夜雨。',state:{status:'柜台上',secretCode:'夜雨',history:{milestones:['首次展示','秘密检查','公开放回'],privateNote:'暗格位于书房',publicNote:'摆在白托盘上'}}}}]);
  const input=await f.store.previewInput('alice',publicSession.session.id,'继续。');
  for(const id of [second,third]){
   const seen=input.worldContext!.actorInputs[id].worldContext!.entities.find(e=>e.id===item)!;
   assert(seen,'current witness has an actual stored item snapshot');assert.equal(seen.version,3);assert.equal(seen.state.status,'柜台上');
   assert(!JSON.stringify(seen).includes('夜雨'));assert(!JSON.stringify(seen).includes('暗格位于书房'));assert(!JSON.stringify(seen).includes('秘密检查'));
   assert.equal((seen.state.history as any).publicNote,'摆在白托盘上');assert((seen.state.history as any).milestones.includes('公开放回'));
  }
  const secondSession=await f.store.createSession('alice',second,s.world.id,{dynamicOpening:true,scene:{location:'客厅',presentCharacterIds:[second],mode:'direct'}});
  const secondInput=await f.store.previewInput('alice',secondSession.session.id,'移到窗台吧。');
  const ownItem=secondInput.worldContext!.entities.find(e=>e.id===item)!;
  await settle(secondSession.session.id,[{op:'update',baseVersion:3,witnessedByCharacterIds:[second],entity:{id:item,kind:'item',name:'银钥匙',description:ownItem.description,state:{status:'窗台上',history:{...(ownItem.state.history as Record<string,unknown>),milestones:[...(ownItem.state.history as any).milestones,'再次公开检查']}}}}]);
  const head=(await f.store.getWorld('alice',s.world.id)).entities!.find(e=>e.id===item)!;
  assert.equal(head.description,'暗格密码夜雨。');assert.equal(head.state.secretCode,'夜雨');assert.equal(head.state.status,'窗台上');
  assert.equal((head.state.history as any).privateNote,'暗格位于书房','a partial nested patch cannot delete unseen head keys');
  assert.deepEqual((head.state.history as any).milestones,['首次展示','秘密检查','公开放回','再次公开检查'],'unseen private milestones survive a public observer rebuilding the array');
  const next=await f.store.previewInput('alice',secondSession.session.id,'现在呢？');
  const ownNext=next.worldContext!.entities.find(e=>e.id===item)!;assert.equal(ownNext.state.status,'窗台上');assert(!JSON.stringify(ownNext).includes('夜雨'));assert(!JSON.stringify(ownNext).includes('秘密检查'));assert(!JSON.stringify(ownNext).includes('暗格位于书房'));
 }finally{await f.cleanup();}
});

test('same-title promises remain separate by owner, including the player; duplicate promise for the same owner is rejected',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan');const other=randomUUID();
  await f.store.pool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES('alice',$1,$2,'npc','阿青','朋友','{}',$3)",[s.world.id,other,[other]]);
  await f.store.setScene('alice',s.world.id,s.world.revision,{location:'客厅',presentCharacterIds:['lin-wan',other],mode:'ensemble'},s.session.id);
  const turn=await f.store.beginTurn('alice',s.session.id,'promises','明天下午三点一起看电影。'),text='林晚和阿青分别答应明天下午三点见面。';
  const result={text,replies:[{characterId:'lin-wan',characterName:'林晚',text}],changes:[],entityChanges:[],activities:[],usage:{},scene:turn.input.scene,observations:{'lin-wan':turn.input.userText,[other]:turn.input.userText}};
  await f.store.commitDialogue(turn,result);const job=await f.store.claimSettlement();assert(job);
  const create=(owner:string):EntityChange=>({op:'create',entity:{id:randomUUID(),kind:'quest',name:'明天三点看电影',description:'各自承担到场责任。',state:{status:'proposed',ownerCharacterId:owner},knownByCharacterIds:['lin-wan',other]}});
  const changes=['lin-wan',other,'$player'].map(create);await f.store.saveSettlementResult(job,{...result,entityChanges:changes});assert(await f.store.completeSettlement(job));
  const world=await f.store.getWorld('alice',s.world.id);assert.equal(world.entities!.filter(e=>e.kind==='quest'&&e.name==='明天三点看电影').length,3);
  const next=await f.store.beginTurn('alice',s.session.id,'duplicate-promise','还是明天三点。');
  await f.store.commitDialogue(next,{...result,observations:{'lin-wan':next.input.userText,[other]:next.input.userText}});
  const nextJob=await f.store.claimSettlement();assert(nextJob);await f.store.saveSettlementResult(nextJob,{...nextJob.dialogue,entityChanges:[create(other)]});
  await assert.rejects(f.store.completeSettlement(nextJob),{code:'ENTITY_NAME_CONFLICT'});
  assert.equal((await f.store.getWorld('alice',s.world.id)).entities!.filter(e=>e.kind==='quest').length,3,'duplicate failure rolls back without merging owners');
 }finally{await f.cleanup();}
});
