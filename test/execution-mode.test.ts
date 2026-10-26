import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnService } from '../server/turn-service.ts';
import type { StoryRuntime } from '../server/runtime.ts';
import type { TurnEvent } from '../shared/contracts.ts';
import { postgresFixture } from './pg-helper.ts';

test('an incomplete production adapter terminates the persisted turn without calling a model',async()=>{
  const fixture=await postgresFixture({livingWorld:true});
  let called=false;
  const runtime:StoryRuntime={
    status:{provider:'demo',model:'fixture',harness:{loaded:true,version:'test'},offlineSimulation:true},
    actor:async()=>{throw new Error('unexpected actor');},updateWorld:async()=>{throw new Error('unexpected updater');},
    streamDialogue:async()=>{called=true;throw new Error('unexpected scene');},
  };
  const service=new TurnService(fixture.store,runtime);
  try{
    const session=await fixture.store.createSession('alice','lin-wan');
    const turn=await fixture.store.beginTurn('alice',session.session.id,'adapter-missing','你好');
    const events:TurnEvent[]=[];
    await service.run(turn,event=>events.push(event));
    assert.equal(called,false);
    assert.equal(events.at(-1)?.type,'failed');
    assert.equal((await fixture.store.getTurn('alice',turn.id)).error?.code,'WORLD_RUNTIME_UNAVAILABLE');
  }finally{await service.shutdown();await fixture.cleanup();}
});

test('provider timeout keeps its cause visible and never marks the missing response as saved',async()=>{
 const fixture=await postgresFixture({livingWorld:true});
 const runtime:StoryRuntime={status:{provider:'demo',model:'fixture',harness:{loaded:true,version:'test'},offlineSimulation:true},actor:async()=>{throw Error('unused');},updateWorld:async()=>{throw Error('unused');},settleWorldTurn:async()=>{throw Error('unused');},streamDialogue:async()=>{throw Object.assign(Error('provider timed out'),{code:'PROVIDER_TIMEOUT'});}};
 const service=new TurnService(fixture.store,runtime);
 try{
  const s=await fixture.store.createSession('alice','lin-wan');const turn=await fixture.store.beginTurn('alice',s.session.id,'timeout','我最近很不开心');
  const events:TurnEvent[]=[];await service.run(turn,e=>events.push(e));
  const saved=await fixture.store.getTurn('alice',turn.id);
  assert.equal(saved.error?.code,'PROVIDER_TIMEOUT');assert.match(saved.error!.message,/模型响应超时/);
  assert.equal(saved.assistantMessages?.length??0,0);assert.equal(events.at(-1)?.type,'failed');
 }finally{await service.shutdown();await fixture.cleanup();}
});
