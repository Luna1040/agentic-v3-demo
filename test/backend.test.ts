import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { StoryStore } from '../server/store.ts';
import { TurnService } from '../server/turn-service.ts';
import { migrate } from '../server/migrations/index.ts';
import { MEMORY_POLICY, validateChanges, type StoryRuntime, type ActorInput } from '../server/runtime.ts';
import type { TurnEvent, SessionDetail } from '../shared/contracts.ts';
import { postgresFixture } from './pg-helper.ts';

const status: StoryRuntime['status'] = { provider: 'demo', model: 'test-fake', harness: { loaded: true, version: 'test' }, offlineSimulation: false };
function runtime(overrides: Partial<StoryRuntime> = {}): StoryRuntime {
  return { status, metadata: { runtimeFingerprint: 'fixture-v1' }, actor: async (_input, { onTextDelta }) => { onTextDelta('Hello'); onTextDelta(' world\n'); return { text: 'Hello world\n' }; }, updateWorld: async () => ({ changes: [] }), ...overrides };
}
function events(body: string): TurnEvent[] { return body.split('\n\n').filter((block) => block.startsWith('event:')).map((block) => JSON.parse(block.split('\ndata: ')[1])); }
async function fixture(work: (f: { store: StoryStore; app: ReturnType<typeof createApp>; base: string; session: SessionDetail; post: (path: string, body?: unknown, owner?: string) => Promise<Response> }) => Promise<void>, model = runtime()) {
  const database = await postgresFixture();
  const { store } = database;
  const app = createApp({ store, runtime: model, authenticate: (request) => request.get('x-test-owner') ?? 'alice' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}, owner = 'alice') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(body) });
  try { await work({ store, app, base, session: await store.createSession('alice', 'lin-wan'), post }); }
  finally { await app.locals.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await database.cleanup(); }
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  assert.fail('State did not settle');
}

test('SSE preserves raw whitespace; atomic commit and same-ID replay persist metadata and known usage', async () => {
  let actors = 0; let updates = 0;
  await fixture(async ({ session, post, store }) => {
    const path = `/api/sessions/${session.session.id}/turns`;
    const first = events(await (await post(path, { clientTurnId: 'stable', content: '记住暗号' })).text());
    assert.equal(first[0].type, 'accepted');
    assert.equal(first.filter((event) => event.type === 'delta').map((event) => event.text).join(''), 'Hello world\n');
    const last = first.at(-1); if (last?.type !== 'committed') assert.fail('missing commit');
    assert.equal(last.world.revision, 1); assert.equal(last.world.events.length, 1);
    const saved = await store.storedTurn('alice', last.turnId);
    assert.deepEqual(saved.runtimeMetadata, { runtimeFingerprint: 'fixture-v1', memoryPolicy: MEMORY_POLICY });
    assert.deepEqual(saved.usage, { actor: { inputTokens: 13, outputTokens: 4, totalTokens: 17 }, updater: { totalTokens: 8 } });
    const replay = events(await (await post(path, { clientTurnId: 'stable', content: '记住暗号' })).text());
    assert.deepEqual(replay.map((event) => event.type), ['accepted', 'committed']);
    assert.equal(actors, 1); assert.equal(updates, 1);
    assert.equal((await store.getSession('alice', session.session.id)).messages.length, 3);
    assert.equal((await post(path, { clientTurnId: 'stable', content: '不同正文' })).status, 409);
    assert.equal((await store.beginTurn('alice', session.session.id, 'stable', '记住暗号', { runtimeFingerprint: 'v2' })).status, 'committed');
  }, runtime({ actor: async (_input, options) => { actors++; options.onTextDelta('Hello'); options.onTextDelta(' world\n'); return { text: 'Hello world\n', usage: { inputTokens: 13, outputTokens: 4, totalTokens: 17 } }; }, updateWorld: async (input) => { updates++; return { changes: [{ kind: 'fact', text: '用户告诉林晚一个暗号。', visibility: 'private', characterId: input.character.id, evidence: { source: 'user', turnId: input.turnId } }], usage: { totalTokens: 8 } }; } }));
});

test('failed updater keeps actor draft/usage; retry avoids duplicate actor/user and rejects changed runtime', async () => {
  let actors = 0; let updates = 0;
  await fixture(async ({ session, post, store }) => {
    const path = `/api/sessions/${session.session.id}/turns`; const body = { clientTurnId: 'retry', content: '  保留正文空白\n' };
    const first = events(await (await post(path, body)).text());
    assert.equal(first.at(-1)?.type, 'failed'); assert(!JSON.stringify(first).includes('secret-provider-key'));
    const failed = await store.getSession('alice', session.session.id);
    assert.equal(failed.messages.length, 2); assert.equal(failed.world.revision, 0); assert.equal(failed.messages[1].content, body.content);
    assert.deepEqual((await store.storedTurn('alice', first[0].turnId)).usage, { actor: { totalTokens: 21 } });
    await assert.rejects(store.beginTurn('alice', session.session.id, body.clientTurnId, body.content, { runtimeFingerprint: 'new-model' }), { code: 'RUNTIME_CHANGED' });
    assert.equal(events(await (await post(path, body)).text()).at(-1)?.type, 'committed');
    assert.equal(actors, 1); assert.equal(updates, 2); assert.equal((await store.getSession('alice', session.session.id)).messages.length, 3);
  }, runtime({ actor: async (_input, options) => { actors++; options.onTextDelta('完整草稿'); return { text: '完整草稿', usage: { totalTokens: 21 } }; }, updateWorld: async () => { if (++updates === 1) throw new Error('secret-provider-key and full system prompt'); return { changes: [] }; } }));
});

test('resource owner scopes and composite foreign keys prevent cross-owner links; private memory follows its character', async () => {
  const inputs: ActorInput[] = [];
  await fixture(async ({ session, post, store, base }) => {
    await (await post(`/api/sessions/${session.session.id}/turns`, { clientTurnId: 'first', content: '只给林晚的秘密' })).text();
    await (await post(`/api/sessions/${session.session.id}/turns`, { clientTurnId: 'public', content: '公共线索' })).text();
    // Existing trusted shared memory remains readable; automatic new writes are always private.
    await store.pool.query("UPDATE events SET visibility='public' WHERE world_id=$1 AND text='公共线索'", [session.world.id]);
    const other = await (await post('/api/sessions', { characterId: 'shen-yan', worldId: session.world.id })).json() as SessionDetail;
    await (await post(`/api/sessions/${other.session.id}/turns`, { clientTurnId: 'second', content: '你好' })).text();
    assert(!inputs[2].world.events.some((event) => event.text === '只给林晚的秘密'));
    assert(inputs[2].world.events.some((event) => event.text === '公共线索'));
    const same = await store.createSession('alice', 'lin-wan', session.world.id);
    const next = await store.beginTurn('alice', same.session.id, 'third', '你记得吗');
    assert(next.input.world.events.some((event) => event.text === '只给林晚的秘密'));
    await store.finish(next, 'cancelled', 'TEST', 'fixture');
    assert.equal((await store.getWorld('alice', session.world.id)).events.length, 2);
    const firstTurn = (await store.getSession('alice', session.session.id)).messages[1].turnId!;
    for (const path of [`/api/sessions/${session.session.id}`, `/api/sessions/${session.session.id}/messages`, `/api/turns/${firstTurn}`]) assert.equal((await fetch(base + path, { headers: { 'x-test-owner': 'bob' } })).status, 404);
    assert.equal((await post(`/api/turns/${firstTurn}/cancel`, {}, 'bob')).status, 404);
    assert.equal((await post('/api/sessions', { characterId: 'shen-yan', worldId: session.world.id }, 'bob')).status, 404);
    assert.equal((await post(`/api/sessions/${session.session.id}/turns`, { clientTurnId: 'intruder', content: 'x' }, 'bob')).status, 404);
    await assert.rejects(store.pool.query("INSERT INTO sessions(id,owner_id,world_id,character_id,title) VALUES($1,'bob',$2,'lin-wan','bad')", [randomUUID(), session.world.id]), { code: '23503' });
    await assert.rejects(store.pool.query("INSERT INTO messages(id,owner_id,world_id,session_id,turn_id,role,content) VALUES($1,'bob',$2,$3,$4,'assistant','bad')", [randomUUID(), session.world.id, same.session.id, next.id]), { code: '23503' });
  }, runtime({ actor: async (input) => { inputs.push(input); return { text: '回复' }; }, updateWorld: async (input) => ({ changes: input.character.id === 'lin-wan' ? [{ kind: 'fact', text: input.userText, visibility: input.userText === '公共线索' ? 'public' : 'private', characterId: input.character.id, evidence: { source: 'user', turnId: input.turnId } }] : [] }) }));
});

test('independent pools serialize one world, allow different worlds, and make concurrent seed/idempotency safe', async () => {
  const f = await postgresFixture(); const second = f.peer();
  try {
    await Promise.all([f.store.ensureSeed('alice'), second.ensureSeed('alice')]);
    const sessions = await f.store.listSessions('alice'); assert.equal(sessions.length, 1);
    const session = sessions[0];
    const otherSession = await second.createSession('alice', 'shen-yan', session.worldId);
    const pair = await Promise.allSettled([f.store.beginTurn('alice', session.id, 'same', '正文'), second.beginTurn('alice', session.id, 'same', '正文')]);
    assert.equal(pair.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = pair.find((result) => result.status === 'fulfilled'); assert(winner?.status === 'fulfilled');
    const loser = pair.find((result) => result.status === 'rejected'); assert(loser?.status === 'rejected'); assert.equal(loser.reason.code, 'TURN_RUNNING');
    await assert.rejects(second.beginTurn('alice', otherSession.session.id, 'other', '竞争'), { code: 'WORLD_BUSY' });
    const otherWorld = await second.createSession('alice', 'xu-zhiyao');
    const parallel = await second.beginTurn('alice', otherWorld.session.id, 'parallel', '可并发');
    await Promise.all([f.store.commit(winner.value, '完成', []), second.commit(parallel, '完成', [])]);
    assert.equal((await f.store.getSession('alice', session.id)).messages.length, 3);
  } finally { await f.cleanup(); }
});

test('cross-instance cancellation stops the active lease and fences an abort-ignoring provider after retry', async () => {
  const f = await postgresFixture({ leaseMs: 300 }); const second = f.peer();
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; }); let started = false;
  const model = runtime({ actor: async () => { started = true; await blocked; return { text: '迟到的回复' }; } });
  const service = new TurnService(f.store, model); const remote = new TurnService(second, runtime());
  try {
    const session = await f.store.createSession('alice', 'lin-wan');
    const turn = await f.store.beginTurn('alice', session.session.id, 'cancel-me', '你好');
    const output: TurnEvent[] = []; const pending = service.run(turn, (event) => output.push(event));
    await until(() => started);
    assert.equal((await remote.cancel('alice', turn.id)).status, 'cancelled');
    await pending;
    assert.equal(output.at(-1)?.type, 'cancelled');
    const retry = await second.beginTurn('alice', session.session.id, 'cancel-me', '你好');
    await remote.run(retry, () => {}); release();
    assert.equal((await f.store.getTurn('alice', turn.id)).status, 'committed');
    assert.equal((await f.store.getWorld('alice', session.world.id)).revision, 1);
    assert.equal((await f.store.getSession('alice', session.session.id)).messages.length, 3);
    await assert.rejects(f.store.commit(turn, '迟到内容', []), { code: 'TURN_LEASE_LOST' });
  } finally { release(); await service.shutdown(); await remote.shutdown(); await f.cleanup(); }
});

test('SSE disconnect cancels durably; GET recovery and same-ID retry do not duplicate user content', async () => {
  let calls = 0;
  await fixture(async ({ session, base, post, store }) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/sessions/${session.session.id}/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientTurnId: 'disconnect', content: '消息' }), signal: abort.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let body = '';
    while (!body.includes('\n\n')) { const chunk = await reader.read(); body += decoder.decode(chunk.value); }
    const accepted = events(body).find((event) => event.type === 'accepted'); assert(accepted?.type === 'accepted');
    abort.abort();
    await until(async () => (await store.getTurn('alice', accepted.turnId)).status === 'cancelled');
    const view = await (await fetch(`${base}/api/turns/${accepted.turnId}`)).json(); assert.equal(view.status, 'cancelled');
    const retried = events(await (await post(`/api/sessions/${session.session.id}/turns`, { clientTurnId: 'disconnect', content: '消息' })).text());
    assert.equal(retried.at(-1)?.type, 'committed'); assert.equal((await store.getSession('alice', session.session.id)).messages.length, 3);
  }, runtime({ actor: async (_input, { signal }) => { if (++calls === 1) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return { text: '恢复成功' }; } }));
});

test('a delayed cancel response cannot abort a newer local attempt of the same turn', async () => {
  const f = await postgresFixture(); const { store } = f;
  let returnCancel!: () => void; const cancelGate = new Promise<void>((resolve) => { returnCancel = resolve; });
  let returnActor!: () => void; const actorGate = new Promise<void>((resolve) => { returnActor = resolve; });
  let cancellationPersisted = false; let actorSignal: AbortSignal | undefined;
  const service = new TurnService(store, runtime({ actor: async (_input, { signal }) => { actorSignal = signal; await actorGate; return { text: '新执行完成' }; } }));
  const original = store.cancelTurn.bind(store);
  store.cancelTurn = async (...args) => { const result = await original(...args); cancellationPersisted = true; await cancelGate; return result; };
  try {
    const session = await store.createSession('alice', 'lin-wan'); const old = await store.beginTurn('alice', session.session.id, 'same', '正文');
    const cancellation = service.cancel('alice', old.id);
    await until(() => cancellationPersisted);
    const retry = await store.beginTurn('alice', session.session.id, 'same', '正文');
    const running = service.run(retry, () => {}); await until(() => !!actorSignal);
    returnCancel(); await cancellation;
    assert.equal(actorSignal!.aborted, false);
    returnActor(); await running;
    assert.equal((await store.getTurn('alice', old.id)).status, 'committed');
  } finally { returnCancel(); returnActor(); await service.shutdown(); await f.cleanup(); }
});

test('CAS conflicts and failed event writes roll back assistant, events, revision and completion together', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const session = await store.createSession('alice', 'lin-wan'); const turn = await store.beginTurn('alice', session.session.id, 'first', '正文');
    await store.saveDraft(turn, '草稿');
    await store.pool.query('UPDATE worlds SET revision=1 WHERE id=$1', [session.world.id]);
    await assert.rejects(store.commit(turn, '草稿', []), { code: 'WORLD_CHANGED' });
    await store.pool.query('UPDATE worlds SET revision=0 WHERE id=$1', [session.world.id]);
    await f.migrationPool.query("ALTER TABLE events ADD CONSTRAINT fixture_event_rejection CHECK(text<>'正文')");
    await assert.rejects(store.commit(turn, '草稿', [{ kind: 'event', text: '正文', visibility: 'public', characterId: 'lin-wan', evidence: { source: 'user', turnId: turn.id } }]), { code: '23514' });
    assert.equal((await store.getWorld('alice', session.world.id)).revision, 0);
    assert.equal((await store.getWorld('alice', session.world.id)).events.length, 0);
    assert.equal((await store.getTurn('alice', turn.id)).status, 'running');
    assert.equal((await store.getSession('alice', session.session.id)).messages.length, 2);
    assert.equal((await store.storedTurn('alice', turn.id)).draft, '草稿');
  } finally { await f.cleanup(); }
});

test('disconnect while beginTurn is blocked cancels its eventual claim before invoking any model', async () => {
  let actors = 0; let waiting = false; let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await fixture(async ({ session, base, store }) => {
    const original = store.beginTurn.bind(store);
    store.beginTurn = async (...args) => { waiting = true; await blocked; return original(...args); };
    const abort = new AbortController();
    const request = fetch(`${base}/api/sessions/${session.session.id}/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientTurnId: 'disconnect-before-claim', content: '不要迟到调用模型' }), signal: abort.signal }).catch(() => undefined);
    try {
      await until(() => waiting); abort.abort(); await request; release();
      await until(async () => (await store.pool.query("SELECT status FROM turns WHERE client_turn_id='disconnect-before-claim'")).rows[0]?.status === 'cancelled');
      assert.equal(actors, 0);
      assert.equal((await store.getSession('alice', session.session.id)).messages.length, 2);
      assert.equal((await store.getWorld('alice', session.world.id)).revision, 0);
    } finally { release(); }
  }, runtime({ actor: async () => { actors++; return { text: '不应执行' }; } }));
});

test('expired attempt recovers lazily; renewal, draft, finish and late commit cannot revive or replace it', async () => {
  const f = await postgresFixture(); const second = f.peer();
  try {
    const session = await f.store.createSession('alice', 'lin-wan'); const old = await f.store.beginTurn('alice', session.session.id, 'stable', '正文');
    await f.store.saveDraft(old, '完整草稿', { totalTokens: 10 });
    await f.store.pool.query("UPDATE turns SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
    assert.equal(await f.store.renewAttempt(old), false);
    assert.equal((await second.getTurn('alice', old.id)).status, 'failed');
    const retry = await second.beginTurn('alice', session.session.id, 'stable', '正文');
    assert.equal(retry.draft, '完整草稿'); assert.notEqual(retry.attempt, old.attempt);
    await assert.rejects(f.store.saveDraft(old, '旧草稿'), { code: 'TURN_LEASE_LOST' });
    await assert.rejects(f.store.commit(old, '旧回复', []), { code: 'TURN_LEASE_LOST' });
    assert.equal(await f.store.finish(old, 'failed', 'OLD', '旧执行'), false);
    await second.commit(retry, retry.draft!, [], { totalTokens: 7 });
    assert.deepEqual((await second.storedTurn('alice', old.id)).usage, { actor: { totalTokens: 10 }, updater: { totalTokens: 7 } });
    assert.equal((await second.getSession('alice', session.session.id)).messages.length, 3);
  } finally { await f.cleanup(); }
});

test('bounded complete history excludes failed/current inputs; pagination keeps exact order beyond 100', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const session = await store.createSession('alice', 'lin-wan');
    for (let index = 0; index < 20; index++) { const turn = await store.beginTurn('alice', session.session.id, `id-${index}`, `用户${index}`); await store.commit(turn, `回复${index}`, []); }
    const failed = await store.beginTurn('alice', session.session.id, 'failed', '不应进入上下文'); await store.finish(failed, 'failed', 'TEST', 'fixture');
    const next = await store.beginTurn('alice', session.session.id, 'next', '当前输入一次');
    assert.equal(next.input.history.length, 24); assert.equal(next.input.history[0].content, '用户8'); assert.equal(next.input.history.at(-1)?.content, '回复19');
    assert(!JSON.stringify(next.input.history).includes('不应进入上下文')); assert(!JSON.stringify(next.input.history).includes('当前输入一次'));
    await store.finish(next, 'cancelled', 'TEST', 'fixture');
    for (let index = 0; index < 105; index++) await store.pool.query("INSERT INTO messages(id,owner_id,world_id,session_id,role,content) VALUES($1,'alice',$2,$3,'assistant',$4)", [randomUUID(), session.world.id, session.session.id, `分页${index}`]);
    const latest = await store.messagePage('alice', session.session.id); assert.equal(latest.messages.length, 100); assert(latest.hasMore); assert.equal(latest.messages.at(-1)?.content, '分页104');
    const older = await store.messagePage('alice', session.session.id, latest.nextBefore!); assert.equal(older.messages.at(-1)?.content, '分页4');
    assert(!older.messages.some((message) => latest.messages.some((other) => other.id === message.id)));
  } finally { await f.cleanup(); }
});

test('context character budgets keep newest whole turns; SQL filters other NPC secrets before LIMIT', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const session = await store.createSession('alice', 'lin-wan');
    for (let index = 0; index < 10; index++) { const turn = await store.beginTurn('alice', session.session.id, `long-${index}`, `用户${index}:` + '中'.repeat(496)); await store.commit(turn, `回复${index}:` + '文'.repeat(496), []); }
    const memories = await store.createSession('alice', 'lin-wan', session.world.id);
    for (let index = 0; index < 10; index++) { const turn = await store.beginTurn('alice', memories.session.id, `memory-${index}`, `公共${index}:` + '事'.repeat(990)); await store.commit(turn, '回复', [{ kind: 'fact', text: 'summary ignored', visibility: 'public', characterId: 'lin-wan', evidence: { source: 'user', turnId: turn.id } }]); }
    const other = await store.createSession('alice', 'shen-yan', session.world.id);
    for (let index = 0; index < 105; index++) { const turn = await store.beginTurn('alice', other.session.id, `secret-${index}`, `沈砚秘密${index}`); await store.commit(turn, '回复', [{ kind: 'fact', text: 'summary ignored', visibility: 'private', characterId: 'shen-yan', evidence: { source: 'user', turnId: turn.id } }]); }
    const next = await store.beginTurn('alice', session.session.id, 'budget-check', '现在呢？');
    assert(next.input.history.reduce((size, message) => size + message.content.length, 0) <= 6000);
    assert(next.input.history[0].content.startsWith('用户4:')); assert(next.input.history.at(-1)?.content.startsWith('回复9:')); assert.equal(next.input.history.length % 2, 0);
    assert(JSON.stringify(next.input).length <= 23000);
    assert.equal(next.input.world.events.length, 10); assert(next.input.world.events[0].text.startsWith('公共0:')); assert(next.input.world.events.at(-1)?.text.startsWith('公共9:'));
    assert(!JSON.stringify(next.input.world.events).includes('沈砚秘密'));
    const manageable = (await store.getSession('alice', session.session.id)).world;
    assert.equal(manageable.memoryScopeCharacterId, 'lin-wan');
    assert.equal(manageable.events.filter(event => event.status === 'active').length, 10);
    assert(!JSON.stringify(manageable.events).includes('沈砚秘密'));
    assert(next.input.world.events.every(event => manageable.events.some(entry => entry.sourceTurnId === event.evidence?.turnId)));
  } finally { await f.cleanup(); }
});

test('migrations are separate/idempotent; app role cannot DDL or change character catalog; runtime reads PG characters', async () => {
  const f = await postgresFixture();
  try {
    const role = `"${f.appRole.replaceAll('"', '""')}"`;
    await f.migrationPool.query(`GRANT ALL ON characters,schema_migrations TO ${role}`);
    await migrate(f.migrationPool, { appRole: f.appRole });
    assert.deepEqual((await f.migrationPool.query('SELECT version FROM schema_migrations WHERE version<=4 ORDER BY version')).rows.map(row => row.version), [1,2,3,4]);
    await assert.rejects(f.store.pool.query('CREATE TABLE unauthorized(id integer)'), { code: '42501' });
    await assert.rejects(f.store.pool.query("UPDATE characters SET name='bad' WHERE id='lin-wan'"), { code: '42501' });
    assert.deepEqual((await f.store.pool.query('SELECT version FROM schema_migrations WHERE version<=4 ORDER BY version')).rows.map(row => row.version), [1,2,3,4]);
    await assert.rejects(f.store.pool.query("INSERT INTO schema_migrations(version,checksum) VALUES(999,'bad')"), { code: '42501' });
    await f.migrationPool.query("UPDATE characters SET greeting='从数据库读取的开场白' WHERE id='lin-wan'");
    const session = await f.store.createSession('alice', 'lin-wan'); assert.equal(session.messages[0].content, '从数据库读取的开场白');
    const turn = await f.store.beginTurn('alice', session.session.id, 'db-character', '你好'); assert.equal(turn.input.character.greeting, '从数据库读取的开场白');
    assert.deepEqual(turn.usage, {});
  } finally { await f.cleanup(); }
});

test('world changes discard cross-character private data and excessive writes', () => {
  const input = { turnId: 'turn', character: { id: 'lin-wan', name: '林晚', description: '', greeting: '' }, userText: '原话' };
  assert.deepEqual(validateChanges([{ kind: 'fact', text: 'private', visibility: 'private', characterId: 'shen-yan', evidence: { source: 'user', turnId: 'turn' } }], input), []);
  assert.deepEqual(validateChanges(Array.from({ length: 4 }, () => ({ kind: 'fact', text: 'x', visibility: 'private', characterId: 'lin-wan', evidence: { source: 'user', turnId: 'turn' } })), input), []);
});
