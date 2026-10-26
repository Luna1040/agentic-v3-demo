import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { promptSnapshot } from '../server/developer.ts';
import type { PromptSet, StoryRuntime } from '../server/runtime.ts';
import { postgresFixture } from './pg-helper.ts';

const defaults: PromptSet = { main: 'main default', actor: 'actor default', updater: 'updater default' };
function runtime(prompts = defaults): StoryRuntime {
  return { prompts, metadata: { runtimeFingerprint: JSON.stringify(prompts) },
    status: { provider: 'demo', model: 'fake-no-paid-calls', harness: { loaded: true, version: 'test' }, offlineSimulation: false },
    actor: async (input, options) => { options.signal.throwIfAborted(); return { text: `${prompts.actor}: ${input.userText}`, usage: { totalTokens: 5 } }; },
    updateWorld: async () => ({ changes: [] }),
  };
}
async function withApp(work: (context: { base: string; sessionId: string; db: Awaited<ReturnType<typeof postgresFixture>>; request: (path: string, method?: string, body?: unknown, permission?: boolean, owner?: string) => Promise<Response> }) => Promise<void>, buildRuntime = runtime) {
  const db = await postgresFixture();
  await db.store.ensurePromptDefaults(defaults);
  const session = await db.store.createSession('alice', 'lin-wan');
  const app = createApp({ store: db.store, runtime: buildRuntime(), authenticate: req => req.get('x-owner') || 'alice',
    resolveRuntime: async () => buildRuntime((await promptSnapshot(db.store, defaults)).prompts),
    developer: { authorize: req => req.get('x-developer') === 'yes', defaultPrompts: defaults, buildRuntime: async prompts => buildRuntime(prompts) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (path: string, method = 'GET', body?: unknown, permission = true, owner = 'alice') => fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-owner': owner, ...(permission ? { 'x-developer': 'yes' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  try { await work({ base, sessionId: session.session.id, db, request }); }
  finally { await app.locals.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await db.cleanup(); }
}

test('developer permission gates prompt reads/writes and traces while normal chat stays accessible', async () => {
  await withApp(async ({ request, sessionId }) => {
    assert.equal((await request('/dev/prompts', 'GET', undefined, false)).status, 403);
    assert.equal((await request('/dev/prompts/actor', 'PUT', { content: 'bad', expectedVersion: 1 }, false)).status, 403);
    assert.equal((await request('/turns/nonexistent/trace', 'GET', undefined, false)).status, 403);
    const regular = await (await request('/bootstrap', 'GET', undefined, false)).json();
    assert.equal(regular.status.developerTools, false);
    assert.equal((await request(`/sessions/${sessionId}`, 'GET', undefined, false)).status, 200);
  });
});

test('prompt publishing is versioned, rejects stale editors, and takes effect on the next turn without restart', async () => {
  await withApp(async ({ request, sessionId, db }) => {
    const list = await (await request('/dev/prompts')).json();
    assert.equal(list.prompts.length, 3);
    const initial = list.prompts.find((entry: { key: string }) => entry.key === 'actor');
    const published = await request('/dev/prompts/actor', 'PUT', { content: 'revised actor', expectedVersion: initial.version });
    assert.equal(published.status, 200);
    const saved = await published.json();
    assert.equal(saved.version, initial.version + 1);
    assert.equal(saved.history.length, 2);
    assert.equal((await request('/dev/prompts/actor', 'PUT', { content: 'stale overwrite', expectedVersion: initial.version })).status, 409);
    const stream = await (await request(`/sessions/${sessionId}/turns`, 'POST', { clientTurnId: 'published', content: 'hello' })).text();
    assert.match(stream, /revised actor: hello/);
    const row = (await db.store.getPrompts()).find(entry => entry.key === 'actor');
    assert.equal(row?.content, 'revised actor');
  });
});

test('unsaved prompt dry-run returns actual output but cannot publish, commit world changes, or access another owner', async () => {
  await withApp(async ({ request, sessionId, db }) => {
    const counts = async () => (await db.migrationPool.query('SELECT (SELECT count(*) FROM turns)::int AS turns,(SELECT count(*) FROM messages)::int AS messages,(SELECT count(*) FROM events)::int AS events,(SELECT sum(revision) FROM worlds)::int AS revision')).rows[0];
    const before = await counts();
    const result = await (await request('/dev/agents/actor/test', 'POST', { sessionId, userText: 'preview', prompt: 'draft only' })).json();
    assert.equal(result.committed, false);
    assert.equal(result.output.text, 'draft only: preview');
    assert.equal(result.calls[0].status, 'completed');
    assert.equal(result.calls[0].output.text, result.output.text);
    assert.equal(result.usage.totalTokens, 5);
    assert.deepEqual(await counts(), before);
    assert.equal((await db.store.getPrompts()).find(entry => entry.key === 'actor')?.content, defaults.actor);
    assert.equal((await request('/dev/agents/actor/test', 'POST', { sessionId, userText: 'preview', prompt: 'draft' }, true, 'bob')).status, 404);
    assert.equal((await request('/dev/agents/updater/test', 'POST', { sessionId, userText: 'preview', prompt: 'draft' })).status, 422);
  });
});

test('isolated updater failure preserves safe candidate diagnostics and known usage without writing the story', async () => {
  await withApp(async ({ request, sessionId, db }) => {
    const before = (await db.migrationPool.query('SELECT (SELECT count(*) FROM turns)::int AS turns,(SELECT count(*) FROM messages)::int AS messages,(SELECT count(*) FROM events)::int AS events')).rows[0];
    const result = await (await request('/dev/agents/updater/test','POST',{sessionId,userText:'测试',assistantText:'回复',prompt:'草稿'})).json();
    assert.equal(result.committed,false); assert.equal(result.output.error.code,'UPDATER_OUTPUT_INVALID');
    assert.deepEqual(result.calls[0].output,{candidate:{changes:[{kind:'unsupported'}],apiKey:'[REDACTED]'}});
    assert.deepEqual(result.calls[0].usage,{inputTokens:10,outputTokens:5,totalTokens:15});
    assert.deepEqual(result.usage,{inputTokens:10,outputTokens:5,totalTokens:15});
    assert(!JSON.stringify(result).includes('fake-private-key'));
    const after = (await db.migrationPool.query('SELECT (SELECT count(*) FROM turns)::int AS turns,(SELECT count(*) FROM messages)::int AS messages,(SELECT count(*) FROM events)::int AS events')).rows[0];
    assert.deepEqual(after,before);
  }, (prompts=defaults) => ({...runtime(prompts),updateWorld:async () => { throw Object.assign(new Error('World Updater 候选不符合 schema。'),{name:'StoryRuntimeError',code:'UPDATER_OUTPUT_INVALID',output:{candidate:{changes:[{kind:'unsupported'}],apiKey:'fake-private-key'}},usage:{inputTokens:10,outputTokens:5,totalTokens:15}}); }}));
});

test('isolated actor reports known safe provider failures but never exposes arbitrary error details', async () => {
  let known = true;
  await withApp(async ({request,sessionId}) => {
    const body={sessionId,userText:'测试',prompt:'草稿'};
    const first=await (await request('/dev/agents/actor/test','POST',body)).json();
    assert.equal(first.output.error.code,'PROVIDER_CONTENT_FILTER'); assert.equal(first.calls[0].error.message,'Provider did not produce a completed response.');
    assert.equal(first.calls[0].output,undefined);
    known=false;
    const second=await (await request('/dev/agents/actor/test','POST',body)).json();
    assert.equal(second.output.error.code,'AGENT_TEST_FAILED'); assert(!JSON.stringify(second).includes('private-provider-response')); assert(!JSON.stringify(second).includes('private-header'));
    assert.equal(second.calls[0].usage,undefined);
  }, (prompts=defaults) => ({...runtime(prompts),actor:async () => {
    if(known) throw Object.assign(new Error('Provider did not produce a completed response.'),{name:'StoryRuntimeError',code:'PROVIDER_CONTENT_FILTER',output:{response:'private-provider-response',headers:'private-header'}});
    throw Object.assign(new Error('private-provider-response'),{code:'UPDATER_OUTPUT_INVALID',output:{text:'private-header'},usage:{totalTokens:999}});
  }}));
});

test('Main dry-run sums only known fields from every executed model and excludes unselected agents', async () => {
  let partial = false; let withUpdater = true;
  await withApp(async ({request,sessionId}) => {
    const body={sessionId,userText:'测试链路',prompt:'Main 草稿'};
    const complete=await (await request('/dev/agents/main/test','POST',body)).json();
    assert.deepEqual(complete.usage,{inputTokens:600,outputTokens:60,totalTokens:660});
    assert.equal(complete.calls.length,3);
    partial=true;
    const unknown=await (await request('/dev/agents/main/test','POST',body)).json();
    assert.deepEqual(unknown.usage,{outputTokens:60});
    partial=false;withUpdater=false;
    const skipped=await (await request('/dev/agents/main/test','POST',body)).json();
    assert.deepEqual(skipped.usage,{inputTokens:300,outputTokens:30,totalTokens:330});
    assert.equal(skipped.calls.length,2);
  }, (prompts=defaults) => ({...runtime(prompts),runTurn:async (_input,options) => {
    const usage={main:{inputTokens:100,outputTokens:10,totalTokens:110},actor:partial?{outputTokens:20}:{inputTokens:200,outputTokens:20,totalTokens:220},...(withUpdater?{updater:{inputTokens:300,outputTokens:30,totalTokens:330}}:{})};
    for(const agent of ['main','actor',...(withUpdater?['updater']:[])] as const) await options.onCall({id:`${agent}-call`,parentId:agent==='main'?null:'main-call',attemptId:options.attemptId,agent:agent as 'main'|'actor'|'updater',status:'completed',model:'fake-model',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),input:{},usage:usage[agent as keyof typeof usage]});
    return {text:'试跑回复',changes:[],usage};
  }}));
});
