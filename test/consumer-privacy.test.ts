import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from '../server/app.ts';
import { ServiceError, type StoryRuntime } from '../server/runtime.ts';
import type { StoryStore } from '../server/store.ts';

const hidden = {
  current: 'CANARY_CURRENT_SYSTEM_PROMPT',
  defaults: 'CANARY_DEFAULT_SYSTEM_PROMPT',
  history: 'CANARY_HISTORICAL_SYSTEM_PROMPT',
  definition: 'CANARY_PRIVATE_CHARACTER_DEFINITION',
  plan: 'CANARY_INTERNAL_SCENE_PLAN',
  metadata: 'CANARY_PRIVATE_RUNTIME_METADATA',
  future: 'CANARY_UNRECOGNIZED_INTERNAL_FIELD',
  error: 'CANARY_PRIVATE_PROVIDER_FAILURE',
};
const openingInstruction = '为当前场景生成连贯的第一幕，保留玩家选择。';
const at = '2026-11-20T00:00:00.000Z';
const extras = { futureInternalField: hidden.future };
function publicOnly(value: unknown): void {
  const json = JSON.stringify(value);
  for (const secret of Object.values(hidden)) assert(!json.includes(secret), `Public response leaked ${secret}`);
  assert(!json.includes(openingInstruction), 'Public response leaked the internal opening instruction');
}
function events(body: string): any[] {
  return body.split('\n\n').filter(block => block.startsWith('event:')).map(block => JSON.parse(block.split('\ndata: ')[1]));
}

type FixtureOptions = {
  audience?: 'consumer' | 'admin';
  authenticate?: AppOptions['authenticate'] | null;
  authorize?: NonNullable<AppOptions['developer']>['authorize'];
  fail?: boolean;
};
async function fixture(options: FixtureOptions = {}) {
  const character = { id: 'c1', name: '角色', subtitle: '公开副标题', description: '公开介绍', greeting: '欢迎', initial: '角', color: 'sage', definition: hidden.definition, source: 'legacy', ...extras };
  const world = {
    id: 'w1', title: '故事', revision: 1, createdAt: at,
    scene: { location: '书店', presentCharacterIds: ['c1'], ...extras },
    events: [{ id: 'e1', kind: 'fact', text: '用户已产生的记忆', visibility: 'private', characterId: 'c1', sourceTurnId: 't1', createdAt: at, status: 'active', evidence: { source: 'user', turnId: 't1', ...extras } }],
    entities: [{ id: 'c1', kind: 'npc', name: '角色', description: '公开介绍', createdAt: at, updatedAt: at, version: 1, knownByCharacterIds: ['c1'], sourceTurnId: 'seed',
      state: { initial: '角', color: 'sage', definition: hidden.definition, greeting: '欢迎', arc: hidden.plan, characterView: { summary: hidden.plan }, ...extras }, ...extras }],
    storyTime: { day: 1, minute: 600, precision: 'minute', source: { kind: 'user_explicit', quote: hidden.current, ...extras }, ...extras },
    clock: { mode: 'paused', rate: 1, asOf: at, fromRealAt: at, elapsedRealMs: 0, fromWorldMs: 0, toWorldMs: 0, ...extras },
    settlementBacklog: { pendingTurns: 1, failedTurns: 0, oldestPendingAt: at, diagnostics: hidden.metadata, ...extras },
    mainlinePlan: { goal: hidden.plan }, eventLedger: [{ summary: hidden.plan }],
    deferredCommands: [{ id: 'command', reason: hidden.plan, evidenceIds: [hidden.metadata] }],
    episodes: [{ input: hidden.current, observations: hidden.plan }], activities: [{ text: hidden.plan }],
    settlements: [{ turnId: 't1', status: 'failed', attempts: 3, error: { code: hidden.error, message: hidden.current } }],
    director: { status: 'failed', turnId: 't1', errorCode: hidden.error },
    playerProfile: { id: 'p1', name: '玩家', persona: '用户填写的身份', version: 1, ...extras },
    runtimeMetadata: hidden.metadata, ...extras,
  };
  const session = { id: 's1', worldId: 'w1', characterId: 'c1', title: '对话', createdAt: at, updatedAt: at, dynamicOpening: false, scene: world.scene, ...extras };
  const assistant = { id: 'm2', turnId: 't1', sessionId: 's1', role: 'assistant', content: '回答', createdAt: at, status: 'committed', ...extras };
  let user = { id: 'm1', turnId: 't1', sessionId: 's1', role: 'user', content: '你好', createdAt: at, kind: 'dialogue', ...extras };
  let status = 'running';
  let error: { code: string; message: string } | undefined;
  let generated = 0;
  let protectedReads = 0;
  const detail = () => ({ session, messages: [user, assistant], world, hasMore: false, nextBefore: null, ...extras });
  const view = () => ({ id: 't1', worldId: 'w1', sessionId: 's1', status, phase: 'planning', userMessage: user, assistantMessage: assistant, assistantMessages: [assistant],
    ...(error ? { error } : {}), input: hidden.current, runtimeMetadata: hidden.metadata, runtimeHistory: hidden.history, ...extras });
  const promptRows = ['main', 'actor', 'updater'].map(key => ({ key, version: 2, content: hidden.current, createdAt: at }));
  const store = {
    leaseMs: 30_000,
    ensureSeed: async () => { protectedReads++; },
    listCharacters: async () => [character], listSessions: async () => [session], listWorlds: async () => [world],
    createSession: async () => detail(), getSession: async () => detail(), getWorld: async () => world,
    messagePage: async () => ({ messages: [user, assistant], hasMore: false, nextBefore: null, ...extras }),
    setScene: async () => { protectedReads++; return world; }, setWorldClock: async () => world, setMemoryStatus: async () => world,
    setPlayerProfile: async () => world, retrySettlements: async () => world,
    listPlayerProfiles: async () => [world.playerProfile], savePlayerProfile: async () => { protectedReads++; return world.playerProfile; },
    deletePlayerProfile: async () => { protectedReads++; },
    getTurn: async () => view(),
    cancelTurn: async () => { status = 'cancelled'; return { view: view(), attempt: 'attempt' }; },
    beginTurn: async (_owner: string, _session: string, clientTurnId: string, content: string) => {
      protectedReads++;
      user = { ...user, content, kind: clientTurnId.startsWith('opening:') ? 'operation' : 'dialogue' };
      return { id: 't1', ownerId: 'alice', worldId: 'w1', sessionId: 's1', status, attempt: 'attempt', replayed: status === 'committed', draft: null,
        input: { turnId: 't1', character: { id: 'c1' }, userText: content, world: { id: 'w1', revision: 0 }, privatePrompt: hidden.current }, runtimeMetadata: hidden.metadata };
    },
    renewAttempt: async () => true, saveCall: async () => {}, saveCheckpoint: async () => {}, saveDraft: async () => {},
    commit: async () => { status = 'committed'; return { message: assistant, messages: [assistant], world, ...extras }; },
    finish: async (_turn: unknown, next: string, code: string, message: string) => { status = next; error = { code, message }; return true; },
    storedTurn: async () => ({ attempt: 'attempt' }),
    getTrace: async () => ({ turnId: 't1', status, calls: [{ input: hidden.current, output: hidden.plan }], metadata: { current: hidden.current, history: hidden.history } }),
    getPrompts: async () => promptRows,
    listPromptVersions: async () => [{ key: 'actor', version: 1, content: hidden.history, createdAt: at }],
    savePrompt: async () => promptRows[0],
  } as unknown as StoryStore;
  const runtime: StoryRuntime = {
    status: { provider: 'demo', model: hidden.metadata, harness: { loaded: true, version: hidden.metadata }, offlineSimulation: false },
    prompts: { main: hidden.current, actor: hidden.current, updater: hidden.current }, metadata: { systemPrompt: hidden.current, history: hidden.history, ...extras },
    actor: async () => ({ text: '回答' }), updateWorld: async () => ({ changes: [] }),
    runWorldTurn: async () => { throw new Error('The fixture uses runTurn, not a world runtime.'); },
    runTurn: async (_input, execution) => {
      generated++;
      if (options.fail) throw new ServiceError(hidden.error, hidden.current, 502);
      await execution.onCall?.({ id: 'call1', parentId: null, attemptId: 'attempt', agent: 'main', status: 'running',
        model: hidden.metadata, startedAt: at, input: { systemPrompt: hidden.current }, output: hidden.plan });
      execution.onTextDelta('回答');
      return { text: '回答', changes: [], usage: {} };
    },
  };
  const app = createApp({ store, runtime, ...(options.audience ? { audience: options.audience } : {}),
    ...(options.authenticate === null ? {} : { authenticate: options.authenticate ?? (request => request.get('x-user') ?? '') }),
    developer: { authorize: options.authorize ?? (request => request.get('x-admin') === 'yes'), defaultPrompts: { main: hidden.defaults, actor: hidden.defaults, updater: hidden.defaults }, buildRuntime: async () => runtime },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app, store, generated: () => generated, protectedReads: () => protectedReads,
    rawRequest: (path: string, init: RequestInit) => fetch(base + path, init),
    request: (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-user': 'alice' }) =>
      fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: async () => { await app.locals.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())); },
  };
}

test('consumer APIs deny anonymous requests and do not infer a local identity', async () => {
  for (const options of [{ authenticate: null }, {}] as FixtureOptions[]) {
    const f = await fixture(options);
    try {
      for (const path of ['/api/bootstrap', '/api/worlds/w1', '/api/turns/t1']) {
        const response = await f.request(path, 'GET', undefined, {});
        assert.equal(response.status, 401, path); publicOnly(await response.json());
      }
      assert.equal(f.protectedReads(), 0);
    } finally { await f.close(); }
  }
});

test('consumer responses whitelist nested data on reads, creation and world mutations', async () => {
  const f = await fixture();
  try {
    const requests: Array<[string, string?, unknown?]> = [
      ['/api/bootstrap'], ['/api/worlds/w1'], ['/api/sessions/s1'], ['/api/sessions/s1/messages'], ['/api/turns/t1'],
      ['/api/sessions', 'POST', { characterId: 'c1' }], ['/api/turns/t1/cancel', 'POST', {}],
      ['/api/worlds/w1/scene', 'PATCH', { expectedRevision: 1, scene: { location: '书店', presentCharacterIds: ['c1'] } }],
      ['/api/worlds/w1/clock', 'PATCH', { expectedRevision: 1, mode: 'paused', rate: 1 }],
      ['/api/worlds/w1/player-profile', 'PATCH', { expectedRevision: 1, profileId: 'p1' }],
      ['/api/worlds/w1/events/e1', 'PATCH', { expectedRevision: 1, status: 'retracted' }],
      ['/api/worlds/w1/settlements/retry', 'POST', {}], ['/api/player-profiles'],
      ['/api/player-profiles', 'POST', { name: '玩家', persona: '用户填写的身份' }],
    ];
    for (const [path, method, body] of requests) {
      const response = await f.request(path, method, body);
      assert(response.ok, `${method ?? 'GET'} ${path}: ${response.status}`);
      publicOnly(await response.json());
    }
    const bootstrap = await (await f.request('/api/bootstrap')).json();
    assert.equal(bootstrap.characters[0].name, '角色');
    const session = await (await f.request('/api/sessions/s1')).json();
    assert.equal(session.messages.find((message: any) => message.role === 'assistant').content, '回答');
    assert(JSON.stringify(await f.store.getWorld('alice', 'w1')).includes(hidden.definition), 'Public projection must not mutate the stored runtime data');
  } finally { await f.close(); }
});

test('consumer streams and idempotent replays preserve dialogue without internal state or phase names', async () => {
  const f = await fixture();
  try {
    const path = '/api/sessions/s1/turns', body = { clientTurnId: 'stable', content: '你好' };
    for (const replay of [false, true]) {
      const response = await f.request(path, 'POST', body);
      assert.equal(response.status, 200);
      const stream = events(await response.text()); publicOnly(stream);
      assert.equal(stream[0].type, 'accepted'); assert.equal(stream.at(-1).type, 'committed');
      assert.equal(stream.at(-1).message.content, '回答');
      for (const event of stream.filter(event => event.type === 'phase')) assert.equal(event.phase, 'responding');
      if (replay) assert.equal(stream[0].replayed, true);
    }
    assert.equal(f.generated(), 1, 'Replay must not invoke the runtime again');
  } finally { await f.close(); }
});

test('internal opening instructions stay private in SSE and later message recovery', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/sessions/s1/opening', 'POST', {});
    assert.equal(response.status, 200);
    const stream = events(await response.text()); publicOnly(stream); assert.equal(stream.at(-1).type, 'committed');
    for (const path of ['/api/sessions/s1', '/api/sessions/s1/messages', '/api/turns/t1']) publicOnly(await (await f.request(path)).json());
  } finally { await f.close(); }
});

test('consumer HTTP, streaming and persisted errors use safe public diagnostics', async () => {
  const f = await fixture({ fail: true });
  try {
    const response = await f.request('/api/sessions/s1/turns', 'POST', { clientTurnId: 'failure', content: '你好' });
    const stream = events(await response.text()); assert.equal(stream.at(-1).type, 'failed'); publicOnly(stream);
    publicOnly(await (await f.request('/api/turns/t1')).json());
    for (const [code, expectedStatus] of [[hidden.error, 500], ['INPUT_INVALID', 422]] as const) {
      f.store.getWorld = async () => { throw new ServiceError(code, hidden.current, expectedStatus); };
      const failure = await f.request('/api/worlds/w1'); assert.equal(failure.status, expectedStatus); publicOnly(await failure.json());
    }
  } finally { await f.close(); }
});

test('consumer applications do not expose management APIs even to a developer identity', async () => {
  const f = await fixture();
  try {
    const requests: Array<[string, string?, unknown?]> = [
      ['/api/dev/prompts'], ['/api/dev/prompts/actor', 'PUT', { content: 'new', expectedVersion: 2 }],
      ['/api/dev/agent-catalog'], ['/api/dev/agents/actor/test', 'POST', { prompt: 'test', userText: '你好', sessionId: 's1' }],
      ['/api/turns/t1/trace'], ['/api/worlds/w1/runtime-audit'], ['/api/worlds/w1/runtime-audit/capture', 'POST', {}],
    ];
    for (const [path, method, body] of requests) {
      const response = await f.request(path, method, body, { 'x-user': 'alice', 'x-admin': 'yes' });
      assert.equal(response.status, 404, path); publicOnly(await response.json());
    }
  } finally { await f.close(); }
});

test('admin audience gates every API and preserves prompts and traces for authorized operators', async () => {
  const f = await fixture({ audience: 'admin' });
  try {
    for (const path of ['/api/bootstrap', '/api/worlds/w1', '/api/dev/prompts', '/api/turns/t1/trace']) {
      assert.equal((await f.request(path, 'GET', undefined, {})).status, 401, path);
      assert.equal((await f.request(path)).status, 403, path);
    }
    assert.equal(f.protectedReads(), 0, 'Unauthorized admin requests must not reach the store');
    const headers = { 'x-user': 'alice', 'x-admin': 'yes' };
    const bootstrap = await f.request('/api/bootstrap', 'GET', undefined, headers); assert.equal(bootstrap.status, 200);
    assert(JSON.stringify(await bootstrap.json()).includes(hidden.definition));
    const prompts = await f.request('/api/dev/prompts', 'GET', undefined, headers); assert.equal(prompts.status, 200);
    const promptBody = JSON.stringify(await prompts.json());
    for (const secret of [hidden.current, hidden.defaults, hidden.history]) assert(promptBody.includes(secret));
    const trace = await f.request('/api/turns/t1/trace', 'GET', undefined, headers); assert.equal(trace.status, 200);
    assert(JSON.stringify(await trace.json()).includes(hidden.current));
  } finally { await f.close(); }
});


test('admin authentication and permission failures never disclose private adapter errors', async () => {
  for (const options of [
    { authenticate: () => { throw new ServiceError('AUTH_REQUIRED', hidden.current, 401); } },
    { authorize: () => { throw new ServiceError('DEVELOPER_REQUIRED', hidden.defaults, 403); } },
  ] satisfies FixtureOptions[]) {
    const f = await fixture({ audience: 'admin', ...options });
    try {
      const response = await f.request('/api/bootstrap');
      assert.equal(response.status, 'authenticate' in options ? 401 : 403);
      publicOnly(await response.json()); assert.equal(f.protectedReads(), 0);
    } finally { await f.close(); }
  }
});


test('unsafe API methods reject cross-site and non-JSON requests before touching the store', async () => {
  const f = await fixture();
  try {
    const writes: Array<[string, string, unknown, number]> = [
      ['/api/sessions/s1/turns', 'POST', { clientTurnId: 'csrf-check', content: '你好' }, 200],
      ['/api/player-profiles/p1', 'PUT', { name: '玩家', persona: '用户填写的身份', expectedVersion: 1 }, 200],
      ['/api/worlds/w1/scene', 'PATCH', { expectedRevision: 1, scene: { location: '书店', presentCharacterIds: ['c1'] } }, 200],
      ['/api/player-profiles/p1', 'DELETE', { expectedVersion: 1 }, 204],
    ];
    for (const [path, method, body] of writes) {
      const crossSite = await f.request(path, method, body, { 'x-user': 'alice', 'sec-fetch-site': 'cross-site' });
      assert.equal(crossSite.status, 403, method); publicOnly(await crossSite.json());
      for (const contentType of [undefined, 'application/x-www-form-urlencoded']) {
        const response = await f.rawRequest(path, { method, headers: { 'x-user': 'alice',
          ...(contentType ? { 'content-type': contentType } : {}) }, ...(contentType ? { body: 'expectedVersion=1' } : {}) });
        assert.equal(response.status, 415, `${method} ${contentType ?? 'missing Content-Type'}`); publicOnly(await response.json());
      }
    }
    assert.equal(f.protectedReads(), 0, 'Rejected writes must not execute store operations');
    assert.equal(f.generated(), 0, 'Rejected writes must not call the runtime');
    for (const [path, method, body, expectedStatus] of writes) {
      const response = await f.request(path, method, body, { 'x-user': 'alice', 'sec-fetch-site': 'same-origin' });
      assert.equal(response.status, expectedStatus, method);
      if (response.status !== 204) publicOnly(method === 'POST' ? events(await response.text()) : await response.json());
    }
    assert.equal(f.protectedReads(), writes.length);
    assert.equal(f.generated(), 1);
  } finally { await f.close(); }
});

test('public conflict and profile errors preserve client recovery codes without private messages', async () => {
  const f = await fixture();
  try {
    for (const [code, status, publicCode] of [
      ['PROFILE_CHANGED', 409, 'PROFILE_CHANGED'],
      ['PROFILE_NOT_FOUND', 404, 'PROFILE_NOT_FOUND'],
      ['REVISION_CONFLICT', 409, 'REVISION_CONFLICT'],
      [hidden.error, 404, 'NOT_FOUND'],
    ] as const) {
      f.store.getWorld = async () => { throw new ServiceError(code, hidden.current, status); };
      const response = await f.request('/api/worlds/w1');
      assert.equal(response.status, status);
      const result = await response.json(); publicOnly(result);
      assert.equal(result.error.code, publicCode);
      assert.equal(typeof result.error.message, 'string'); assert(result.error.message.length > 0);
    }
  } finally { await f.close(); }
});
