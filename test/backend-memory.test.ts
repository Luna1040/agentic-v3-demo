import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { postgresFixture } from './pg-helper.ts';
import { MEMORY_POLICY, validateChanges, type ActorInput, type StoryRuntime, type WorldChange } from '../server/runtime.ts';
import { TurnService } from '../server/turn-service.ts';
import { createApp } from '../server/app.ts';
import type { TurnEvent } from '../shared/contracts.ts';

const status: StoryRuntime['status'] = { provider: 'demo', model: 'fake', harness: { loaded: true, version: 'test' }, offlineSimulation: false };
function candidate(input: ActorInput, kind: WorldChange['kind'] = 'event'): WorldChange {
  return { kind, text: '你每次都来过这里，我们去年结婚了。', visibility: 'private', characterId: input.character.id, evidence: { source: 'user', turnId: input.turnId } };
}

test('all memory kinds require this user turn and retain the entire original including denial, quotes and whitespace', () => {
  const input: ActorInput = { turnId: randomUUID(), character: { id: 'lin-wan', name: '林晚', description: '', greeting: '' }, userText: '  我没说我们去年结婚了。“如果结婚”只是假设。\n', history: [], world: { id: randomUUID(), revision: 0, events: [] } };
  for (const kind of ['event', 'fact', 'relationship'] as const) {
    const proposed = candidate(input, kind);
    assert.deepEqual(validateChanges([proposed], input), [{ ...proposed, text: input.userText }]);
    assert.deepEqual(validateChanges([{ ...proposed, evidence: undefined }], input), []);
    assert.deepEqual(validateChanges([{ ...proposed, evidence: { source: 'assistant', turnId: input.turnId } }], input), []);
    assert.deepEqual(validateChanges([{ ...proposed, evidence: { source: 'user', turnId: randomUUID() } }], input), []);
  }
  assert.equal(validateChanges([candidate(input, 'event'), candidate(input, 'fact'), candidate(input, 'relationship')], input).length, 1);
  const mixed = { ...input, userText: '告诉大家我明天去广场。只告诉你：钥匙藏在地毯下面。' };
  assert.equal(validateChanges([{ ...candidate(mixed), visibility: 'public' }], mixed)[0].visibility, 'private');
  assert.equal(validateChanges([candidate(input)], { ...input, userText: '字'.repeat(8000) })[0].text.length, 8000);
  assert.deepEqual(validateChanges([candidate(input)], { ...input, userText: '字'.repeat(8001) }), []);
});

test('commit revalidates against the database input rather than a caller-mutated turn snapshot', async () => {
  const f = await postgresFixture();
  try {
    const session = await f.store.createSession('alice', 'lin-wan');
    const turn = await f.store.beginTurn('alice', session.session.id, 'source', '只想安静坐一会儿。');
    const forged = { ...turn, input: { ...turn.input, userText: '我们每周都来。' } };
    const result = await f.store.commit(forged, '角色自然陪坐。', [candidate(forged.input)]);
    assert.equal(result.world.events.length, 1);
    assert.equal(result.world.events[0].text, '只想安静坐一会儿。');
    assert.equal(result.world.events[0].status, 'active');
    assert.deepEqual(result.world.events[0].evidence, { source: 'user', turnId: turn.id });
    const preview = await f.store.previewInput('alice', session.session.id, '然后呢');
    assert.deepEqual(preview.world.events[0].evidence, { source: 'user', turnId: turn.id });
    assert(!JSON.stringify(preview.world.events).includes('每周'));
  } finally { await f.cleanup(); }
});

test('discarding every unsupported memory still commits the complete roleplay reply without another model call', async () => {
  const f = await postgresFixture(); let calls = 0;
  const runtime: StoryRuntime = { status, actor: async () => { throw new Error('unexpected fallback'); }, updateWorld: async () => { throw new Error('unexpected fallback'); },
    runTurn: async input => { calls++; return { text: '他把笔轻轻放下，安静地坐在你身边。', changes: [{ ...candidate(input), evidence: undefined }], usage: {} }; } };
  const service = new TurnService(f.store, runtime);
  try {
    const session = await f.store.createSession('alice', 'lin-wan'); const turn = await f.store.beginTurn('alice', session.session.id, 'unsupported', '先别讲题。');
    const events: TurnEvent[] = []; await service.run(turn, event => events.push(event));
    assert.equal(events.at(-1)?.type, 'committed'); assert.equal(calls, 1);
    const current = await f.store.getSession('alice', session.session.id);
    assert.equal(current.world.events.length, 0); assert.equal(current.messages.at(-1)?.content, '他把笔轻轻放下，安静地坐在你身边。');
  } finally { await service.shutdown(); await f.cleanup(); }
});

test('unverified records cannot hide active memories from model context or its management view', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const session = await store.createSession('alice', 'lin-wan');
    const valid = await store.beginTurn('alice', session.session.id, 'valid', '暗号是晚风。');
    await store.commit(valid, '好。', [candidate(valid.input)]);
    const old = await store.beginTurn('alice', session.session.id, 'old', '当时的原话'); await store.commit(old, '旧正文', []);
    for (let i = 0; i < 105; i++) await store.pool.query("INSERT INTO events(id,owner_id,world_id,kind,text,visibility,character_id,source_turn_id) VALUES($1,'alice',$2,'event',$3,'private','lin-wan',$4)", [randomUUID(), session.world.id, `未验证旧摘要${i}`, old.id]);
    const mismatch = await store.beginTurn('alice', session.session.id, 'mismatch', '不可替换原话'); await store.commit(mismatch, '好', []);
    await store.pool.query("INSERT INTO events(id,owner_id,world_id,kind,text,visibility,character_id,source_turn_id,evidence,status) VALUES($1,'alice',$2,'event','伪造摘要','private','lin-wan',$3,$4,'active')", [randomUUID(), session.world.id, mismatch.id, { source: 'user', turnId: mismatch.id }]);
    const large = await store.beginTurn('alice', session.session.id, 'large', '长'.repeat(8000)); await store.commit(large, '好', [candidate(large.input)]);
    const preview = await store.previewInput('alice', session.session.id, '记忆');
    assert.deepEqual(preview.world.events.map(event => event.text), ['暗号是晚风。', '长'.repeat(8000)]);
    const next = await store.beginTurn('alice', session.session.id, 'next', '记忆');
    assert.deepEqual(next.input.world.events, preview.world.events);
    const world = (await store.getSession('alice', session.session.id)).world;
    assert.equal(world.events.some(event => event.status === 'unverified'), true);
    assert.equal(world.events.some(event => event.sourceTurnId === valid.id && event.status === 'active'), true);
    assert.equal(world.events.some(event => event.sourceTurnId === large.id && event.status === 'active'), true);
    assert.equal(world.events.length, 102);
  } finally { await f.cleanup(); }
});

test('an intact 8000-character user memory reaches a fresh session and takes precedence over whole history turns', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const source = await store.createSession('alice', 'lin-wan');
    const original = '并不是我们去年去过那里。' + '回'.repeat(8000 - '并不是我们去年去过那里。'.length);
    const saved = await store.beginTurn('alice', source.session.id, 'long-memory', original);
    await store.commit(saved, '我记住你说的是“并不是”。', [candidate(saved.input)]);
    const fresh = await store.createSession('alice', 'lin-wan', source.world.id);
    const restored = await store.previewInput('alice', fresh.session.id, '我之前说过什么？');
    assert.equal(restored.world.events[0].text, original);
    assert(!restored.history.some(message => message.content === original));
    assert(JSON.stringify(restored).length <= 23000);

    for (let index = 0; index < 5; index++) {
      const turn = await store.beginTurn('alice', fresh.session.id, `history-${index}`, `用户${index}:` + '问'.repeat(496));
      await store.commit(turn, `角色${index}:` + '答'.repeat(496), []);
    }
    await f.migrationPool.query("UPDATE characters SET definition=$1,description=$2,greeting=$2 WHERE id='lin-wan'", ['设'.repeat(7000), '简'.repeat(1000)]);
    const full = await store.previewInput('alice', fresh.session.id, '问'.repeat(4000));
    assert.equal(full.world.events[0].text, original);
    assert(full.history.length < 10); assert.equal(full.history.length % 2, 0);
    if (full.history.length) assert(full.history.at(-1)?.content.startsWith('角色4:'));
    assert.equal(full.userText.length, 4000); assert.equal(full.character.definition?.length, 7000);
    assert(JSON.stringify(full).length <= 23000);

    const constrained = await store.previewInput('alice', fresh.session.id, '问'.repeat(8000));
    assert.equal(constrained.world.events.length, 0);
    assert.equal(constrained.userText.length, 8000); assert(JSON.stringify(constrained).length <= 23000);
    assert.equal((await store.getSession('alice', fresh.session.id)).world.events[0].text, original);
  } finally { await f.cleanup(); }
});

test('memory withdrawal is owner-scoped, world-locked and revision-checked; only verified memory can be restored', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const session = await store.createSession('alice', 'lin-wan'); const turn = await store.beginTurn('alice', session.session.id, 'one', '用户明确说过的话');
    const committed = await store.commit(turn, '回复', [candidate(turn.input)]); const memory = committed.world.events[0];
    await assert.rejects(store.setMemoryStatus('bob', session.world.id, memory.id, 1, 'retracted'), { code: 'WORLD_NOT_FOUND' });
    await assert.rejects(store.setMemoryStatus('alice', session.world.id, memory.id, 0, 'retracted'), { code: 'WORLD_CHANGED' });
    const other = await store.createSession('alice', 'lin-wan');
    await assert.rejects(store.setMemoryStatus('alice', other.world.id, memory.id, 0, 'retracted'), { code: 'MEMORY_NOT_FOUND' });
    const pending = await store.beginTurn('alice', session.session.id, 'pending', '尚未完成');
    await assert.rejects(store.setMemoryStatus('alice', session.world.id, memory.id, 1, 'retracted'), { code: 'WORLD_BUSY' });
    await store.finish(pending, 'failed', 'TEST', 'fixture');
    const withdrawn = await store.setMemoryStatus('alice', session.world.id, memory.id, 1, 'retracted');
    assert.equal(withdrawn.revision, 2); assert.equal(withdrawn.events[0].status, 'retracted');
    assert.equal((await store.previewInput('alice', session.session.id, '查看')).world.events.length, 0);
    await assert.rejects(store.beginTurn('alice', session.session.id, 'pending', '尚未完成'), { code: 'WORLD_CHANGED' });
    assert.equal((await store.setMemoryStatus('alice', session.world.id, memory.id, 2, 'active')).revision, 3);
    assert.equal((await store.previewInput('alice', session.session.id, '查看')).world.events.length, 1);
    const oldId = randomUUID(); await store.pool.query("INSERT INTO events(id,owner_id,world_id,kind,text,visibility,character_id,source_turn_id) VALUES($1,'alice',$2,'event','旧摘要','private','lin-wan',$3)", [oldId, session.world.id, turn.id]);
    await assert.rejects(store.setMemoryStatus('alice', session.world.id, oldId, 3, 'active'), { code: 'MEMORY_UNVERIFIED' });
    await store.setMemoryStatus('alice', session.world.id, oldId, 3, 'retracted');
    await assert.rejects(store.setMemoryStatus('alice', session.world.id, oldId, 4, 'active'), { code: 'MEMORY_UNVERIFIED' });
  } finally { await f.cleanup(); }
});

test('pre-policy failed drafts cannot resume under the new memory rules', async () => {
  const f = await postgresFixture();
  try {
    const session = await f.store.createSession('alice', 'lin-wan'); const turn = await f.store.beginTurn('alice', session.session.id, 'old-policy', '原话');
    assert.equal(turn.runtimeMetadata.memoryPolicy, MEMORY_POLICY);
    await f.store.saveDraft(turn, '旧正文');
    await f.store.pool.query("UPDATE turns SET runtime_metadata=runtime_metadata-'memoryPolicy' WHERE id=$1", [turn.id]);
    await assert.rejects(f.store.commit(turn, '旧正文', [candidate(turn.input)]), { code: 'RUNTIME_CHANGED' });
    await f.store.finish(turn, 'failed', 'TEST', 'fixture');
    await assert.rejects(f.store.beginTurn('alice', session.session.id, 'old-policy', '原话'), { code: 'RUNTIME_CHANGED' });
  } finally { await f.cleanup(); }
});

test('memory PATCH validates requests and enforces the same authorization and CAS as the store', async () => {
  const f = await postgresFixture();
  const runtime: StoryRuntime = { status, actor: async () => ({ text: 'unused' }), updateWorld: async () => ({ changes: [] }) };
  const app = createApp({ store: f.store, runtime, authenticate: req => req.get('x-test-owner') ?? 'alice' });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const session = await f.store.createSession('alice', 'lin-wan'); const turn = await f.store.beginTurn('alice', session.session.id, 'http', '原话');
    const saved = await f.store.commit(turn, '回复', [candidate(turn.input)]);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/worlds/${session.world.id}/events/${saved.world.events[0].id}`;
    const patch = (body: unknown, owner = 'alice') => fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(body) });
    assert.equal((await patch({ expectedRevision: 1, status: 'active' }, 'bob')).status, 404);
    assert.equal((await patch({ expectedRevision: 1, status: 'unverified' })).status, 422);
    const response = await patch({ expectedRevision: 1, status: 'retracted' }); assert.equal(response.status, 200);
    const world = await response.json(); assert.equal(world.revision, 2); assert.equal(world.events[0].status, 'retracted');
    assert.equal((await patch({ expectedRevision: 1, status: 'active' })).status, 409);
  } finally { await app.locals.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
