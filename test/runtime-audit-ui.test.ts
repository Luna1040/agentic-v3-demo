import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeAuditView } from '../shared/contracts';
import { createApiClient } from '../web/api';
import { MemoryDrawer } from '../web/MemoryDrawer';
import { RuntimeAuditRecords } from '../web/RuntimeAudit';
import { auditBatches, auditFieldChanges, auditFieldSource } from '../web/runtime-audit-model';

const at='2026-10-26T10:00:00Z';
function fixture(): RuntimeAuditView {
  const first={id:'food',name:'三杯鸡',kind:'item' as const,description:'晚饭的主菜',version:1,sourceTurnId:'turn-00000001',state:{status:'已加入购物车',holderCharacterId:null}};
  const after={...first,version:2,sourceTurnId:'turn-00000003',state:{...first.state,status:'已下单'}};
  return {capture:{id:'capture',startedAt:at,afterSeq:20,expectedTurns:7},worldRevision:4,truncated:false,backlog:{pendingTurns:2,failedTurns:1,unresolvedCommands:1},
    turns:[1,2,3].map(index=>({id:`turn-0000000${index}`,seq:20+index,userText:['那就选这家吧。','我去拿杯子。','好啊。'][index-1],status:'committed',createdAt:at,updatedAt:at,settlementStatus:index===3?'failed':'completed',attempts:index===3?2:1,batchId:'batch-12345678'})),
    events:[
      {id:'a',kind:'queued',at,turnId:'turn-00000001',data:{lane:'worldops'}},
      {id:'b',kind:'claimed',at,batchId:'batch-12345678',data:{lane:'worldops',memberTurnIds:['turn-00000001','turn-00000002','turn-00000003'],size:3}},
      {id:'c',kind:'committed',at,turnId:'turn-00000001',batchId:'batch-12345678',data:{lane:'worldops',entityChanges:[{id:'food',before:null,after:first}],scene:{before:{location:'old'},after:{location:'living'},disposition:'applied'},worldRevisionBefore:2,worldRevisionAfter:3,unresolvedCommands:0}},
      {id:'d',kind:'rebased',at,turnId:'turn-00000003',data:{lane:'worldops',expectedVersions:{food:1},actualVersions:{food:2}}},
      {id:'e',kind:'split',at,batchId:'batch-12345678',data:{lane:'worldops',memberTurnIds:['turn-00000001','turn-00000002','turn-00000003'],reason:'version_conflict'}},
      {id:'f',kind:'committed',at,turnId:'turn-00000003',data:{lane:'worldops',entityChanges:[{id:'food',before:first,after}],scene:{before:{location:'old'},after:{location:'stale'},disposition:'historical'},worldRevisionBefore:3,worldRevisionAfter:4,unresolvedCommands:1}},
      {id:'g',kind:'director_superseded',at,turnId:'turn-00000002',data:{lane:'director'}},
    ],world:{id:'w',title:'晚饭',revision:4,capturedAt:at,scene:{location:'living',presentCharacterIds:['luz','mili'],playerPresent:true},entities:[{...after,knownByCharacterIds:['luz','mili'],createdAt:at,updatedAt:at}],eventLedger:[]}};
}

test('audit UI separates saved foreground from failed background and renders actual batch, rebase, split and persisted fields',()=>{
  const html=renderToStaticMarkup(createElement(RuntimeAuditRecords,{view:fixture()}));
  for(const text of ['本组已收到 3 / 7 轮','前台：回复已保存','后台：归档失败','真实归档批次 · 1 批','第 1 轮 ＋ 第 2 轮 ＋ 第 3 轮','版本冲突 · 重新对齐','拆分批次','旧规划已被新请求替代','仅保留历史，不回退当前场景','提交前','提交后','三杯鸡','已加入购物车','已下单','00000001','00000003','待核对候选 1 条']) assert.ok(html.includes(text),text);
  assert.ok(!html.includes('全部入库完成'));
});

test('queued turns are not counted as batches and one real singleton never masquerades as merging',()=>{
  const view=fixture();view.events=view.events.filter(event=>event.kind==='queued');
  assert.deepEqual(auditBatches(view),[]);
  assert.match(renderToStaticMarkup(createElement(RuntimeAuditRecords,{view})),/尚无实际领取记录/);
  view.events.push({id:'singleton',kind:'claimed',at,batchId:'single',data:{lane:'worldops',memberTurnIds:['turn-00000001'],size:1}});
  assert.deepEqual(auditBatches(view).map(batch=>batch.turnIds),[['turn-00000001']]);
  view.events.push({id:'director',kind:'claimed',at,batchId:'not-worldops',data:{lane:'director',memberTurnIds:['turn-00000001']}});
  assert.equal(auditBatches(view).length,1);
});

test('three per-member claim logs count as one batch attempt, and checkpoint recovery does not claim a new model call',()=>{
  const view=fixture();
  const memberTurnIds=view.turns.map(turn=>turn.id);
  const claim=(turnId:string,attempt:number)=>({id:turnId+'-'+attempt,kind:'claimed',at,turnId,batchId:'shared-batch',attemptId:turnId+'-attempt-'+attempt,data:{lane:'worldops',memberTurnIds,attemptNumber:attempt,reusedCheckpoint:true}});
  view.events=memberTurnIds.map(id=>claim(id,1));
  assert.equal(auditBatches(view)[0].attempts,1);
  view.events.push(claim(memberTurnIds[0],1));
  assert.equal(auditBatches(view)[0].attempts,1);
  view.events.push(...memberTurnIds.map(id=>claim(id,2)));
  assert.equal(auditBatches(view)[0].attempts,2);
  const html=renderToStaticMarkup(createElement(RuntimeAuditRecords,{view}));
  assert.ok(html.includes('恢复了已有结果／检查点'));
  assert.ok(html.includes('实际请求以调用记录为准'));
  assert.ok(!html.includes('共用一次提取请求</p>'));
});

test('field provenance follows the last actual field change, preserving earlier fields and rejecting historical scene rollback',()=>{
  const view=fixture();
  assert.equal(auditFieldSource(view,'food','state.status'),'turn-00000003');
  assert.equal(auditFieldSource(view,'food','description'),'turn-00000001');
  assert.equal(auditFieldSource(view,'','location','scene'),'turn-00000001');
  assert.equal(auditFieldSource(view,'food','missing'),null);
  assert.equal(auditFieldSource(view,'food','state.status','entity',{value:'已送达'}),null,'current delivered 三杯鸡 must not be attributed to the earlier captured ordered status');
  assert.equal(auditFieldSource(view,'food','state.status','entity',{value:'已下单'}),'turn-00000003');
  assert.deepEqual(auditFieldChanges({state:{status:'planned',holder:null}},{state:{status:'done',holder:null}}),[{path:'state.status',before:'planned',after:'done'}]);
});

test('audit endpoint reads are GET-only; recording is one explicit POST with host authorization preserved',async()=>{
  const requests:{url:string;method:string;body:unknown;authorization:string|null;signal:AbortSignal|null|undefined}[]=[];
  const api=createApiClient({baseUrl:'https://example.test/api/',getHeaders:()=>({Authorization:'Bearer host-token'}),fetch:async(url,init)=>{
    requests.push({url:String(url),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null,authorization:new Headers(init?.headers).get('authorization'),signal:init?.signal});
    return new Response(JSON.stringify(fixture()),{headers:{'Content-Type':'application/json'}});
  }});
  const abort=new AbortController();
  await api.runtimeAudit('world/id',{signal:abort.signal});await api.runtimeAudit('world/id');
  await api.captureRuntimeAudit('world/id',{expectedTurns:7});
  await api.runtimeAudit('world/id',{captureId:'capture-1',includeCalls:true});
  assert.deepEqual(requests.map(({url,method,body})=>({url,method,body})),[
    {url:'https://example.test/api/worlds/world%2Fid/runtime-audit',method:'GET',body:null},
    {url:'https://example.test/api/worlds/world%2Fid/runtime-audit',method:'GET',body:null},
    {url:'https://example.test/api/worlds/world%2Fid/runtime-audit/capture',method:'POST',body:{expectedTurns:7}},
    {url:'https://example.test/api/worlds/world%2Fid/runtime-audit?captureId=capture-1&includeCalls=1',method:'GET',body:null},
  ]);
  assert.ok(requests.every(request=>request.authorization==='Bearer host-token'));
  assert.equal(requests[0].signal,abort.signal);
});

test('developer audit entry is gated and seven collected turns do not imply background success',()=>{
  const view=fixture();
  const props={world:{id:'w',title:'晚饭',revision:1,createdAt:at,events:[]},creating:false,busy:false,client:createApiClient(),onWorld:()=>{},onRefresh:async()=>{},onContinue:()=>{},onClose:()=>{}};
  assert.ok(!renderToStaticMarkup(createElement(MemoryDrawer,props)).includes('队列与入库'));
  assert.ok(renderToStaticMarkup(createElement(MemoryDrawer,{...props,developerTools:true})).includes('队列与入库'));
  view.turns=[...view.turns,...[4,5,6,7].map(index=>({...view.turns[0],id:`turn-${index}`,seq:20+index}))];
  let html=renderToStaticMarkup(createElement(RuntimeAuditRecords,{view}));assert.ok(html.includes('7 轮已收齐，后台仍在处理'));
  view.backlog.pendingTurns=0;html=renderToStaticMarkup(createElement(RuntimeAuditRecords,{view}));assert.ok(html.includes('存在归档失败'));assert.ok(html.includes('仍有候选未应用'));
});
