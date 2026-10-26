import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';
import { createApp } from '../server/app.ts';
import type { StoryRuntime } from '../server/runtime.ts';
import { createApiClient } from '../web/api.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PlayerProfiles } from '../web/PlayerProfiles.tsx';
test('player profiles persist, isolate owners, freeze per world/turn and reject switching during a turn',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const a=await f.store.savePlayerProfile('alice',null,{name:'周宁',persona:'修表店店员。秘密：担心失业。'});
  const b=await f.store.savePlayerProfile('alice',null,{name:'林舟',persona:'旅行者。'});
  assert.equal((await f.peer().listPlayerProfiles('alice')).length,2);
  assert.equal((await f.store.listPlayerProfiles('bob')).length,0);
  await assert.rejects(f.store.savePlayerProfile('bob',a.id,{name:'越权',persona:'',expectedVersion:1}),{code:'PROFILE_NOT_FOUND'});
  const s=await f.store.createSession('alice','lin-wan',undefined,{dynamicOpening:true,playerProfileId:a.id});
  assert.equal(s.world.playerProfile?.name,'周宁');
  await assert.rejects(f.store.createSession('bob','lin-wan',undefined,{playerProfileId:a.id}),{code:'PROFILE_NOT_FOUND'});
  const a2=await f.store.savePlayerProfile('alice',a.id,{name:'周宁新',persona:'另一版本',expectedVersion:1});
  await assert.rejects(f.store.savePlayerProfile('alice',a.id,{name:'覆盖',persona:'',expectedVersion:1}),{code:'PROFILE_CHANGED'});
  assert.equal((await f.store.getWorld('alice',s.world.id)).playerProfile?.name,'周宁');
  const preview=await f.store.previewInput('alice',s.session.id,'你好');
  assert.deepEqual(preview.playerProfile,a);assert.deepEqual(preview.worldContext!.actorInputs['lin-wan'].playerProfile,a);
  const t=await f.store.beginTurn('alice',s.session.id,'test-persona','你好',{});
  assert.equal((await f.store.getTurn('alice',t.id)).userMessage.playerName,'周宁');
  await assert.rejects(f.store.setPlayerProfile('alice',s.world.id,b.id,s.world.revision),{code:'WORLD_BUSY'});
  await f.store.commit(t,'林晚点头。',[],{observations:{'lin-wan':'你好'}});
  const w=await f.store.getWorld('alice',s.world.id);
  await assert.rejects(f.store.setPlayerProfile('alice',w.id,b.id,w.revision-1),{code:'WORLD_CHANGED'});
  await f.store.setPlayerProfile('alice',w.id,b.id,w.revision);
  assert.equal(t.input.playerProfile?.name,'周宁');
  assert.equal((await f.store.previewInput('alice',s.session.id,'继续')).playerProfile?.name,'林舟');
  const oldEpisode=(await readPastDialogue(f.store,'alice',s.session.id,'lin-wan',[t.id])).find(episode=>episode.turnId===t.id)!;
  assert.equal(oldEpisode.playerName,'周宁');assert.equal(oldEpisode.userText,'你好');
  assert.equal((await f.store.getWorld('alice',w.id)).episodes!.find(episode=>episode.turnId===t.id)!.playerName,'周宁');
  assert.equal((await f.store.getTurn('alice',t.id)).userMessage.playerName,'周宁');
  const next=await f.store.createSession('alice','lin-wan',w.id,{dynamicOpening:true});
  assert.equal(next.world.playerProfile?.name,'林舟');
  await f.store.deletePlayerProfile('alice',b.id,b.version);
  assert.equal((await f.store.getWorld('alice',w.id)).playerProfile?.name,'林舟');
  assert.equal(a2.version,2);
 }finally{await f.cleanup()}
});
test('profile HTTP routes enforce ownership, versions and roundtrip via official frontend client',async()=>{
 const f=await postgresFixture({livingWorld:true});
 const runtime={status:{provider:'demo',model:'test',harness:{loaded:true,version:'test'},offlineSimulation:false}} as StoryRuntime;
 const app=createApp({store:f.store,runtime,authenticate:req=>req.get('x-owner')||'alice'});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+(server.address() as any).port+'/api';
 const client=createApiClient({baseUrl:base});
 try{
  const a=await client.savePlayerProfile(null,{name:'玩家甲',persona:'普通旅人'});
  assert.equal((await client.playerProfiles()).profiles[0].id,a.id);
  const bob=createApiClient({baseUrl:base,getHeaders:()=>({'x-owner':'bob'})});
  await assert.rejects(bob.savePlayerProfile(a.id,{name:'越权',persona:'',expectedVersion:1}),{code:'PROFILE_NOT_FOUND'});
  await assert.rejects(client.savePlayerProfile(null,{name:' ',persona:''}),{code:'PROFILE_INVALID'});
  await assert.rejects(client.savePlayerProfile(null,{name:'a',persona:'x'.repeat(3001)}),{code:'PROFILE_INVALID'});
  for(const value of [{name:'坏\0名',persona:''},{name:'姓名',persona:'坏\ud800文'},{name:'\ud800',persona:'\udc00'}])
   await assert.rejects(client.savePlayerProfile(null,value),{code:'PROFILE_INVALID',status:422});
  for(const expectedVersion of [0,-1,1.5,2147483648,Number.MAX_SAFE_INTEGER]){
   await assert.rejects(client.savePlayerProfile(a.id,{name:'a',persona:'',expectedVersion}),{code:'PROFILE_INVALID',status:422});
   await assert.rejects(client.deletePlayerProfile(a.id,expectedVersion),error=>(error as any).status===422);
  }
  await client.deletePlayerProfile(a.id,1);assert.equal((await client.playerProfiles()).profiles.length,0);
  const html=renderToStaticMarkup(createElement(PlayerProfiles,{client,busy:false,onApplied:async()=>{}}));
  assert.match(html,/玩家姓名/);assert.match(html,/Persona/);assert.match(html,/新建身份/);
 }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await f.cleanup()}
});

test('concurrent profile creates respect the library limit and updates use compare-and-swap',async()=>{
 const f=await postgresFixture();
 try{
  const peer=f.peer();
  const created=await Promise.allSettled(Array.from({length:32},(_,i)=>(i%2?peer:f.store).savePlayerProfile('alice',null,{name:`身份${i}`,persona:''})));
  assert.equal(created.filter(result=>result.status==='fulfilled').length,30);
  assert.equal((await f.store.listPlayerProfiles('alice')).length,30);
  for(const result of created) if(result.status==='rejected') assert.equal(result.reason.code,'PROFILE_LIMIT');
  const a=(await f.store.listPlayerProfiles('alice'))[0];
  const updates=await Promise.allSettled([f.store,peer].map((store,i)=>store.savePlayerProfile('alice',a.id,{name:`改名${i}`,persona:'',expectedVersion:a.version})));
  assert.equal(updates.filter(result=>result.status==='fulfilled').length,1);
  for(const result of updates) if(result.status==='rejected') assert.equal(result.reason.code,'PROFILE_CHANGED');
  await assert.rejects(f.store.deletePlayerProfile('alice',a.id,a.version),{code:'PROFILE_CHANGED'});
  await f.store.savePlayerProfile('bob',null,{name:'独立额度',persona:''});
 }finally{await f.cleanup()}
});

test('world identity switching isolates owners, serializes revisions and prevents retry under a new identity',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const a=await f.store.savePlayerProfile('alice',null,{name:'甲',persona:'原设定'});
  const b=await f.store.savePlayerProfile('alice',null,{name:'乙',persona:'新设定'});
  const bob=await f.store.savePlayerProfile('bob',null,{name:'他人',persona:''});
  const s=await f.store.createSession('alice','lin-wan',undefined,{dynamicOpening:true,playerProfileId:a.id});
  await assert.rejects(f.store.createSession('alice','lin-wan',undefined,{playerProfileId:''}),{code:'PROFILE_INVALID'});
  await assert.rejects(f.store.createSession('alice','lin-wan',s.world.id,{playerProfileId:b.id}),{code:'PROFILE_WORLD_SCOPE'});
  await assert.rejects(f.store.setPlayerProfile('bob',s.world.id,bob.id,s.world.revision),{code:'WORLD_NOT_FOUND'});
  await assert.rejects(f.store.setPlayerProfile('alice',s.world.id,bob.id,s.world.revision),{code:'PROFILE_NOT_FOUND'});
  const t=await f.store.beginTurn('alice',s.session.id,'retry-profile','原话',{});
  await f.store.finish(t,'failed','TEST_FAILURE','测试失败');
  const retry=await f.store.beginTurn('alice',s.session.id,'retry-profile','原话',{});
  assert.equal(retry.input.playerProfile?.name,'甲');
  await f.store.finish(retry,'failed','TEST_FAILURE','测试失败');
  const changes=await Promise.allSettled([f.store.setPlayerProfile('alice',s.world.id,b.id,s.world.revision),f.peer().setPlayerProfile('alice',s.world.id,null,s.world.revision)]);
  assert.equal(changes.filter(result=>result.status==='fulfilled').length,1);
  for(const result of changes) if(result.status==='rejected') assert.equal(result.reason.code,'WORLD_CHANGED');
  await assert.rejects(f.store.beginTurn('alice',s.session.id,'retry-profile','原话',{}),{code:'WORLD_CHANGED'});
  const current=await f.store.getWorld('alice',s.world.id);
  const cleared=await f.store.setPlayerProfile('alice',s.world.id,null,current.revision);
  assert.equal(cleared.playerProfile,null);
  assert.equal((await f.store.previewInput('alice',s.session.id,'新话')).playerProfile,undefined);
  assert.equal((await f.store.getTurn('alice',t.id)).userMessage.playerName,'甲');
 }finally{await f.cleanup()}
});
