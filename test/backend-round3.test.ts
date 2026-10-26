import test from 'node:test';
import assert from 'node:assert/strict';
import {postgresFixture} from './pg-helper.ts';
test('PG stores final departure separately from heard goodbye and next request uses the correct absence clock',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const start=await f.store.createSession('alice','lin-wan',undefined,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:['lin-wan'],mode:'ensemble',playerPresent:true}});
  const raw='现在下午四点半，我来到阅览室。';
  const turn=await f.store.beginTurn('alice',start.session.id,'arrive',raw);
  const first=await f.store.commit(turn,'林晚点了点头。',[],{observations:{'lin-wan':raw}});
  assert.equal(first.world.storyTime?.minute,990,'host derives explicit time without any model proposal');
  const elapsed='十分钟后，前两圈下来，我的腿有点发沉。';
  const running=await f.store.beginTurn('alice',start.session.id,'elapsed',elapsed);
  const advanced=await f.store.commit(running,'两圈完成，还有八圈。',[],{observations:{'lin-wan':elapsed}});
  assert.equal(advanced.world.storyTime?.minute,1000,'actual short-test wording persists all ten minutes');
  const leave='我从她让开的门边出去，朝教室走去。';
  const next=await f.store.beginTurn('alice',start.session.id,'leave',leave);
  const saved=await f.store.commit(next,'林晚挥手道别，关上了门。',[],{observations:{'lin-wan':leave}});
  assert.equal(saved.world.scene?.playerPresent,false);
  const episode=saved.world.episodes!.find(e=>e.turnId===next.id)!;
  assert.equal(episode.scene.playerPresent,true);assert.equal(episode.observations!['lin-wan'],leave);
  const subsequent=await f.peer().previewInput('alice',start.session.id,'我回来了。');
  assert.equal(subsequent.scene?.playerPresent,false);
  assert.equal(subsequent.worldContext?.temporal?.offlineEligible,true);
 }finally{await f.cleanup();}
});
