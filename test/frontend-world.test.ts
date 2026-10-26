import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Character, Message, SessionDetail, TurnEvent, WorldEntity, WorldView } from '../shared/contracts';
import { createApiClient } from '../web/api';
import { applyTurnEvent, initialConversation, needsOpening, openingAttempt, recoverTurn } from '../web/conversation-state';
import { messageCharacter, worldCharacters, worldRecordCounts, worldBackgroundStatus } from '../web/world-model';
import { SceneBuilder } from '../web/SceneBuilder';
import { EntityCard, WorldArchive } from '../web/WorldArchive';
import { MessageBubble } from '../web/ChatMessage';
import { SceneEditor, SceneStrip } from '../web/ScenePanel';
import { sceneDraft, sceneDraftReducer, scenePatch } from '../web/scene-state';
import { agentLabels } from '../web/agent-labels';
import { readPromptDrafts, writePromptDrafts } from '../web/prompt-drafts';

const root: Character = { id: 'root', name: '根角色', subtitle: '根卡', description: '原始角色', initial: '根', color: 'sage', greeting: '旧欢迎', source: 'legacy', thumbnailUrl: '/root.png' };
const entity = (id: string, name: string, kind: WorldEntity['kind'] = 'npc'): WorldEntity => ({ id, name, kind, description: '故事生成', state: { origin: '送信人来访', initial: name.slice(0, 1), color: 'blue' }, knownByCharacterIds: ['root'], sourceTurnId: 'turn1', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' });
const world: WorldView = { id: 'world', title: '世界', revision: 1, createdAt: '', events: [], entities: [entity('root', '根角色'), entity('npc1', '送信人'), entity('place1', '旧书店', 'location')], scene: { location: '旧书店', presentCharacterIds: ['root', 'npc1'], mode: 'ensemble' } };
const message: Message = { id: 'user', sessionId: 'session', turnId: 'turn1', role: 'user', content: '你们怎么看？', status: 'pending', createdAt: '2026-10-21T00:00:00Z' };
const detail: SessionDetail = { session: { id: 'session', characterId: 'root', worldId: 'world', title: '场景', createdAt: '', updatedAt: '', dynamicOpening: true }, world, messages: [], hasMore: false, nextBefore: null };
const reply = (id: string, characterId: string, content: string): Message => ({ ...message, id, characterId, characterName: characterId === 'root' ? '根角色' : '送信人', role: 'assistant', content, status: 'committed', kind: 'dialogue' });

test('world entity cards render persisted state and resolve item, quest and NPC references to world names', () => {
  const render = (record: WorldEntity) => renderToStaticMarkup(createElement(EntityCard, { entity: record, entities: world.entities!, templates: [root], busy: false, onScene: () => {} }));
  const item = render({ ...entity('item1', 'Q-1987习题册', 'item'), state: { status: '未被借走', locationId: 'place1', holderCharacterId: 'npc1' } });
  assert.match(item, /<dt>状态<\/dt><dd>未被借走<\/dd>/);
  assert.match(item, /<dt>所在地点<\/dt><dd>旧书店<\/dd>/);
  assert.match(item, /<dt>持有者<\/dt><dd>送信人<\/dd>/);
  assert.doesNotMatch(item, /locationId|holderCharacterId|place1|npc1/);
  const carried=render({...entity('carried','玩家书包','item'),state:{holderCharacterId:'$player'}});
  assert.match(carried,/<dt>持有者<\/dt><dd>你（玩家）<\/dd>/);assert.doesNotMatch(carried,/\$player/);
  assert.match(render({...entity('placed','书包','item'),state:{holderCharacterId:null}}),/当前无人持有/);
  const quest = render({ ...entity('quest1', '归还习题册', 'quest'), state: { status: 'active', ownerCharacterId: 'npc1', dueAt: '2026-10-22T06:00:00Z', result: '等待归还' } });
  assert.match(quest, /<dt>状态<\/dt><dd>进行中<\/dd>/);
  assert.match(quest, /<dt>负责人<\/dt><dd>送信人<\/dd>/);
  assert.match(quest, /<dt>约定时间<\/dt><dd>2026\/10\/22/);
  assert.match(quest, /<dt>结果<\/dt><dd>等待归还<\/dd>/);
  const npc = render({ ...entity('npc1', '送信人'), state: { locationId: 'place1' } });
  assert.match(npc, /<dt>最近确认地点<\/dt><dd>旧书店<\/dd>/);
  const departing = render({ ...entity('npc1', '送信人'), state: { locationId: null } });
  assert.match(departing, /已离开，尚未确认到达地点/);
});

test('entity cards omit missing, invalid and wrong-kind state references instead of leaking identifiers', () => {
  const render = (record: WorldEntity) => renderToStaticMarkup(createElement(EntityCard, { entity: record, entities: world.entities!, templates: [root], busy: false, onScene: () => {} }));
  const item = render({ ...entity('item1', '空档案', 'item'), state: { status: '  ', locationId: 'npc1', holderCharacterId: '55555555-5555-4555-8555-555555555555' } });
  assert.doesNotMatch(item, /av-entity-details|所在地点|持有者|55555555|npc1/);
  const quest = render({ ...entity('quest1', '未补充的任务', 'quest'), state: { ownerCharacterId: 'place1', dueAt: 'not-a-date', result: '', arc: ' ' } });
  assert.doesNotMatch(quest, /av-entity-details|约定时间|负责人|尚未记录状态|av-entity-arc|not-a-date|place1/);
});

test('NPC summaries display viewpoint and source attribution without certifying player motives', () => {
  const render = (state: Record<string, unknown>) => renderToStaticMarkup(createElement(EntityCard, { entity: { ...entity('npc1', '送信人'), state }, entities: world.entities!, templates: [root], busy: false, onScene: () => {} }));
  const legacy = render({ arc: '她觉得玩家很紧张。' });
  assert.match(legacy, /角色视角摘要/); assert.match(legacy, /旧摘要 · 来源未核验/);
  const sourced = render({ arc: '她猜测玩家在偷懒。', arcProvenance: { kind: 'character_view', status: 'source_verified', turnId: 'turn1', source: 'actor', characterId: 'npc1', quote: '她说：“你是不是在偷懒？”' } });
  assert.match(sourced, /可能包含主观判断/); assert.match(sourced, /查看本次摘要的来源片段/);
  assert.match(sourced, /来源可追溯，不代表整段摘要已经核实/);
});

test('world cast is derived from persisted NPC entities, never the unrelated seed catalog', () => {
  const cast = worldCharacters(world, [root, { ...root, id: 'unrelated', name: '另一张根卡' }]);
  assert.deepEqual(cast.map(character => character.id), ['root', 'npc1']);
  assert.equal(cast[0].thumbnailUrl, '/root.png');
  assert.equal(cast[1].source, 'generated');
  assert.equal(cast[1].subtitle, '在这个故事中结识');
  assert.equal(worldCharacters({ ...world, entities: [{ ...entity('root', '根角色'), state: { origin: 'seed' } }] }, [{ ...root, subtitle: '' }])[0].subtitle, '故事的起点');
  assert.deepEqual(worldCharacters(undefined, [root]), []);
  assert.deepEqual(worldCharacters({ ...world, entities: undefined, scene: { location: null, presentCharacterIds: ['root'] } }, [root, { ...root, id: 'unrelated' }]).map(character => character.id), ['root']);
});

test('initial scene builder presents only its root card and explains persistent NPC generation', () => {
  const html = renderToStaticMarkup(createElement(SceneBuilder, { client:createApiClient(), seedCharacter: root, characters: [root, { ...root, id: 'other', name: '不应混入' }], busy: false, onCreate: async () => {}, onClose: () => {} }));
  assert.match(html, /新人物、地点和线索会随着后续互动自然发展/);
  assert.match(html, /根角色/);
  assert.doesNotMatch(html, /不应混入/);
  assert.match(html, /<option value="authored" selected="">作者原开场/);
  assert.match(html, /开始故事 · 作者原开场/);
  assert.doesNotMatch(html, /此刻的情境|创建场景并生成开场/);
});

test('rebuilding a scene retains its focus, location, situation and private participation mode', () => {
  const html = renderToStaticMarkup(createElement(SceneBuilder, { client:createApiClient(), world, characters: worldCharacters(world, [root]), defaults: { characterId: 'npc1', location: '偏厅', situation: '继续先前未完成的私下交谈', presentCharacterIds: ['npc1'], mode: 'direct' }, busy: false, onCreate: async () => {}, onClose: () => {} }));
  assert.match(html, /<option value="npc1" selected="">送信人/);
  assert.match(html, /<option value="偏厅" selected="">偏厅/);
  assert.match(html, /继续先前未完成的私下交谈/);
  assert.match(html, /class="is-active"><strong>单独交谈/);
  assert.doesNotMatch(html, /这次出场/);
});

test('dynamic opening resumes using a stable ID while legacy welcomes and committed dialogue never auto-run', () => {
  assert.equal(needsOpening(detail), true);
  assert.equal(needsOpening({ ...detail, session: { ...detail.session, dynamicOpening: false } }), false);
  assert.equal(needsOpening({ ...detail, messages: [{ ...message, kind: 'operation', status: 'cancelled' }] }), false);
  assert.equal(needsOpening({ ...detail, messages: [reply('answer1', 'root', '开场已提交')] }), false);
  assert.deepEqual(openingAttempt('session'), openingAttempt('session'));
  assert.equal(openingAttempt('session').clientTurnId, 'opening:session');
  assert.notEqual(openingAttempt('session').clientTurnId, openingAttempt('other').clientTurnId);
});

test('interleaved speaker deltas stay in separate bubbles and commit all authoritative messages once', () => {
  let state = { ...initialConversation, loading: false, detail: { ...detail, messages: [message] }, pending: { clientTurnId: 'client', content: message.content, turnId: 'turn1' } };
  const delta = (messageId: string, characterId: string, text: string): TurnEvent => ({ type: 'delta', turnId: 'turn1', messageId, characterId, characterName: characterId, text });
  state = applyTurnEvent(state, delta('reply1', 'root', '我先说。')) as typeof state;
  state = applyTurnEvent(state, delta('reply2', 'npc1', '我不同意。')) as typeof state;
  state = applyTurnEvent(state, delta('reply1', 'root', '请听理由。')) as typeof state;
  assert.deepEqual(state.draftMessages.map(item => [item.id, item.characterId, item.content]), [['reply1', 'root', '我先说。请听理由。'], ['reply2', 'npc1', '我不同意。']]);
  assert.equal(state.detail.messages.length, 1, 'draft dialogue must not become persisted chat before commit');
  const replies = [reply('reply1', 'root', '我先说。请听理由。'), reply('reply2', 'npc1', '我不同意。')];
  const committed = applyTurnEvent(state, { type: 'committed', turnId: 'turn1', message: replies[0], messages: replies, world: { ...world, revision: 2 } });
  assert.deepEqual(committed.detail?.messages.map(item => item.id), ['user', 'reply1', 'reply2']);
  assert.equal(committed.detail?.messages[0].status, 'committed');
  assert.equal(committed.draftMessages.length, 0);
  assert.equal(applyTurnEvent(committed, { type: 'committed', turnId: 'turn1', message: replies[0], messages: replies, world }), committed);
});

test('recovery restores every committed speaker and cancellation drops all staged speakers', () => {
  const running = { ...initialConversation, detail: { ...detail, messages: [message] }, pending: { clientTurnId: 'client', content: message.content, turnId: 'turn1' } };
  const replies = [reply('reply1', 'root', '回答一'), reply('reply2', 'npc1', '回答二')];
  const recovered = recoverTurn(running, { id: 'turn1', worldId: world.id, sessionId: 'session', status: 'committed', phase: 'settling', userMessage: message, assistantMessage: replies[0], assistantMessages: replies });
  assert.deepEqual(recovered.detail?.messages.map(item => item.id), ['user', 'reply1', 'reply2']);
  const staged = applyTurnEvent(running, { type: 'delta', turnId: 'turn1', characterId: 'npc1', text: '未完成' });
  const cancelled = applyTurnEvent(staged, { type: 'cancelled', turnId: 'turn1', code: 'CANCELLED', message: '停止' });
  assert.equal(cancelled.draftMessages.length, 0);
  assert.equal(cancelled.detail?.world.revision, 1);
  assert.equal(cancelled.detail?.messages.length, 1);
});

test('operation messages are hidden and a newly streamed NPC never borrows the root speaker identity', () => {
  const operation = renderToStaticMarkup(createElement(MessageBubble, { message: { ...message, kind: 'operation' }, character: root, onCopy: () => {} }));
  assert.equal(operation, '');
  const incoming = reply('new', 'npc-new', '我刚刚来访'); incoming.characterName = '新访客';
  const character = messageCharacter(incoming, [root], root);
  assert.equal(character?.id, 'npc-new');
  assert.equal(character?.name, '新访客');
  const html = renderToStaticMarkup(createElement(MessageBubble, { message: incoming, character, streaming: true, onCopy: () => {} }));
  assert.match(html, /新访客/);
  assert.doesNotMatch(html, /根角色/);
});

test('new world endpoints preserve namespace, revision and opening identity without synthetic user text', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createApiClient({ baseUrl: '/feature/api', fetch: async (url, init) => { calls.push({ url: String(url), init }); return String(url).endsWith('/opening') ? new Response('event: cancelled\ndata: {"type":"cancelled","turnId":"t","code":"CANCELLED","message":"停止"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : Response.json({}); } });
  await client.world('world/one');
  await client.updateClock('world/one', { expectedRevision: 7, mode: 'quiet', rate: 3 });
  await client.createSession({ characterId: 'root', dynamicOpening: true, scene: world.scene });
  await client.opening('session/one', { clientTurnId: 'opening:session/one' }, () => {});
  await client.agentCatalog();
  assert.deepEqual(calls.map(call => call.url), ['/feature/api/worlds/world%2Fone', '/feature/api/worlds/world%2Fone/clock', '/feature/api/sessions', '/feature/api/sessions/session%2Fone/opening', '/feature/api/dev/agent-catalog']);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { expectedRevision: 7, mode: 'quiet', rate: 3 });
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { clientTurnId: 'opening:session/one' });
});

test('all six actual agent drafts persist and have distinct display identities', () => {
  let saved = ''; const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const drafts = { main: 'm', actor: 'a', updater: 'u', opening: 'o', pulse: 'p', arbiter: 'r' };
  writePromptDrafts('owner:', drafts, storage);
  assert.deepEqual(readPromptDrafts('owner:', storage), drafts);
  assert.equal(new Set(Object.values(agentLabels)).size, 6);
  assert.match(agentLabels.updater, /WorldOps/);
});

test('private scene scope stays visible and editing its location preserves mode and situation', () => {
  const privateWorld = { ...world, scene: { ...world.scene!, mode: 'direct' as const, situation: '只向根角色透露秘密' } };
  const html = renderToStaticMarkup(createElement(SceneStrip, { world: privateWorld, characters: [root], busy: false, onEdit: () => {} }));
  assert.match(html, /私聊 · 仅关注角色听见/);
  const updated = scenePatch({ ...sceneDraft(privateWorld), location: '新地点' });
  assert.equal(updated.scene.mode, 'direct');
  assert.equal(updated.scene.situation, '只向根角色透露秘密');
});

test('editing an NPC scene does not silently bring an absent player back into hearing range', () => {
  const absentWorld = { ...world, scene: { ...world.scene!, playerPresent: false } };
  const html = renderToStaticMarkup(createElement(SceneStrip, { world: absentWorld, characters: [root], busy: false, onEdit: () => {} }));
  assert.match(html, /你已离场/);
  const updated = scenePatch({ ...sceneDraft(absentWorld), location: '教师办公室' });
  assert.equal(updated.scene.playerPresent, false);
});

test('saved interactions are counted independently of selected player memories and offline activities', () => {
  const event = { id: 'event1', kind: 'fact' as const, text: '玩家原话', visibility: 'private' as const, characterId: 'root', sourceTurnId: 'turn1', createdAt: '', status: 'active' as const, evidence: { source: 'user' as const, turnId: 'turn1' } };
  const episode = { turnId: 'turn1', sessionId: 'session', kind: 'chat' as const, occurredAt: '', scene: world.scene!, participantIds: ['root'], userText: '消息', replies: [] };
  assert.deepEqual(worldRecordCounts({ ...world, events: [], episodes: [episode, { ...episode, turnId: 'opening', kind: 'opening' }] }), { quotations: 0, interactions: 2 });
  const html = renderToStaticMarkup(createElement(WorldArchive, { world: { ...world, episodes: [episode, { ...episode, turnId: 'opening', kind: 'opening' }, { ...episode, kind: 'pulse' }] }, templates: [root], client: createApiClient(), busy: false, onBack: () => {}, onScene: () => {}, onSession: () => {}, onUpdated: async () => {} }));
  assert.match(html, /2 段已提交互动/);
  assert.doesNotMatch(html, /3 段已提交互动/);
  assert.deepEqual(worldRecordCounts({ ...world, events: [event, { ...event, id: 'inactive', status: 'retracted' }, { ...event, id: 'old', status: 'unverified' }, { ...event, id: 'unsupported', evidence: null }], episodes: [episode, episode, { ...episode, kind: 'pulse' }] }), { quotations: 1, interactions: 1 });
});

test('scene editor switches to a private focus and requires explicit additions when returning to a shared scene', () => {
  let draft = sceneDraft(world);
  draft = sceneDraftReducer(draft, { type: 'mode', value: 'direct', focusId: 'root' });
  assert.deepEqual(scenePatch(draft, 'root').scene.presentCharacterIds, ['root']);
  assert.equal(scenePatch(draft, 'root').scene.mode, 'direct');
  assert.equal(draft.revision, world.revision);
  assert.deepEqual(world.scene?.presentCharacterIds, ['root', 'npc1']);
  draft = sceneDraftReducer(draft, { type: 'mode', value: 'ensemble', focusId: 'root' });
  assert.deepEqual(draft.present, ['root'], 'leaving private mode must not automatically add other listeners');
  draft = sceneDraftReducer(draft, { type: 'present', value: ['root', 'npc1'] });
  assert.deepEqual(scenePatch(draft, 'root').scene.presentCharacterIds, ['root', 'npc1']);
  assert.deepEqual(scenePatch({ ...draft, mode: 'direct' }, 'root').scene.presentCharacterIds, ['root'], 'a stale private roster cannot be sent with additional listeners');
  const html = renderToStaticMarkup(createElement(SceneEditor, { world: { ...world, scene: { ...world.scene!, mode: 'direct', presentCharacterIds: ['root'] } }, characters: worldCharacters(world, [root]), activeCharacterId: 'root', sessionId: 'session', busy: false, client: createApiClient(), onSaved: async () => null, onClose: () => {} }));
  assert.match(html, /私聊 · 仅当前角色听见/);
  assert.match(html, /共同场景 · 在场角色可以听见/);
  assert.doesNotMatch(html, /搜索在场角色/);
});


test('background polling survives completed memory while director prepares, without blocking the next reply', () => {
  const backgroundWorld: WorldView = { ...world, settlements: [{ turnId: 'turn1', status: 'completed', attempts: 1 }], director: { turnId: 'turn1', status: 'running' } };
  assert.equal(worldBackgroundStatus(backgroundWorld).polling, true);
  const saved = applyTurnEvent({ ...initialConversation, detail, pending: { clientTurnId: 'client', content: '继续', turnId: 'turn1' }, draft: '角色回应' }, { type: 'committed', turnId: 'turn1', message: reply('reply1', 'root', '角色回应'), world: backgroundWorld });
  assert.equal(saved.pending, null);
  assert.equal(saved.detail?.messages[0].content, '角色回应');
  assert.equal(worldBackgroundStatus({ ...backgroundWorld, director: { turnId: 'turn1', status: 'failed' } }).polling, false);
  assert.equal(worldBackgroundStatus({ ...backgroundWorld, director: { turnId: 'turn1', status: 'completed' } }).polling, false);
});

test('background counters use total backlog rather than the bounded trace list', () => {
  const background = worldBackgroundStatus({ ...world, settlements: [{ turnId: 'old', status: 'failed', attempts: 3 }], settlementBacklog: { pendingTurns: 72, failedTurns: 4, oldestPendingAt: '2026-10-23T00:00:00Z' } });
  assert.equal(background.pendingTurns, 72);
  assert.equal(background.failedTurns, 4);
  assert.equal(background.polling, true);
  assert.equal(worldBackgroundStatus({ ...world, settlements: [{ turnId: 'old', status: 'pending', attempts: 1 }], settlementBacklog: { pendingTurns: 0, failedTurns: 0, oldestPendingAt: null } }).polling, false);
});
