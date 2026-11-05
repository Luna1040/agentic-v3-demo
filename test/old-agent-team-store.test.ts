import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {postgresFixture} from './pg-helper.ts';
import {loadRuntime} from '../server/load-runtime.ts';
import {oldAgentPolicies} from '../server/legacy-agents.ts';

const stream=(delta:unknown,finish='stop')=>new Response(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
const task=(id:string,agent:string,characterId:string)=>({id,agent,scope:({character_actor:'actor',delivery_formatter:'delivery',location_generator:'location',teacher_worldops:'memory'} as Record<string,string>)[agent],characterId,focus:'核对本轮证据',dependsOn:[]});

test('Main-dispatched location and memory candidates commit atomically and are visible on the next real PostgreSQL turn',async t=>{
 const f=await postgresFixture({livingWorld:true});let actors=0;
 t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
   const body=JSON.parse(String(init.body)),content=body.messages.at(-1).content,payload=JSON.parse(typeof content==='string'?content:content.map((p:any)=>p.text??'').join(''));
   if(payload.task==='old_agent_dispatch'){
     const tasks=payload.phase==='foreground'?[task('actor','character_actor',payload.focusId),task('delivery','delivery_formatter',payload.focusId)]:[task('place','location_generator',payload.focusId),task('memory','teacher_worldops',payload.focusId),{...task('wiki','wiki_summarizer',payload.focusId),scope:'wiki'}];
     return stream({tool_calls:[{index:0,id:'dispatch',type:'function',function:{name:'dispatch_agents',arguments:JSON.stringify({tasks})}}]},'tool_calls');
   }
   if(payload.task==='scene_locator')return stream({content:JSON.stringify({decision:'new',placeId:null,newPlaceName:'便利店',evidenceQuote:'林晚已经在便利店里',confidence:0.95})});
   if(payload.task==='old_agent'){
     const evidence=payload.sourceSegments.find((s:any)=>s.source==='actor');assert(evidence);
     if(payload.agentKey==='wiki_summarizer')return stream({tool_calls:[{index:0,id:'result',type:'function',function:{name:'submit_agent_result',arguments:JSON.stringify({advice:'林晚来到便利店，拿起了一瓶水。',commands:[],rejectedCommandIds:[]})}}]},'tool_calls');
     const output=payload.agentKey==='location_generator'?{advice:'当前位置已确认',commands:[{id:'place',type:'discovery',kind:'location',key:'convenience',name:'便利店',description:'本轮实际进入的场所',evidenceId:evidence.id}],rejectedCommandIds:[],sceneContext:{decision:'confirmed',name:'便利店',evidenceId:evidence.id}}:{advice:'本轮滚动记忆',commands:[{id:'memory',type:'memory',characterId:payload.characterId,summary:'林晚已经进入便利店，拿起一瓶水。',evidenceId:evidence.id}],rejectedCommandIds:[]};
     return stream({tool_calls:[{index:0,id:'result',type:'function',function:{name:'submit_agent_result',arguments:JSON.stringify(output)}}]},'tool_calls');
   }
   actors++;return stream({content:'林晚已经在便利店里，拿起一瓶水。'});
 });
 try{
   const runtime=await loadRuntime({oldAgents:{enabled:true}});assert.equal(runtime.metadata?.oldAgentTeamEnabled,true);assert.equal(runtime.settleWorldBatch,undefined);
   const session=await f.store.createSession('alice','lin-wan');
   const turn=await f.store.beginTurn('alice',session.session.id,randomUUID(),'我们进去买水吧。',runtime.metadata);
   const dialogue=await runtime.streamDialogue!(turn.input,{attemptId:turn.attempt,signal:new AbortController().signal,onTextDelta:()=>{},onCall:record=>f.store.saveCall(turn,record),onCheckpoint:checkpoint=>f.store.saveCheckpoint(turn,checkpoint)});
   await f.store.commitDialogue(turn,dialogue);
   const job=await f.store.claimSettlement(runtime.metadata);assert(job);
   const result=await runtime.settleWorldTurn!(job.input,job.dialogue,{attemptId:job.attempt,signal:new AbortController().signal,onTextDelta:()=>{},onCall:record=>f.store.saveSettlementCall(job,record),onCheckpoint:checkpoint=>f.store.saveSettlementCheckpoint(job,checkpoint)});
   assert(result.entityChanges.some(change=>change.entity.kind==='location'&&change.entity.name==='便利店'));
   await f.store.saveSettlementResult(job,result);assert.equal(await f.store.completeSettlement(job),true);
   const next=await f.store.beginTurn('alice',session.session.id,randomUUID(),'好。',runtime.metadata);
   assert.equal(next.input.scene?.location,'便利店');
   assert(next.input.worldContext!.entities.some(entity=>entity.kind==='location'&&entity.name==='便利店'));
   const world=await f.store.getWorld('alice',turn.worldId);assert.equal(world.wikiSummaries?.[0]?.sourceTurnId,turn.id);assert(world.wikiSummaries?.[0]?.text.includes('便利店'));
   const count=await f.store.pool.query("SELECT count(*) AS n FROM world_entities WHERE owner_id='alice' AND world_id=$1 AND kind='location' AND name='便利店'",[turn.worldId]);assert.equal(Number(count.rows[0].n),1);
   const trace=await f.store.getTrace('alice',turn.id);for(const key of ['world_orchestrator','character_actor','delivery_formatter','location_generator','teacher_worldops','scene_locator'])assert(trace.calls.some(call=>call.delegateKey===key&&call.status==='completed'),key);
   const locator=trace.calls.find(call=>call.delegateKey==='scene_locator'&&call.status==='completed')!;
   assert.equal(trace.calls.find(call=>call.id===locator.parentId)?.delegateKey,'location_generator');
   assert.equal(actors,1);await f.store.finish(next,'cancelled','TEST_COMPLETE','测试完成');
 }finally{await f.cleanup();}
});

test('restored policies require all sixteen real archived prompts and preserve published prompt versions',async()=>{
 const rows=Array.from({length:16},(_,n)=>({key:String(n),prompt:'p',versions:[],current_version:1}));
 await assert.rejects(oldAgentPolicies({query:async()=>({rows})} as any),/INCOMPLETE/);
 await assert.rejects(oldAgentPolicies({query:async()=>({rows:[]})} as any),/INCOMPLETE/);
 const keys=['phase1_actor','scene_conductor','character_actor','opening_director','teacher_worldops','knowledge_audit','user_agency_audit','wiki_summarizer','world_arbiter','quest_keeper','world_pulse_planner','location_generator','encounter_resolver','delivery_formatter','auto_reply','world_orchestrator'];
 const complete=keys.map(key=>({key,prompt:`published ${key}`,current_version:99,versions:[{version:3,status:'published',prompt:`published ${key}`},{version:99,status:'draft',prompt:'unpublished'}]}));
 const restored=await oldAgentPolicies({query:async()=>({rows:complete})} as any);
 assert.equal(Object.keys(restored.policies!).length,16);
 for(const [key,policy] of Object.entries(restored.policies!)){assert.equal(policy.version,3);assert.equal(policy.prompt,`published ${key}`);assert.equal(policy.enabled,true);}
 complete[0]!.versions=[];
 await assert.rejects(oldAgentPolicies({query:async()=>({rows:complete})} as any),/VERSION_MISSING/);
});
