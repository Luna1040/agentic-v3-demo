import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';
import type { EntityChange, SpeakerReply } from '../shared/living-world.ts';
import { StoryStore, type StoredTurn } from '../server/store.ts';
import { resolveStoryTime, settlementWindow } from '../shared/story-time.ts';

async function absentForTwoMinutes(store: StoryStore, worldId:string): Promise<void> {
  await store.pool.query("UPDATE turns SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=(SELECT id FROM turns WHERE world_id=$1 AND status='committed' ORDER BY seq DESC LIMIT 1)",[worldId]);
  await store.pool.query("UPDATE worlds SET scene=scene || '{\"playerPresent\":false}'::jsonb WHERE id=$1",[worldId]);
  await store.pool.query("UPDATE sessions SET scene=scene || '{\"playerPresent\":false}'::jsonb WHERE world_id=$1",[worldId]);
}

async function actorReply(store: StoryStore, turn: StoredTurn, characterId: string, text: string): Promise<SpeakerReply> {
  const id = randomUUID();
  await store.saveCall(turn, { id, parentId: null, attemptId: turn.attempt, agent: 'actor', status: 'completed', model: 'fixture', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), input: { character: { id: characterId } }, output: { text } });
  return { characterId, characterName: '模型名称不可信', text, callId: id };
}
async function opened(store: StoryStore) {
  const session = await store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true });
  const first = await store.beginTurn('alice', session.session.id, `opening:${session.session.id}`, '开始场景', {}, { operation: 'opening' });
  const a = randomUUID(), b = randomUUID(), place = randomUUID();
  const changes: EntityChange[] = [
    { op: 'create', entity: { id: a, kind: 'npc', name: '阿青', description: '谨慎的抄写员', state: { definition: '面对不合理要求会明确拒绝。', greeting: '她仍握着笔。' } } },
    { op: 'create', entity: { id: b, kind: 'npc', name: '小舟', description: '送信人', state: { definition: '一个可靠的送信人。' } } },
    { op: 'create', entity: { id: place, kind: 'location', name: '阅览室', description: '临窗有一张桌子。', state: { connectedTo: [] } } },
  ];
  const replies = [await actorReply(store, first, 'lin-wan', '林晚把空白纸张推到桌边。'), await actorReply(store, first, a, '我拒绝替你伪造签名。她把笔收了起来。'), await actorReply(store, first, b, '我会留下等消息。')];
  const result = await store.commit(first, replies[0].text, [], { replies, entityChanges: changes, scene: { location: '阅览室', presentCharacterIds: ['lin-wan', a, b], mode: 'ensemble' } });
  return { session: session.session, first, result, a, b, place };
}

test('dynamic opening atomically creates a local cast and full attributed episode, replay is idempotent', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    assert.equal((await f.store.listCharacters()).length, 3);
    assert.equal(s.result.messages.length, 3); assert.equal(s.result.messages[1].characterName, '阿青');
    const detail = await f.store.getSession('alice', s.session.id);
    assert.equal(detail.messages[0].kind, 'operation'); assert.equal(detail.messages.length, 4);
    assert.equal(detail.world.entities?.length, 4); assert.equal(detail.world.episodes?.[0].kind, 'opening');
    assert.equal(detail.world.episodes?.[0].userText, ''); assert.match(detail.world.episodes![0].replies[1].text, /拒绝.*把笔收/);
    assert.equal(detail.world.events.length, 0);
    const replay = await f.store.beginTurn('alice', s.session.id, `opening:${s.session.id}`, '开始场景', {}, { operation: 'opening' });
    assert.equal(replay.status, 'committed'); assert.equal(replay.id, s.first.id);
    assert.equal((await f.store.getTurn('alice', s.first.id)).assistantMessages?.length, 3);
    await assert.rejects(f.store.beginTurn('alice', s.session.id, 'arbitrary', '开始场景', {}, { operation: 'opening' }), { code: 'OPENING_INVALID' });
    await assert.rejects(f.store.createSession('alice', 'shen-yan', s.session.worldId, { dynamicOpening: true }), { code: 'CHARACTER_NOT_FOUND' });
    await assert.rejects(f.store.createSession('bob', s.a, s.session.worldId, { dynamicOpening: true }), { code: 'WORLD_NOT_FOUND' });
  } finally { await f.cleanup(); }
});

test('cross-session episodes retain actual NPC refusal; direct secrets and private entities stay with their listener', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const privateSession = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: '阅览室', presentCharacterIds: [s.a, s.b], mode: 'direct' } });
    const turn = await f.store.beginTurn('alice', privateSession.session.id, 'secret', '秘密：银匙在钟里。');
    assert((await f.store.readDialogue('alice',{worldId:turn.worldId,sourceTurnId:turn.id,characterId:s.a})).episodes.some(episode => episode.replies.some(reply => /我拒绝替你伪造签名/.test(reply.text))));
    assert.equal(turn.input.worldContext?.actorInputs[s.b].userText, '');
    const item = randomUUID(); const reply = await actorReply(f.store, turn, s.a, '我不会告诉小舟。');
    await assert.rejects(f.store.commit(turn, reply.text, [], { replies: [reply], entityChanges: [{ op: 'create', entity: { id: item, kind: 'item', name: '银匙', description: '藏在钟里。', knownByCharacterIds: [s.b] } }] }), { code: 'KNOWLEDGE_SCOPE' });
    await f.store.commit(turn, reply.text, [], { observations: { [s.a]: turn.input.userText }, replies: [reply], entityChanges: [{ op: 'create', entity: { id: item, kind: 'item', name: '银匙', description: '藏在钟里。', knownByCharacterIds: [s.a] } }] });
    const other = await f.store.createSession('alice', s.b, s.session.worldId, { dynamicOpening: true, scene: { location: '阅览室', presentCharacterIds: [s.b], mode: 'direct' } });
    const unknown = await f.store.previewInput('alice', other.session.id, '知道什么？');
    assert(!JSON.stringify(unknown.worldContext!.actorInputs[s.b]).includes('银匙'));
    assert(!JSON.stringify({ ...unknown, worldContext: { ...unknown.worldContext, actorInputs: {} } }).includes('银匙'));
    const own = await f.store.previewInput('alice', privateSession.session.id, '你记得吗？');
    assert((await readPastDialogue(f.store,'alice',privateSession.session.id,s.a)).some(episode => episode.userText.includes('银匙') && episode.replies.some(row => row.text === '我不会告诉小舟。')));
    const saved = (await f.store.getWorld('alice', s.session.worldId)).entities!.find(row => row.id === item)!;
    assert.deepEqual(saved.knownByCharacterIds, [s.a]);
    assert.deepEqual((await f.store.getSession('alice', privateSession.session.id)).world.scene?.presentCharacterIds, [s.a, s.b]);
    assert.deepEqual((await f.store.getSession('alice', other.session.id)).world.scene?.presentCharacterIds, [s.b]);
    const shared = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: null, presentCharacterIds: [s.a, s.b], mode: 'ensemble' } });
    const edit = await f.store.beginTurn('alice', shared.session.id, 'private-edit', '调整那件物品的编号。');
    await f.store.commit(edit, '已记下。', [], { entityChanges: [{ op: 'update', entity: { id: item, kind: 'item', name: '银匙', description: '藏在钟里。', state: { status: '已编号' }, knownByCharacterIds: [s.a, s.b] } }] });
    assert.deepEqual((await f.store.getWorld('alice', s.session.worldId)).entities!.find(row => row.id === item)!.knownByCharacterIds, [s.a]);
  } finally { await f.cleanup(); }
});

test('reply call provenance, private audience, entity authority and CAS failures roll back the whole candidate', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const session = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: null, presentCharacterIds: [s.a, s.b], mode: 'direct' } });
    const turn = await f.store.beginTurn('alice', session.session.id, 'same', '不要公开这件事。');
    const reply = await actorReply(f.store, turn, s.a, '我理解。');
    await assert.rejects(f.store.commit(turn, '伪造摘要', [], { replies: [{ ...reply, text: '他其实同意了。' }] }), { code: 'REPLY_SOURCE_INVALID' });
    await assert.rejects(f.store.commit(turn, '其他人偷听', [], { replies: [{ characterId: s.b, characterName: '小舟', text: '听到了' }] }), { code: 'REPLIES_INVALID' });
    await assert.rejects(f.store.commit(turn, reply.text, [], { replies: [reply], entityChanges: [{ op: 'update', entity: { id: s.a, kind: 'npc', name: '阿青', description: '谨慎的抄写员', state: { definition: '新设定覆盖' } } }] }), { code: 'ENTITY_LOCKED' });
    await assert.rejects(f.store.commit(turn, reply.text, [], { replies: [reply], entityChanges: [{ op: 'update', entity: { id: s.a, kind: 'npc', name: '阿青', description: '谨慎的抄写员', state: { lastSettledAt: '2099-01-01' } } }] }), { code: 'ENTITY_INVALID' });
    assert.equal((await f.store.getSession('alice', session.session.id)).messages.length, 1);
    const before = await f.store.getWorld('alice', s.session.worldId);
    await f.store.pool.query('UPDATE worlds SET revision=revision+1 WHERE id=$1', [s.session.worldId]);
    await assert.rejects(f.store.commit(turn, reply.text, [], { replies: [reply], entityChanges: [{ op: 'create', entity: { id: randomUUID(), kind: 'item', name: '不应留下', description: '' } }] }), { code: 'WORLD_CHANGED' });
    assert.equal((await f.store.getWorld('alice', s.session.worldId)).entities?.length, before.entities?.length);
    assert.equal((await f.store.getSession('alice', session.session.id)).messages.length, 1);
  } finally { await f.cleanup(); }
});

test('catch-up freezes real intervals, retries once, and advances only actually processed NPC cursors', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    await f.store.pool.query("UPDATE worlds SET real_anchor_at=clock_timestamp()-interval '2 minutes',clock_world_ms=0,clock_active_ms=0 WHERE id=$1", [s.session.worldId]);
    await f.store.pool.query("UPDATE world_entities SET state=state || jsonb_build_object('lastSettledAt',clock_timestamp()-interval '2 minutes','lastSettledWorldMs',0,'lastSettledActiveMs',0) WHERE world_id=$1 AND kind='npc'", [s.session.worldId]);
    await absentForTwoMinutes(f.store,s.session.worldId);
    const turn = await f.store.beginTurn('alice', s.session.id, 'away', '我回来了。');
    const clocks = turn.input.worldContext!.actorInputs;
    assert(clocks[s.a].worldContext!.temporal!.real.elapsedMs >= 120000);
    const before = (await f.store.pool.query('SELECT real_anchor_at,clock_world_ms FROM worlds WHERE id=$1', [s.session.worldId])).rows[0];
    await f.store.cancelTurn('alice', turn.id);
    const retry = await f.store.beginTurn('alice', s.session.id, 'away', '我回来了。');
    assert.deepEqual(retry.input, turn.input);
    const same = (await f.store.pool.query('SELECT real_anchor_at,clock_world_ms FROM worlds WHERE id=$1', [s.session.worldId])).rows[0]; assert.deepEqual(same, before);
    await assert.rejects(f.store.commit(turn, '迟到', []), { code: 'TURN_LEASE_LOST' });
    const oldB = (await f.store.getWorld('alice', s.session.worldId)).entities!.find(row => row.id === s.b)!.state.lastSettledAt;
    const reply = await actorReply(f.store, retry, 'lin-wan', '回来了。');
    const result = await f.store.commit(retry, reply.text, [], { replies: [reply], activities: [{ characterId: s.a, text: '阿青整理完两页索引。', kind: 'completed', elapsedMs: clocks[s.a].worldContext!.temporal!.real.elapsedMs, elapsedStoryMs:120000,locationId: s.place }] });
    assert.equal(result.world.activities?.length, 1);
    assert.equal(result.world.entities!.find(row => row.id === s.b)!.state.lastSettledAt, oldB);
    assert.equal(result.world.entities!.find(row => row.id === s.a)!.state.lastSettledAt, clocks[s.a].worldContext!.clock.asOf);
    const next = await f.store.previewInput('alice', s.session.id, '继续');
    const applied=resolveStoryTime(next.worldContext!.temporal!,undefined,next.userText,next.turnId);
    assert(settlementWindow(next.worldContext!.actorInputs[s.a].worldContext!.temporal!,applied) < 60000);
    assert(settlementWindow(next.worldContext!.actorInputs[s.b].worldContext!.temporal!,applied) >= 120000);
    assert(!next.worldContext!.actorInputs[s.b].episodes!.some(episode => episode.kind === 'pulse' && episode.replies.some(row => /两页索引/.test(row.text))));
  } finally { await f.cleanup(); }
});

test('short/paused intervals and intervention gates reject invalid pulse results; rate changes preserve prior segments', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const short = await f.store.beginTurn('alice', s.session.id, 'short', '继续');
    await assert.rejects(f.store.commit(short, '回复', [], { activities: [{ characterId: s.a, text: '完成', kind: 'completed', elapsedMs: 1 }] }), { code: 'ACTIVITY_INVALID' });
    await f.store.cancelTurn('alice', short.id);
    await f.store.pool.query("UPDATE worlds SET real_anchor_at=clock_timestamp()-interval '10 seconds',clock_world_ms=0,clock_active_ms=0,clock_rate=2 WHERE id=$1", [s.session.worldId]);
    let world = await f.store.getWorld('alice', s.session.worldId);
    await assert.rejects(f.store.setWorldClock('bob', world.id, world.revision, { mode: 'quiet', rate: 3 }), { code: 'WORLD_NOT_FOUND' });
    await assert.rejects(f.store.setWorldClock('alice', world.id, world.revision - 1, { mode: 'quiet', rate: 3 }), { code: 'WORLD_CHANGED' });
    world = await f.store.setWorldClock('alice', world.id, world.revision, { mode: 'paused', rate: 3 });
    assert.equal(world.clock!.fromWorldMs,0);
    await f.store.pool.query("UPDATE worlds SET real_anchor_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [world.id]);
    const paused = await f.store.beginTurn('alice', s.session.id, 'paused', '继续');
    assert.equal(paused.input.worldContext!.clock.mode, 'paused');
    await assert.rejects(f.store.commit(paused, '回复', [], { activities: [{ characterId: s.a, text: '完成', kind: 'completed', elapsedMs: 1 }] }), { code: 'ACTIVITY_INVALID' });
    await f.store.cancelTurn('alice', paused.id);
    const resumed = await f.store.setWorldClock('alice', world.id, world.revision, { mode: 'active', rate: 3 });
    assert(resumed.clock!.fromWorldMs < 24000);
    await f.store.pool.query("UPDATE worlds SET real_anchor_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [world.id]);
    await absentForTwoMinutes(f.store,world.id);
    const due = await f.store.beginTurn('alice', s.session.id, 'major', '继续');
    const duration = due.input.worldContext!.actorInputs[s.a].worldContext!.temporal!.real.elapsedMs;
    await assert.rejects(f.store.commit(due, '回复', [], { activities: [{ characterId: s.a, text: '重大不可逆变化', kind: 'completed', requiresIntervention: true, elapsedMs: duration,elapsedStoryMs:60000 }] }), { code: 'ACTIVITY_INVALID' });
    const committed = await f.store.commit(due, '请你决定。', [], { activities: [{ characterId: s.a, text: '请介入这个场景', kind: 'invitation', requiresIntervention: true, elapsedMs: duration,elapsedStoryMs:60000 }] });
    assert.equal(committed.world.activities!.at(-1)!.kind, 'invitation');
    assert(committed.world.episodes!.some(episode => episode.kind === 'pulse' && episode.replies[0].text === '待参与邀请，尚未发生：请介入这个场景'));
  } finally { await f.cleanup(); }
});

test('opening plan checkpoint can precede any actor and survives a fenced retry without writing story content', async () => {
  const f = await postgresFixture();
  try {
    const session = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true });
    const turn = await f.store.beginTurn('alice', session.session.id, `opening:${session.session.id}`, '开场', {}, { operation: 'opening' });
    assert.equal(turn.input.worldContext!.clock.elapsedRealMs, 0);
    const checkpoint = { text: '', plan: { updateWorld: true }, mainCallId: 'plan', actorCallId: '', living: { stage: 'planned', replies: [], generatedIds: [randomUUID()] } };
    await f.store.saveCheckpoint(turn, checkpoint);
    await f.store.finish(turn, 'failed', 'FIXTURE', '中断');
    const retry = await f.store.beginTurn('alice', session.session.id, `opening:${session.session.id}`, '开场', {}, { operation: 'opening' });
    assert.deepEqual(retry.checkpoint, checkpoint); assert.equal(retry.draft, null);
    assert.equal((await f.store.getSession('alice', session.session.id)).messages.length, 1);
    assert.equal((await f.store.getWorld('alice', session.session.worldId)).episodes?.length, 0);
    await assert.rejects(f.store.saveCheckpoint(turn, checkpoint), { code: 'TURN_LEASE_LOST' });
    await f.store.commit(retry, '这次完成。', []);
    assert.equal((await f.store.getWorld('alice', session.session.worldId)).episodes?.length, 1);
  } finally { await f.cleanup(); }
});

test('production livingWorld upgrades a legacy session without replaying its welcome or allowing global cast injection', async () => {
  const f = await postgresFixture();
  try {
    const session = await f.store.createSession('alice', 'lin-wan');
    const turn = await f.store.beginTurn('alice', session.session.id, 'old', '请把信给我。');
    await f.store.commit(turn, '这封信不能交给你。她把信收回抽屉。', []);
    const upgraded = new StoryStore(f.store.pool, { livingWorld: true });
    const input = await upgraded.previewInput('alice', session.session.id, '上次的信呢？');
    assert(input.worldContext); assert.deepEqual(input.episodes,[]);
    assert.deepEqual(input.history, []); assert.equal(input.character.greeting, '');
    assert.equal((await upgraded.getSession('alice', session.session.id)).messages.length, 3);
    assert((await readPastDialogue(upgraded,'alice',session.session.id)).some(episode=>episode.userText==='请把信给我。' && episode.replies[0].text.includes('不能交给你')));
    await assert.rejects(upgraded.createSession('alice', 'shen-yan', session.world.id, { dynamicOpening: false }), { code: 'CHARACTER_NOT_FOUND' });
    await assert.rejects(upgraded.beginTurn('alice', session.session.id, `opening:${session.session.id}`, '开场', {}, { operation: 'opening' }), { code: 'OPENING_INVALID' });
  } finally { await f.cleanup(); }
});

test('a current-attempt reused call can authenticate a completed prior actor without duplicating its episode', async () => {
  const f = await postgresFixture();
  try {
    const session = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true });
    const turn = await f.store.beginTurn('alice', session.session.id, 'retry', '继续。');
    const reply = await actorReply(f.store, turn, 'lin-wan', '我还没有答应。');
    await f.store.finish(turn, 'failed', 'UPDATER_FAILED', '更新失败');
    const retry = await f.store.beginTurn('alice', session.session.id, 'retry', '继续。');
    await assert.rejects(f.store.commit(retry, reply.text, [], { replies: [reply] }), { code: 'REPLY_SOURCE_INVALID' });
    await f.store.saveCall(retry, { id: randomUUID(), sourceCallId: reply.callId, parentId: null, attemptId: retry.attempt, agent: 'actor', status: 'reused', model: 'fixture', startedAt: new Date().toISOString(), input: { character: { id: 'lin-wan' } }, output: { text: reply.text } });
    await f.store.commit(retry, reply.text, [], { replies: [reply] });
    const saved = await f.store.getSession('alice', session.session.id);
    assert.equal(saved.messages.length, 2); assert.equal(saved.world.episodes?.length, 1); assert.equal(saved.world.episodes?.[0].replies[0].text, reply.text);
  } finally { await f.cleanup(); }
});

test('withdrawing a memory removes its episode from that actor context without erasing the archive or other listeners', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const turn = await f.store.beginTurn('alice', s.session.id, 'statement', '记录：今天我拒绝签字。');
    const result = await f.store.commit(turn, '林晚收回了表格。', [{ kind: 'event', text: '', visibility: 'private', characterId: 'lin-wan', evidence: { source: 'user', turnId: turn.id } }], { observations: Object.fromEntries(['lin-wan', s.a, s.b].map(id => [id, turn.input.userText])) });
    const memory = result.world.events[0];
    await f.store.setMemoryStatus('alice', s.session.worldId, memory.id, result.world.revision, 'retracted');
    const same = await f.store.previewInput('alice', s.session.id, '继续');
    assert(!(await readPastDialogue(f.store,'alice',s.session.id)).some(episode=>episode.turnId===turn.id)); assert(!same.history.some(row => row.content.includes('拒绝签字')));
    const fresh = await f.store.createSession('alice', 'lin-wan', s.session.worldId, { dynamicOpening: true });
    const future = await f.store.previewInput('alice', fresh.session.id, '继续');
    assert(!(await readPastDialogue(f.store,'alice',fresh.session.id)).some(episode=>episode.turnId===turn.id));
    assert((await readPastDialogue(f.store,'alice',fresh.session.id,s.b)).some(episode=>episode.turnId===turn.id));
    const archive = await f.store.getWorld('alice', s.session.worldId);
    assert(archive.episodes!.some(episode => episode.turnId === turn.id));
    assert((await f.store.getSession('alice', s.session.id)).messages.some(message => message.content.includes('拒绝签字')));
  } finally { await f.cleanup(); }
});

test('explicit scene locations create visible user-sourced records and reuse world names across session creation and editing', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const a = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: ' 大学旧教学楼的教室 ', presentCharacterIds: [s.a], mode: 'direct' } });
    const place = a.world.entities!.find(entity => entity.kind === 'location' && entity.name === '大学旧教学楼的教室')!;
    assert(place); assert.match(place.id, /^[0-9a-f-]{36}$/); assert.equal(place.description, '');
    assert.equal(place.sourceTurnId, 'user-scene'); assert.deepEqual(place.state, { origin: 'user-scene', source: 'user' });
    assert.deepEqual(place.knownByCharacterIds, [s.a]);
    assert.equal((await f.store.pool.query('SELECT source_turn_id FROM world_entities WHERE world_id=$1 AND id=$2', [s.session.worldId, place.id])).rows[0].source_turn_id, null);
    const packet = await f.store.previewInput('alice', a.session.id, '看看教室。');
    assert(packet.worldContext!.entities.some(entity => entity.id === place.id));
    assert(!packet.worldContext!.actorInputs[s.b].worldContext!.entities.some(entity => entity.id === place.id));
    const [b, again] = await Promise.all([
      f.store.createSession('alice', s.b, s.session.worldId, { dynamicOpening: true, scene: { location: place.name, presentCharacterIds: [s.b], mode: 'direct' } }),
      f.peer().createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: place.name, presentCharacterIds: [s.a], mode: 'direct' } }),
    ]);
    assert(b.world.entities!.some(entity => entity.id === place.id)); assert(again.world.entities!.some(entity => entity.id === place.id));
    let world = await f.store.getWorld('alice', s.session.worldId);
    assert.equal(world.entities!.filter(entity => entity.kind === 'location' && entity.name === place.name).length, 1);
    assert.deepEqual(new Set(world.entities!.find(entity => entity.id === place.id)!.knownByCharacterIds), new Set([s.a, s.b]));
    world = await f.store.setScene('alice', world.id, world.revision, { location: place.id, presentCharacterIds: ['lin-wan'], mode: 'direct' }, s.session.id);
    assert.equal(world.entities!.filter(entity => entity.kind === 'location').length, 2);
    assert(world.entities!.find(entity => entity.id === place.id)!.knownByCharacterIds.includes('lin-wan'));
    world = await f.store.setScene('alice', world.id, world.revision, { location: '大学侧门', presentCharacterIds: ['lin-wan'], mode: 'direct' }, s.session.id);
    assert.equal(world.entities!.filter(entity => entity.kind === 'location').length, 3);
    await assert.rejects(f.store.setScene('alice', world.id, world.revision - 1, { location: '冲突不应留下', presentCharacterIds: ['lin-wan'] }), { code: 'WORLD_CHANGED' });
    await assert.rejects(f.store.setScene('bob', world.id, world.revision, { location: '越权不应留下', presentCharacterIds: ['lin-wan'] }), { code: 'WORLD_NOT_FOUND' });
    assert.equal((await f.store.getWorld('alice', world.id)).entities!.filter(entity => entity.kind === 'location').length, 3);
    const otherWorld = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true, scene: { location: place.name, presentCharacterIds: ['lin-wan'], mode: 'ensemble' } });
    assert.notEqual(otherWorld.world.entities!.find(entity => entity.kind === 'location')!.id, place.id);
    const busy = await f.store.beginTurn('alice', s.session.id, 'busy-place', '继续');
    await assert.rejects(f.store.setScene('alice', world.id, world.revision, { location: '忙碌不应留下', presentCharacterIds: ['lin-wan'] }), { code: 'WORLD_BUSY' });
    await f.store.cancelTurn('alice', busy.id);
  } finally { await f.cleanup(); }
});

test('scene location capacity checks roll back the scene but allow an existing place at the limit', async () => {
  const f = await postgresFixture();
  try {
    const session = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true, scene: { location: '原地点', presentCharacterIds: ['lin-wan'], mode: 'direct' } });
    await f.store.pool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,known_by_character_ids) SELECT 'alice',$1,'capacity-'||n,'item','物品'||n,'',ARRAY['lin-wan'] FROM generate_series(1,254) n", [session.world.id]);
    const reused = await f.store.setScene('alice', session.world.id, session.world.revision, { location: '原地点', presentCharacterIds: ['lin-wan'], mode: 'direct' }, session.session.id);
    await assert.rejects(f.store.setScene('alice', session.world.id, reused.revision, { location: '不能创建', presentCharacterIds: ['lin-wan'], mode: 'direct' }, session.session.id), { code: 'WORLD_ENTITY_LIMIT' });
    const unchanged = await f.store.getSession('alice', session.session.id);
    assert.equal(unchanged.world.revision, reused.revision); assert.equal(unchanged.world.scene?.location, '原地点');
    assert.equal(unchanged.world.entities?.length, 256);
  } finally { await f.cleanup(); }
});

test('confirmed scenes place only their actual audience and teach newly present NPCs the location', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    for (const id of ['lin-wan', s.a, s.b]) {
      assert.equal(s.result.world.entities!.find(entity => entity.id === id)!.state.locationId, s.place);
      assert(s.result.world.entities!.find(entity => entity.id === s.place)!.knownByCharacterIds.includes(id));
    }
    const privateSession = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: '教室', presentCharacterIds: [s.a, s.b], mode: 'direct' } });
    const classroom = privateSession.world.entities!.find(entity => entity.kind === 'location' && entity.name === '教室')!;
    assert.equal(privateSession.world.entities!.find(entity => entity.id === s.a)!.state.locationId, classroom.id);
    assert.equal(privateSession.world.entities!.find(entity => entity.id === s.b)!.state.locationId, s.place);
    assert.deepEqual(classroom.knownByCharacterIds, [s.a]);
    const world = await f.store.setScene('alice', s.session.worldId, privateSession.world.revision, { location: classroom.id, presentCharacterIds: ['lin-wan'], mode: 'ensemble' }, s.session.id);
    assert.equal(world.entities!.find(entity => entity.id === 'lin-wan')!.state.locationId, classroom.id);
    assert.equal(world.entities!.find(entity => entity.id === s.b)!.state.locationId, s.place);
    const turn = await f.store.beginTurn('alice', s.session.id, 'new-arrival', '一名同学走进教室。');
    const npc = randomUUID();
    await assert.rejects(f.store.commit(turn, '回答', [], { entityChanges: [{ op: 'update', entity: { id: 'lin-wan', kind: 'npc', name: '林晚', description: turn.input.character.description, state: { locationId: s.place } } }] }), { code: 'ENTITY_INVALID' });
    const result = await f.store.commit(turn, '林晚把桌边让开。', [], {
      entityChanges: [{ op: 'create', entity: { id: npc, kind: 'npc', name: '程叶', description: '刚走入教室的同学。' } }],
      scene: { location: classroom.name, presentCharacterIds: ['lin-wan', npc], mode: 'ensemble' },
    });
    assert.equal(result.world.entities!.find(entity => entity.id === npc)!.state.locationId, classroom.id);
    assert(result.world.entities!.find(entity => entity.id === classroom.id)!.knownByCharacterIds.includes(npc));
    assert.equal(result.world.entities!.find(entity => entity.id === s.b)!.state.locationId, s.place);
    const next = await f.store.previewInput('alice', s.session.id, '继续');
    assert(next.worldContext!.actorInputs[npc].worldContext!.entities.some(entity => entity.id === classroom.id));
    const conflicting = await f.store.beginTurn('alice', s.session.id, 'conflicting-move', '去阅览室');
    await f.store.pool.query('UPDATE worlds SET revision=revision+1 WHERE id=$1', [s.session.worldId]);
    await assert.rejects(f.store.commit(conflicting, '走吧。', [], { scene: { location: s.place, presentCharacterIds: ['lin-wan', npc], mode: 'ensemble' } }), { code: 'WORLD_CHANGED' });
    assert.equal((await f.store.getWorld('alice', s.session.worldId)).entities!.find(entity => entity.id === npc)!.state.locationId, classroom.id);
  } finally { await f.cleanup(); }
});

test('completed catch-up activities must match the frozen known location, and unknown positions permit only invitations', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const foreign = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true, scene: { location: '另一个世界', presentCharacterIds: ['lin-wan'] } });
    const foreignPlace = foreign.world.entities!.find(entity => entity.kind === 'location')!.id;
    const elsewhere = await f.store.setScene('alice', s.session.worldId, s.result.world.revision, { location: '教室', presentCharacterIds: ['lin-wan'], mode: 'direct' }, s.session.id);
    const classroom = elsewhere.entities!.find(entity => entity.kind === 'location' && entity.name === '教室')!.id;
    await f.store.pool.query("UPDATE worlds SET real_anchor_at=clock_timestamp()-interval '2 minutes',clock_world_ms=0,clock_active_ms=0 WHERE id=$1", [s.session.worldId]);
    await f.store.pool.query("UPDATE world_entities SET state=state || jsonb_build_object('lastSettledAt',clock_timestamp()-interval '2 minutes','lastSettledWorldMs',0,'lastSettledActiveMs',0) WHERE world_id=$1 AND kind='npc'", [s.session.worldId]);
    await absentForTwoMinutes(f.store,s.session.worldId);
    const turn = await f.store.beginTurn('alice', s.session.id, 'location-proof', '继续');
    const base = { characterId: s.a, text: '在阅览室整理好了两页索引。', kind: 'completed' as const, elapsedMs: 60000,elapsedStoryMs:60000 };
    for (const locationId of [undefined, classroom, foreignPlace]) await assert.rejects(f.store.commit(turn, '回答', [], { activities: [{ ...base, locationId }] }), { code: 'ACTIVITY_INVALID' });
    assert.equal((await f.store.getTurn('alice', turn.id)).status, 'running');
    assert.equal((await f.store.getSession('alice', s.session.id)).messages.filter(message => message.turnId === turn.id).length, 1);
    // Offline work uses the frozen location even if the online scene moves the focus afterwards.
    const result = await f.store.commit(turn, '林晚回到阅览室。', [], { scene: { location: s.place, presentCharacterIds: ['lin-wan'], mode: 'direct' }, activities: [{ ...base, locationId: s.place }] });
    assert.equal(result.world.activities!.at(-1)!.locationId, s.place);
    assert.equal(result.world.entities!.find(entity => entity.id === 'lin-wan')!.state.locationId, s.place);
    await f.store.pool.query("UPDATE world_entities SET state=(state-'locationId') || jsonb_build_object('lastSettledAt',clock_timestamp()-interval '2 minutes','lastSettledActiveMs',0,'lastSettledWorldMs',0) WHERE world_id=$1 AND id=$2", [s.session.worldId, s.b]);
    await absentForTwoMinutes(f.store,s.session.worldId);
    const unknown = await f.store.beginTurn('alice', s.session.id, 'unknown-position', '继续');
    await assert.rejects(f.store.commit(unknown, '回答', [], { activities: [{ ...base, characterId: s.b, locationId: s.place }] }), { code: 'ACTIVITY_INVALID' });
    const invitation = await f.store.commit(unknown, '先等他回来。', [], { activities: [{ characterId: s.b, text: '是否前往阅览室尚未确认。', kind: 'invitation', elapsedMs: 60000,elapsedStoryMs:60000, requiresIntervention: true }] });
    assert.equal(invitation.world.activities!.at(-1)!.kind, 'invitation');
    assert.equal(invitation.world.entities!.find(entity => entity.id === s.b)!.state.locationId, undefined);
  } finally { await f.cleanup(); }
});

test('private NPC growth stays with its subject and cannot write secrets into an absent acquaintance', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const secret = '只有阿青知道：银色钥匙藏在暗格中。';
    const privateSession = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: '阅览室', presentCharacterIds: [s.a, s.b], mode: 'direct' } });
    const turn = await f.store.beginTurn('alice', privateSession.session.id, 'private-growth', secret);
    await assert.rejects(f.store.commit(turn, '我会保密。', [], { entityChanges: [{ op: 'update', entity: { id: s.b, kind: 'npc', name: '小舟', description: '送信人', state: { arc: secret } } }] }), { code: 'KNOWLEDGE_SCOPE' });
    assert.equal((await f.store.getTurn('alice', turn.id)).status, 'running');
    assert.equal((await f.store.getSession('alice', privateSession.session.id)).messages.length, 1);
    const committed = await f.store.commit(turn, '我会保密。', [], { entityChanges: [{ op: 'update', entity: { id: s.a, kind: 'npc', name: '阿青', description: '谨慎的抄写员', state: { arc: secret } } }] });
    assert.equal(committed.world.entities!.find(entity => entity.id === s.a)!.state.arc, secret);
    assert.equal(committed.world.entities!.find(entity => entity.id === s.b)!.state.arc, undefined);
    assert(committed.world.entities!.find(entity => entity.id === s.a)!.knownByCharacterIds.includes(s.b));
    const own = await f.store.previewInput('alice', privateSession.session.id, '你记得吗？');
    assert.equal((own.worldContext!.entities.find(entity => entity.id === s.a)!.state.characterView as { summary: string }).summary, secret);
    assert(!JSON.stringify(own.worldContext!.actorInputs[s.b]).includes('银色钥匙'));
    const otherSession = await f.store.createSession('alice', s.b, s.session.worldId, { dynamicOpening: true, scene: { location: '阅览室', presentCharacterIds: [s.b], mode: 'direct' } });
    const other = await f.store.previewInput('alice', otherSession.session.id, '你了解阿青吗？');
    const acquaintance = other.worldContext!.entities.find(entity => entity.id === s.a)!;
    assert.equal(acquaintance.name, '阿青'); assert.equal(acquaintance.state.arc, undefined);
    assert(!JSON.stringify({ ...other, worldContext: { ...other.worldContext, actorInputs: {} } }).includes('银色钥匙'));
  } finally { await f.cleanup(); }
});

test('legacy sessions upgraded to living inputs enforce the same private growth read and write scope', async () => {
  const f = await postgresFixture();
  try {
    const a = await f.store.createSession('alice', 'lin-wan');
    const b = await f.store.createSession('alice', 'shen-yan', a.world.id);
    await f.store.pool.query("UPDATE world_entities SET known_by_character_ids=ARRAY['lin-wan','shen-yan'] WHERE world_id=$1 AND kind='npc'", [a.world.id]);
    await f.store.pool.query(`INSERT INTO world_entity_knowledge(owner_id,world_id,character_id,entity_id,version,snapshot)
      SELECT e.owner_id,e.world_id,n.id,e.id,e.version,to_jsonb(e) FROM world_entities e JOIN world_entities n ON n.world_id=e.world_id AND n.kind='npc'
      WHERE e.world_id=$1 ON CONFLICT(world_id,character_id,entity_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,version=EXCLUDED.version`,[a.world.id]);
    const upgraded = new StoryStore(f.store.pool, { livingWorld: true });
    const world = await upgraded.getWorld('alice', a.world.id);
    await upgraded.setScene('alice', world.id, world.revision, { location: null, presentCharacterIds: ['lin-wan'], mode: 'direct' }, a.session.id);
    const turn = await upgraded.beginTurn('alice', a.session.id, 'old-private-growth', '秘密：暗号是五月蓝。');
    const shen = world.entities!.find(entity => entity.id === 'shen-yan')!;
    await assert.rejects(upgraded.commit(turn, '我记下了。', [], { entityChanges: [{ op: 'update', entity: { id: shen.id, kind: 'npc', name: shen.name, description: shen.description, state: { arc: '暗号是五月蓝' } } }] }), { code: 'KNOWLEDGE_SCOPE' });
    const lin = world.entities!.find(entity => entity.id === 'lin-wan')!;
    await upgraded.commit(turn, '我记下了。', [], { entityChanges: [{ op: 'update', entity: { id: lin.id, kind: 'npc', name: lin.name, description: lin.description, state: { arc: '暗号是五月蓝' } } }] });
    const own = await upgraded.previewInput('alice', a.session.id, '还记得吗？');
    assert.equal((own.worldContext!.entities.find(entity => entity.id === lin.id)!.state.characterView as { summary: string }).summary, '暗号是五月蓝');
    const latest = await upgraded.getWorld('alice', world.id);
    await upgraded.setScene('alice', world.id, latest.revision, { location: null, presentCharacterIds: ['shen-yan'], mode: 'direct' }, b.session.id);
    const other = await upgraded.previewInput('alice', b.session.id, '继续');
    assert(other.worldContext!.entities.some(entity => entity.id === lin.id));
    assert(!JSON.stringify({ ...other, worldContext: { ...other.worldContext, actorInputs: {} } }).includes('五月蓝'));
  } finally { await f.cleanup(); }
});

test('shared non-NPC records cannot broadcast private updates to absent prior readers', async () => {
  const f = await postgresFixture();
  try {
    const s = await opened(f.store);
    const shared = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: '阅览室', presentCharacterIds: [s.a, s.b], mode: 'ensemble' } });
    const definitions: EntityChange['entity'][] = [
      { id: randomUUID(), kind: 'item', name: '共用铜盒', description: '两人都见过的盒子。', state: { status: '未开启' } },
      { id: randomUUID(), kind: 'location', name: '旧仓房', description: '两人都知道的地点。', state: {} },
      { id: randomUUID(), kind: 'quest', name: '核对名册', description: '两人共同参与的任务。', state: { status: 'active' } },
      { id: randomUUID(), kind: 'faction', name: '名册小组', description: '两人知道的小组。', state: {} },
    ];
    const setup = await f.store.beginTurn('alice', shared.session.id, 'shared-records', '记录我们共同知道的四项资料。');
    await f.store.commit(setup, '我们一起核对。', [], { entityChanges: definitions.map(entity => ({ op: 'create', entity })) });
    const privateSession = await f.store.createSession('alice', s.a, s.session.worldId, { dynamicOpening: true, scene: { location: '阅览室', presentCharacterIds: [s.a, s.b], mode: 'direct' } });
    const secret = '私密暗号：五月蓝';
    const turn = await f.store.beginTurn('alice', privateSession.session.id, 'private-shared-update', secret);
    await f.store.commit(turn, '我会保密。', [], { observations: { [s.a]: secret },entityChanges:definitions.map(entity=>({op:'update' as const,witnessedByCharacterIds:[s.a],entity:{...entity,state:entity.kind==='item'?{status:secret}:entity.kind==='quest'?{result:secret}:{arc:secret}}})) });
    const privateInput = await f.store.previewInput('alice', privateSession.session.id, '继续');
    assert((await readPastDialogue(f.store,'alice',privateSession.session.id,s.a)).some(episode=>episode.userText===secret));
    assert(!JSON.stringify(privateInput.worldContext!.actorInputs[s.b]).includes('五月蓝'));
    const archive = await f.store.getWorld('alice', s.session.worldId);
    assert(JSON.stringify(archive.entities).includes('五月蓝'));
    const publicTurn = await f.store.beginTurn('alice', shared.session.id, 'shared-safe-update', '在双方在场时完成共同编号。');
    const updated = await f.store.commit(publicTurn, '两人一起记下编号。', [], { entityChanges: definitions.map(entity => ({ op: 'update', entity: { ...entity, state: entity.kind === 'item' ? { status: '已编号' } : entity.kind === 'quest' ? { status: 'active', result: '共同核对中' } : { arc: '已共同编号' } } })) });
    for (const entity of definitions) assert.deepEqual(new Set(updated.world.entities!.find(row => row.id === entity.id)!.knownByCharacterIds), new Set([s.a, s.b]));
  } finally { await f.cleanup(); }
});


test('co-present identities do not leak the seed persona and every actor packet has an authorized entity audience',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  await f.migrationPool.query("UPDATE characters SET description='私密设定：秘密身份为夜行者',definition='秘密身份为夜行者' WHERE id='lin-wan'");
  const s=await opened(f.store);
  const packet=(await f.store.previewInput('alice',s.session.id,'你好')).worldContext!.actorInputs[s.a];
  assert(packet.worldContext!.entities.every(e=>e.knownByCharacterIds.includes(s.a)));
  const seen=packet.worldContext!.entities.find(e=>e.id==='lin-wan')!;
  assert.equal(seen.name,'林晚');assert.equal(seen.description,'');
  assert(!JSON.stringify(seen).includes('夜行者'));
  // Legacy co-presence rows could have copied the full private persona: reads must repair visibility.
  await f.migrationPool.query(`UPDATE world_entity_knowledge k SET snapshot=to_jsonb(e) FROM world_entities e WHERE k.world_id=$1 AND k.character_id=$2 AND k.entity_id='lin-wan' AND e.world_id=k.world_id AND e.id=k.entity_id`,[s.session.worldId,s.a]);
  const legacy=(await f.store.previewInput('alice',s.session.id,'继续')).worldContext!.actorInputs[s.a];
  assert(legacy.worldContext!.entities.every(e=>e.knownByCharacterIds.includes(s.a)));
  assert(!JSON.stringify(legacy.worldContext!.entities.find(e=>e.id==='lin-wan')).includes('夜行者'));
 }finally{await f.cleanup();}
});
