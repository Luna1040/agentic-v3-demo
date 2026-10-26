import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {messageText} from '../web/message-text';
import {MessageBubble} from '../web/ChatMessage';
import type {Message} from '../shared/contracts';
import {postgresFixture} from './pg-helper';

const base:Message={id:'m',sessionId:'s',turnId:null,role:'assistant',content:'{{char}}向{{user}}招手。{{ CHAR }}说：“你好，{{ USER }}。”',createdAt:'2026-10-23T00:00:00Z',characterName:'斯卡蕾特',playerName:'林舟'};
test('welcome and NPC text expands the recorded speaker/player names without altering source',()=>{
 const source=base.content;
 assert.equal(messageText(base),'斯卡蕾特向林舟招手。斯卡蕾特说：“你好，林舟。”');
 assert.equal(messageText({...base,characterName:'米娅'}),'米娅向林舟招手。米娅说：“你好，林舟。”');
 const html=renderToStaticMarkup(createElement(MessageBubble,{message:base,onCopy:()=>{}}));
 assert.match(html,/斯卡蕾特向林舟招手/);assert.doesNotMatch(html,/\{\{(char|user)/i);
 assert.equal(base.content,source);
});
test('unconfigured names, literal replacements, unknown macros and user input remain safe',()=>{
 assert.equal(messageText({...base,playerName:undefined,characterName:undefined,content:'{{char}}看着{{user}}。'}),'角色看着玩家。');
 assert.equal(messageText({...base,characterName:'$&{{user}}',content:'{{char}}/{{user}}/{{other}}'}),'$&{{user}}/林舟/{{other}}');
 assert.equal(messageText({...base,role:'user'}),base.content);
 const html=renderToStaticMarkup(createElement(MessageBubble,{message:{...base,playerName:'<img src=x onerror=alert(1)>'},onCopy:()=>{}}));
 assert.doesNotMatch(html,/<img src="?x/);assert.match(html,/&lt;img/);
});
test('welcome and committed reply names survive persona switches and remain unchanged in turn recovery',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const profile=await f.store.savePlayerProfile('alice',null,{name:'林舟',persona:'访客'});
  const detail=await f.store.createSession('alice','lin-wan',undefined,{playerProfileId:profile.id});
  assert.equal(detail.messages[0].playerName,'林舟');
  const turn=await f.store.beginTurn('alice',detail.session.id,'hello','你好');
  await f.store.commit(turn,'{{char}}向{{user}}招手。',[],{observations:{'lin-wan':'你好'}});
  const second=await f.store.savePlayerProfile('alice',null,{name:'周宁',persona:'访客'});
  const before=await f.store.getWorld('alice',detail.world.id);
  await f.store.setPlayerProfile('alice',detail.world.id,second.id,before.revision);
  const loaded=await f.store.getSession('alice',detail.session.id);
  assert.equal(loaded.world.playerProfile?.name,'周宁');
  assert(loaded.messages.every(m=>m.playerName==='林舟'));
  const recovery=await f.store.getTurn('alice',turn.id);
  assert.equal(recovery.assistantMessages?.[0].playerName,'林舟');
  assert.equal(messageText(recovery.assistantMessages![0]),'林晚向林舟招手。');
 }finally{await f.cleanup();}
});


test('authored welcome follows current identity while historical speech stays frozen',()=>{
 assert.match(messageText(base,undefined,'周宁'),/斯卡蕾特向周宁/);
 assert.match(messageText(base,undefined,null),/斯卡蕾特向玩家/);
 assert.match(messageText({...base,turnId:'completed'},undefined,'周宁'),/斯卡蕾特向林舟/);
 const html=renderToStaticMarkup(createElement(MessageBubble,{message:base,currentPlayerName:'周宁',onCopy:()=>{}}));
 assert.match(html,/斯卡蕾特向周宁/);
});

test('model input materializes both names in card fields, director reference and each actor packet',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const template='{{char}}在书店等{{user}}，{{ CHAR }}向{{ USER }}问好。';
  await f.migrationPool.query("UPDATE characters SET description=$1,definition=$1,greeting=$1 WHERE id='lin-wan'",[template]);
  const a=await f.store.savePlayerProfile('alice',null,{name:'卢娜',persona:'安静的访客'});
  const detail=await f.store.createSession('alice','lin-wan',undefined,{playerProfileId:a.id});
  const input=await f.store.previewInput('alice',detail.session.id,'保留原话 {{char}} {{user}}');
  for(const packet of [input,input.worldContext!.actorInputs['lin-wan']]){
   for(const field of ['description','definition'] as const){
    assert.equal(packet.character[field],'林晚在书店等卢娜，林晚向卢娜问好。');
   }
   assert.equal(packet.contextPack!.card.openingBackground,'林晚在书店等卢娜，林晚向卢娜问好。');assert.equal(packet.playerProfile?.name,'卢娜');
  }
  assert.equal(input.directorContext?.openingReference,'林晚在书店等卢娜，林晚向卢娜问好。');
  assert.equal(input.userText,'保留原话 {{char}} {{user}}');
  const b=await f.store.savePlayerProfile('alice',null,{name:'周宁',persona:'另一个设定'});
  await f.store.setPlayerProfile('alice',detail.world.id,b.id,detail.world.revision);
  const next=await f.store.previewInput('alice',detail.session.id,'你好');
  assert.equal(next.contextPack!.card.openingBackground,'林晚在书店等周宁，林晚向周宁问好。');assert.equal(next.character.greeting,'');
  assert.equal(next.playerProfile?.name,'周宁');
  assert.equal((await f.store.getSession('alice',detail.session.id)).messages[0].content,template);
  assert.equal((await f.migrationPool.query("SELECT greeting FROM characters WHERE id='lin-wan'")).rows[0].greeting,template);
 }finally{await f.cleanup();}
});


test('committing a rendered NPC description preserves its template but rejects real persona rewrites',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const template='{{char}}等待{{user}}。';
  await f.migrationPool.query("UPDATE characters SET description=$1 WHERE id='lin-wan'",[template]);
  const p=await f.store.savePlayerProfile('alice',null,{name:'卢娜',persona:''});
  const d=await f.store.createSession('alice','lin-wan',undefined,{playerProfileId:p.id});
  const t=await f.store.beginTurn('alice',d.session.id,'commit-projection','你好');
  const e=t.input.worldContext!.entities.find(e=>e.id==='lin-wan')!;
  const change={op:'update' as const,entity:{id:e.id,kind:e.kind,name:e.name,description:e.description,state:{arc:'林晚向卢娜问好。'}}};
  assert.equal(e.description,'林晚等待卢娜。');
  await assert.rejects(f.store.commit(t,'林晚点头。',[],{observations:{'lin-wan':'你好'},entityChanges:[{...change,entity:{...change.entity,description:'林晚变成完全不同的人。'}}]}),{code:'ENTITY_LOCKED'});
  await f.store.commit(t,'林晚点头。',[],{observations:{'lin-wan':'你好'},entityChanges:[change]});
  const saved=(await f.store.getWorld('alice',d.world.id)).entities!.find(e=>e.id==='lin-wan')!;
  assert.equal(saved.description,template);
  assert.equal(saved.state.arc,'林晚向卢娜问好。');
 }finally{await f.cleanup();}
});
