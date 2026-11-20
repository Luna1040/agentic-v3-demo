import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { createPreviewFixture } from '../scripts/preview-fixture.ts';

function events(body: string): any[] {
  return body.split('\n\n').filter(block => block.startsWith('event:')).map(block => JSON.parse(block.split('\ndata: ')[1]));
}
async function preview() {
  const fixture = createPreviewFixture();
  const apps = (['consumer', 'admin'] as const).map(audience => createApp({ ...fixture, audience, authenticate: () => 'local',
    ...(audience === 'admin' ? { developer: { authorize: () => true, defaultPrompts: fixture.defaultPrompts, buildRuntime: fixture.buildRuntime } } : {}),
  }));
  const servers = apps.map(app => app.listen(0, '127.0.0.1'));
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); })));
  const request = (index: number, path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${(servers[index].address() as AddressInfo).port}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { fixture, request, close: async () => { await Promise.all(apps.map(app => app.locals.shutdown())); for (const server of servers) server.closeAllConnections(); await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); } };
}

test('local preview serves marked sample data, streams and replays without models, and persists cancellation/retry in memory', async () => {
  const f = await preview();
  try {
    const bootstrap = await (await f.request(0, '/api/bootstrap')).json();
    assert.equal(bootstrap.characters.length, 2); assert(bootstrap.characters.every((character: any) => character.source === 'legacy'));
    assert.equal(bootstrap.sessions.length, 1); assert.equal(bootstrap.status.provider, 'demo');
    const seeded = await (await f.request(0, '/api/sessions/' + bootstrap.sessions[0].id)).json();
    const seededTurn = seeded.messages.find((message: any) => message.turnId)?.turnId;
    const seededTrace = await (await f.request(1, `/api/turns/${seededTurn}/trace`)).json();
    assert.equal(seededTrace.metadata.preview, true); assert.equal(seededTrace.calls[0].model, 'preview-template-no-model');
    const created = await f.request(0, '/api/sessions', 'POST', { characterId: bootstrap.characters[1].id });
    assert.equal(created.status, 201);
    const session = await created.json(), path = `/api/sessions/${session.session.id}/turns`;
    const body = { clientTurnId: 'one-turn', content: '一起看星星吧。' };
    const first = events(await (await f.request(0, path, 'POST', body)).text());
    assert.equal(first[0].type, 'accepted'); assert(first.some(event => event.type === 'delta')); assert.equal(first.at(-1).type, 'committed');
    assert.match(first.at(-1).message.content, /本地演示.*无模型调用/);
    assert(!JSON.stringify(first).includes('预览隐藏设定'));
    const repeated = events(await (await f.request(0, path, 'POST', body)).text());
    assert.deepEqual(repeated.map(event => event.type), ['accepted', 'committed']);
    assert.equal(repeated.at(-1).message.id, first.at(-1).message.id);
    assert.equal((await (await f.request(0, `/api/sessions/${session.session.id}`)).json()).messages.length, 3);

    const cancelBody = { clientTurnId: 'cancel-and-retry', content: '先停一下。' };
    const response = await f.request(0, path, 'POST', cancelBody), reader = response.body!.getReader();
    let start = ''; const decoder = new TextDecoder();
    while (!start.includes('\n\n')) { const chunk = await reader.read(); assert(!chunk.done); start += decoder.decode(chunk.value); }
    const turnId = events(start.split('\n\n')[0])[0].turnId;
    const cancelled = await (await f.request(0, `/api/turns/${turnId}/cancel`, 'POST', {})).json();
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.userMessage.status, 'cancelled');
    await reader.cancel();
    const afterCancel = await (await f.request(0, `/api/sessions/${session.session.id}`)).json();
    assert.equal(afterCancel.messages.find((message: any) => message.turnId === turnId).status, 'cancelled');
    const retryResponse = await f.request(0, path, 'POST', cancelBody), retried = events(await retryResponse.text());
    assert.equal(retried[0].userMessage.status, 'pending'); assert.equal(retried.at(-1).type, 'committed');
    assert.equal(retried.at(-1).turnId, turnId);
    const final = await (await f.request(0, `/api/sessions/${session.session.id}`)).json();
    assert.equal(final.messages.filter((message: any) => message.turnId === turnId && message.role === 'user').length, 1);
    assert.equal(final.messages.find((message: any) => message.turnId === turnId).status, 'committed');
    const openingSession = await (await f.request(0, '/api/sessions', 'POST', { characterId: bootstrap.characters[0].id, dynamicOpening: true })).json();
    const opening = events(await (await f.request(0, `/api/sessions/${openingSession.session.id}/opening`, 'POST', {})).text());
    assert.equal(opening.at(-1).type, 'committed'); assert(!JSON.stringify(opening).includes('为当前场景生成连贯的第一幕'));
  } finally { await f.close(); }
});

test('local admin preview edits and tests six sample prompts while unsupported tasks stay explicitly empty', async () => {
  const f = await preview();
  try {
    const bootstrap = await (await f.request(1, '/api/bootstrap')).json(), sessionId = bootstrap.sessions[0].id;
    const list = await (await f.request(1, '/api/dev/prompts')).json(); assert.equal(list.prompts.length, 6);
    const actor = list.prompts.find((prompt: any) => prompt.key === 'actor');
    const content = '【本地界面预览】已修改的示例 Actor Prompt。';
    const saved = await f.request(1, '/api/dev/prompts/actor', 'PUT', { content, expectedVersion: actor.version }); assert.equal(saved.status, 200);
    const updated = await saved.json(); assert.equal(updated.content, content); assert.equal(updated.version, actor.version + 1); assert.equal(updated.history.length, 2);
    const draft = '【本地界面预览】未发布的测试草稿。';
    const tested = await f.request(1, '/api/dev/agents/actor/test', 'POST', { sessionId, userText: '你好', prompt: draft }); assert.equal(tested.status, 200);
    const result = await tested.json(); assert.equal(result.committed, false); assert.equal(result.output.preview, true); assert.equal(result.calls[0].input.systemPrompt, draft);
    assert.equal((await f.fixture.store.getPrompts()).find(prompt => prompt.key === 'actor')!.content, content);
    const catalog = await (await f.request(1, '/api/dev/agent-catalog')).json(); assert.deepEqual(catalog.agents, []);
    const audit = await (await f.request(1, `/api/worlds/${bootstrap.worlds[0].id}/runtime-audit`)).json(); assert.equal(audit.preview, true); assert.deepEqual(audit.turns, []); assert.deepEqual(audit.events, []);
    const capture = await f.request(1, `/api/worlds/${bootstrap.worlds[0].id}/runtime-audit/capture`, 'POST', {}); assert.equal(capture.status, 501); assert.match((await capture.json()).error.message, /本地界面预览/);
    assert.equal((await f.request(0, '/api/dev/prompts')).status, 404);
  } finally { await f.close(); }
});
