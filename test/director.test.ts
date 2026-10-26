import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresFixture } from './pg-helper.ts';
import { DirectorWorker, readPreparedDirection, requestDirection, pauseDirectionForTurn } from '../server/director.ts';
import type { StoryRuntime } from '../server/runtime.ts';

function gate(){let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {resolve,promise};}
async function until(fn:()=>Promise<boolean>){for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}assert.fail('condition not reached');}
test('director coalesces repeated requests and discards an old in-flight plan without blocking chat',async()=>{
 const db=await postgresFixture({livingWorld:true});const held=gate();let calls=0;
 const runtime={status:{provider:'demo'},planNextScene:async()=>{calls++;return held.promise;}} as unknown as StoryRuntime;
 const worker=new DirectorWorker(db.store,async()=>runtime);
 try{
  const session=await db.store.createSession('alice','lin-wan');
  const commit=async(text:string)=>{const turn=await db.store.beginTurn('alice',session.session.id,text,text);await db.store.commit(turn,`林晚回应${text}。`,[],{observations:{'lin-wan':text}});await requestDirection(db.store.pool,'alice',session.world.id,turn.id);return turn;};
  const first=await commit('第一句');
  await db.store.pool.query("UPDATE world_directions SET due_at=clock_timestamp() WHERE world_id=$1",[session.world.id]);worker.start();
  await until(async()=>calls===1);
  await commit('第二句');const third=await commit('第三句');
  const rows=(await db.store.pool.query('SELECT * FROM world_directions WHERE world_id=$1',[session.world.id])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].requested_turn_id,third.id);assert.equal(rows[0].claimed_turn_id,first.id);
  held.resolve({plan:{obsolete:true}});
  await until(async()=>(await db.store.pool.query('SELECT status FROM world_directions WHERE world_id=$1',[session.world.id])).rows[0].status==='pending');
  await until(async()=>(await db.store.pool.query("SELECT count(*)::int AS n FROM world_runtime_audit WHERE world_id=$1 AND kind='director_superseded' AND data->'plan'->>'obsolete'='true'",[session.world.id])).rows[0].n>0);
  const input=await db.store.previewInput('alice',session.session.id,'继续');
  assert.equal(await readPreparedDirection(db.store.pool,'alice',input),undefined);
  assert.equal((await db.store.getTurn('alice',third.id)).status,'committed');
  const audit=await db.store.runtimeAudit('alice',session.world.id);
  assert(audit.events.some(event=>event.kind==='director_superseded'&&event.data.applied===false&&(event.data.plan as any)?.obsolete===true),'late candidate remains auditable without publishing it');
 }finally{held.resolve({plan:{}});await worker.shutdown();await db.cleanup();}
});

test('prepared advice is invalidated by world revision, scene or player identity changes',async()=>{
 const db=await postgresFixture({livingWorld:true});
 const plan={advice:'optional next beat'};
 const runtime={status:{provider:'demo'},planNextScene:async()=>({plan})} as unknown as StoryRuntime;
 const worker=new DirectorWorker(db.store,async()=>runtime);
 try{
  const session=await db.store.createSession('alice','lin-wan');
  const turn=await db.store.beginTurn('alice',session.session.id,'hello','hello');
  await db.store.commit(turn,'林晚放下书。',[],{observations:{'lin-wan':'hello'}});
  await requestDirection(db.store.pool,'alice',session.world.id,turn.id);
  await db.store.pool.query('UPDATE world_directions SET due_at=clock_timestamp() WHERE world_id=$1',[session.world.id]);
  worker.start();
  await until(async()=>(await db.store.pool.query('SELECT status FROM world_directions WHERE world_id=$1',[session.world.id])).rows[0].status==='completed');
  const input=await db.store.previewInput('alice',session.session.id,'继续');
  assert.deepEqual(await readPreparedDirection(db.store.pool,'alice',input),plan);
  const changed=structuredClone(input);changed.world.revision++;
  assert.equal(await readPreparedDirection(db.store.pool,'alice',changed),undefined);
  const sceneChanged=structuredClone(input);sceneChanged.scene!.situation='已经散场';
  assert.equal(await readPreparedDirection(db.store.pool,'alice',sceneChanged),undefined);
  const identityChanged=structuredClone(input);identityChanged.playerProfile={...input.playerProfile!,name:'另一个名字'};
  assert.equal(await readPreparedDirection(db.store.pool,'alice',identityChanged),undefined);
 }finally{await worker.shutdown();await db.cleanup();}
});

test('a Main completing during the next Actor cannot replace its frozen mainline',async()=>{
 const db=await postgresFixture({livingWorld:true});const held=gate();let called=false;
 const runtime={status:{provider:'demo'},planNextScene:async()=>{called=true;return held.promise;}} as unknown as StoryRuntime;
 const worker=new DirectorWorker(db.store,async()=>runtime);
 try{
  const s=await db.store.createSession('alice','lin-wan');
  const first=await db.store.beginTurn('alice',s.session.id,'first','去上课。');
  await db.store.commit(first,'林晚拿起书。',[],{observations:{'lin-wan':'去上课。'}});
  await requestDirection(db.store.pool,'alice',s.world.id,first.id);
  const input=await db.store.previewInput('alice',s.session.id,'');
  const plan={planType:'mainline',version:1,id:'original-route',status:'active',goal:'去上课',targetTurns:10,currentStageId:'walk',basedOnTurnId:first.id,invalidWhen:[],stages:[{id:'walk',goal:'到课堂',completionCondition:'抵达',status:'active',budgetTurns:10}]};
  await db.store.pool.query('UPDATE world_directions SET due_at=clock_timestamp(),plan=$2,guard=$3 WHERE world_id=$1',[s.world.id,plan,{focusId:'lin-wan',profile:input.playerProfile??null}]);
  const inFlight=(worker as any).step() as Promise<void>;
  await until(async()=>called);
  const next=await db.store.beginTurn('alice',s.session.id,'next','我不去上课了。');
  assert.equal((next.input.preparedScenePlan as any).id,'original-route');
  held.resolve({plan:{...plan,id:'stale-late-route'}});await inFlight;
  let row=(await db.store.pool.query('SELECT plan,status,attempt FROM world_directions WHERE world_id=$1',[s.world.id])).rows[0];
  assert.equal(row.plan.id,'original-route');assert.equal(row.status,'pending');assert.equal(row.attempt,null);
  await db.store.commit(next,'林晚收起书。',[],{observations:{'lin-wan':'我不去上课了。'}});
  await requestDirection(db.store.pool,'alice',s.world.id,next.id);
  row=(await db.store.pool.query('SELECT requested_turn_id,status FROM world_directions WHERE world_id=$1',[s.world.id])).rows[0];
  assert.equal(row.requested_turn_id,next.id);assert.equal(row.status,'pending');
 }finally{held.resolve({plan:{}});await worker.shutdown();await db.cleanup();}
});

test('the foreground claim locks pending Main advice until its running turn becomes visible',async()=>{
 const db=await postgresFixture({livingWorld:true});let calls=0;
 const runtime={status:{provider:'demo'},planNextScene:async()=>{calls++;return {plan:{advice:'next'}};}} as unknown as StoryRuntime;
 const worker=new DirectorWorker(db.store,async()=>runtime);const q=await db.store.pool.connect();
 try{
  const s=await db.store.createSession('alice','lin-wan');
  const first=await db.store.beginTurn('alice',s.session.id,'first','你好');await db.store.commit(first,'林晚点头。',[]);
  await requestDirection(db.store.pool,'alice',s.world.id,first.id);
  await db.store.pool.query('UPDATE world_directions SET due_at=clock_timestamp() WHERE world_id=$1',[s.world.id]);
  await q.query('BEGIN');
  await q.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE',[s.world.id]);
  await pauseDirectionForTurn(q,'alice',s.world.id);
  await (worker as any).step();assert.equal(calls,0);
  await q.query('ROLLBACK');
  await (worker as any).step();assert.equal(calls,1);
 }finally{await q.query('ROLLBACK');q.release();await worker.shutdown();await db.cleanup();}
});
