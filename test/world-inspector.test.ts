import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryDrawer} from '../web/MemoryDrawer';
import {WorldInspection} from '../web/WorldInspector';
import {createApiClient} from '../web/api';
import type {WorldView} from '../shared/contracts';

const world:WorldView={id:'w',title:'测试世界',createdAt:'2026-10-23T00:00:00Z',revision:3,events:[],
 scene:{location:'p',presentCharacterIds:['n'],playerPresent:true},
 entities:[{id:'n',kind:'npc',name:'艾米丽',description:'前排同学',knownByCharacterIds:['n'],createdAt:'2026-10-23T00:00:00Z',updatedAt:'2026-10-23T00:00:00Z',sourceTurnId:'turn-1',state:{arc:'艾米丽记得一起借过红心水笔。',arcProvenance:{kind:'character_view',status:'source_verified',source:'actor',characterId:'n',turnId:'turn-1',quote:'艾米丽递过笔。'}}},
 {id:'p',kind:'location',name:'早课教室',description:'正在上课',knownByCharacterIds:['n'],createdAt:'2026-10-23T00:00:00Z',updatedAt:'2026-10-23T00:00:00Z',sourceTurnId:'turn-1',state:{}}],
 settlementBacklog:{pendingTurns:2,failedTurns:1,oldestPendingAt:null},director:{status:'running',turnId:'turn-1'},
 mainlinePlan:{planType:'mainline',version:1,id:'plan',status:'active',basedOnTurnId:'turn-1',goal:'完成早课并归还水笔',targetTurns:8,currentStageId:'class',invalidWhen:[],stages:[{id:'class',goal:'参与课堂',status:'active',budgetTurns:8,completionCondition:'老师宣布下课'}]}};

test('split authored people show reviewed common memory before new individual summaries exist',()=>{
 const split=structuredClone(world);split.entities=split.entities!.filter(e=>e.kind==='npc');
 split.entities![0].state={authoredSharedMemory:{summary:'共同点了红茶和蛋糕。',sourceTurnIds:['source-12345678']}};
 const html=renderToStaticMarkup(createElement(WorldInspection,{world:split,tab:'memory'}));
 assert.ok(html.includes('艾米丽'));assert.ok(html.includes('共同点了红茶和蛋糕'));
 assert.ok(html.includes('共同经历来源'));assert.ok(html.includes('12345678'));
 assert.ok(!html.includes('暂无已保存的角色摘要'));
});

test('completed extraction with unapplied candidates and open-ledger overflow is not displayed as full success',()=>{
 const partial=structuredClone(world);
 partial.settlementBacklog={pendingTurns:0,failedTurns:0,oldestPendingAt:null,unresolvedCommands:2,unresolvedTurns:1};
 partial.settlements=[{turnId:'source-12345678',status:'completed',attempts:1,unresolvedCommands:2}];
 partial.eventLedgerOverflow={openEvents:103,omittedOpenEvents:3};
 const html=renderToStaticMarkup(createElement(WorldInspection,{world:partial,tab:'overview'}));
 assert.ok(html.includes('归档结束·有待核对'));assert.ok(html.includes('条未应用候选'));
 assert.ok(html.includes('当前仅展开 100 项'));assert.ok(html.includes('不能视为已经结束'));
});

test('chat drawer exposes scene and mainline by default even with zero legacy memories',()=>{
 const html=renderToStaticMarkup(createElement(MemoryDrawer,{world,creating:false,busy:false,client:createApiClient(),onWorld:()=>{},onRefresh:async()=>{},onContinue:()=>{},onClose:()=>{}}));
 for(const text of ['世界状态与剧情','完成早课并归还水笔','参与课堂','老师宣布下课','早课教室','艾米丽','归档待处理 2 轮','失败 1 轮','正在规划','角色记忆','物品','约定与任务'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('故事还很轻'));
 assert.match(html,/<details[^>]*open/);
});
test('modern character memory remains visible without a legacy player quotation',()=>{
 const html=renderToStaticMarkup(createElement(WorldInspection,{world,tab:'memory'}));
 assert.ok(html.includes('艾米丽记得一起借过红心水笔'));
 assert.ok(html.includes('艾米丽递过笔'));
 assert.ok(html.includes('角色回应'));
 const npc=renderToStaticMarkup(createElement(WorldInspection,{world,tab:'npc'}));
 assert.ok(npc.includes('当前登场'));
 assert.ok(npc.includes('保存字段、知情范围与来源'));
});
test('empty and failed states explicitly show missing data and distinguish plans from facts',()=>{
 const html=renderToStaticMarkup(createElement(WorldInspection,{world:{...world,mainlinePlan:undefined,director:{status:'failed',turnId:'t',errorCode:'PROVIDER_ERROR'},scene:undefined},tab:'overview'}));
 for(const text of ['尚未确认／入库','规划失败','PROVIDER_ERROR','尚无已保存主线'])assert.ok(html.includes(text),text);
 const location=renderToStaticMarkup(createElement(WorldInspection,{world:{...world,entities:[]},tab:'location'}));
 assert.ok(location.includes('尚未入库记录'));
});

test('appointment inspector shows its authoritative changed time, next step and default player owner',()=>{
 const html=renderToStaticMarkup(createElement(WorldInspection,{tab:'quest',world:{...world,playerProfile:{id:'p',name:'林舟',persona:'',version:1},entities:[...(world.entities??[]),{id:'movie',kind:'quest',name:'电影邀约',description:'明天一起看电影',knownByCharacterIds:['n'],state:{status:'active',storyDue:{day:2,minute:960,precision:'minute'},progression:{nextStep:'明天下午四点见面'}},createdAt:world.createdAt,updatedAt:world.createdAt,sourceTurnId:'turn-1'}]}}));
 for(const text of ['责任人：','林舟','约定时间：','16:00','下一步：','明天下午四点见面'])assert(html.includes(text),text);
});
