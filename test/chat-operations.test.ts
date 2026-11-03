/**
 * HTTP + real PostgreSQL integration tests for chatType operation signals.
 *
 * Frozen contract: .chat-ops/BRIEF.md §2.1/§2.3, plus backend-store's broadcast
 * of the final 018 column names (chat_type/target_turn_id/request_hash/
 * continuation/rewrite_reference/snapshot_id/committed_revision/archived_at/
 * superseded_by, world_snapshots, world_settlement_archive).
 *
 * Every assertion here is an HTTP-layer fact, a database fact, or a fact about
 * the ActorInput the server actually froze for a turn — never just a prompt
 * string. Prompt-content assertions live in test/chat-operation-runtime.test.ts.
 *
 * Run alone:
 *   node --no-warnings --experimental-transform-types test/chat-operations.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import type { StoryStore } from '../server/store.ts';
import type { StoryRuntime, ActorInput, WorldTurnResult } from '../server/runtime.ts';
import type { SessionDetail, TurnEvent, TurnView, Message, SceneState } from '../shared/contracts.ts';
import { postgresFixture } from './pg-helper.ts';

const runtimeStatus: StoryRuntime['status'] = { provider: 'demo', model: 'test-fake', harness: { loaded: true, version: 'test' }, offlineSimulation: false };

interface Recording {
  actors: ActorInput[];
  updaters: Array<ActorInput & { assistantText?: string }>;
  settlements: ActorInput[];
  settlementTexts: string[];
  /** OperationContext values handed to the injected resolveOperationRuntime hook. */
  contexts: Array<Record<string, any>>;
}
const recording = (): Recording => ({ actors: [], updaters: [], settlements: [], settlementTexts: [], contexts: [] });

interface LivingOptions {
  reply?: (input: ActorInput, index: number) => string;
  scene?: (input: ActorInput, index: number) => SceneState | undefined;
  actorGate?: (input: ActorInput, index: number) => Promise<void> | undefined;
  failActor?: (input: ActorInput, index: number) => boolean;
  settleChanges?: (input: ActorInput, text: string) => unknown[];
  settleMemory?: (input: ActorInput, text: string) => unknown[];
  settleLedger?: (input: ActorInput) => unknown[];
  settlementGate?: (input: ActorInput) => Promise<void> | undefined;
  failSettlement?: (input: ActorInput) => boolean;
}

const defaultReply = (input: ActorInput) => input.userText
  ? `林晚把「${input.userText}」记在心里。`
  : '林晚合上书，安静地等着。';

function livingRuntime(rec: Recording, options: LivingOptions = {}): StoryRuntime {
  let generations = 0;
  const runtime: StoryRuntime = {
    status: runtimeStatus,
    metadata: { runtimeFingerprint: 'fixture-chat-operations-v1', probe: 'chat-operations' },
    actor: async (input) => ({ text: options.reply?.(input, generations++) ?? defaultReply(input) }),
    updateWorld: async (input) => { rec.updaters.push(input); return { changes: [] }; },
    streamDialogue: async (input, callOptions) => {
      const index = generations++;
      rec.actors.push(input);
      if (options.actorGate) await options.actorGate(input, index);
      if (options.failActor?.(input, index)) throw new Error('fixture model failure');
      const text = options.reply?.(input, index) ?? defaultReply(input);
      callOptions.onTextDelta(text);
      const observations: Record<string, string> = {};
      const characterIds = input.scene?.mode === 'direct'
        ? [input.character.id]
        : Object.keys(input.worldContext?.actorInputs ?? {}).length ? Object.keys(input.worldContext!.actorInputs) : [input.character.id];
      for (const characterId of characterIds) observations[characterId] = input.operation === 'opening' || input.scene?.playerPresent === false ? '' : input.userText;
      const result: WorldTurnResult = {
        text,
        replies: [{ characterId: input.character.id, characterName: input.character.name, text }],
        changes: [], entityChanges: [], activities: [], usage: {}, observations,
        ...(options.scene?.(input, index) !== undefined ? { scene: options.scene!(input, index) } : {}),
      };
      return result;
    },
    runWorldTurn: async (input, options) => runtime.streamDialogue!(input, options),
    settleWorldTurn: async (input, dialogue) => {
      rec.settlements.push(input);
      rec.settlementTexts.push(dialogue.text);
      if (options.settlementGate) await options.settlementGate(input);
      if (options.failSettlement?.(input)) throw new Error('fixture settlement failure');
      return {
        ...dialogue,
        changes: (options.settleMemory?.(input, dialogue.text) ?? []) as WorldTurnResult['changes'],
        entityChanges: (options.settleChanges?.(input, dialogue.text) ?? []) as WorldTurnResult['entityChanges'],
        ...(options.settleLedger ? { eventLedger: options.settleLedger(input) as WorldTurnResult['eventLedger'] } : {}),
      };
    },
  };
  return runtime;
}

interface Fixture {
  store: StoryStore;
  base: string;
  session: SessionDetail;
  post: (path: string, body?: unknown, owner?: string) => Promise<Response>;
  get: (path: string, owner?: string) => Promise<Response>;
}
interface FixtureOptions { rec?: Recording; runtime?: LivingOptions }

async function fixture(work: (f: Fixture) => Promise<void>, options: FixtureOptions = {}): Promise<void> {
  const database = await postgresFixture({ livingWorld: true });
  const rec = options.rec ?? recording();
  const runtime = livingRuntime(rec, options.runtime);
  // Operation turns must reach the same fake runtime in tests; the resolver is a
  // test hook for that (production defaults to a fresh loadRuntime per operation).
  const appOptions = {
    store: database.store, runtime,
    authenticate: (request: { get(name: string): string | undefined }) => request.get('x-test-owner') ?? 'alice',
    resolveOperationRuntime: async (context: Record<string, any>) => { rec.contexts.push(context); return runtime; },
  } as Parameters<typeof createApp>[0];
  const app = createApp(appOptions);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}, owner = 'alice') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(body) });
  const get = (path: string, owner = 'alice') => fetch(base + path, { headers: { 'x-test-owner': owner } });
  try {
    await work({ store: database.store, base, session: await database.store.createSession('alice', 'lin-wan'), post, get });
  } finally {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.cleanup();
  }
}

async function until(check: () => boolean | Promise<boolean>, label = 'state'): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function parseBlock(block: string): TurnEvent | null {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  return JSON.parse(data) as TurnEvent;
}

async function* sseEvents(response: Response): AsyncGenerator<TurnEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) { const event = parseBlock(block); if (event) yield event; }
  }
  if (buffer.trim()) { const event = parseBlock(buffer); if (event) yield event; }
  reader.releaseLock();
}

interface TurnPost { status: number; events: TurnEvent[]; error?: { error?: { code?: string; message?: string } } }

async function sendTurn(base: string, sessionId: string, body: unknown, owner = 'alice'): Promise<TurnPost> {
  const response = await fetch(`${base}/api/sessions/${sessionId}/turns`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(body) });
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: response.status, events: [], error: await response.json().catch(() => null) };
  }
  const events: TurnEvent[] = [];
  for await (const event of sseEvents(response)) events.push(event);
  return { status: response.status, events };
}

/** Open the SSE stream and expose events before draining the rest. */
async function openTurn(base: string, sessionId: string, body: unknown, owner = 'alice') {
  const response = await fetch(`${base}/api/sessions/${sessionId}/turns`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, 'operation turn must open an SSE stream');
  const iterator = sseEvents(response);
  return {
    async first(): Promise<TurnEvent> {
      const next = await iterator.next();
      assert.equal(next.done, false, 'expected at least one SSE event');
      return next.value;
    },
    async rest(events: TurnEvent[] = []): Promise<TurnEvent[]> {
      for await (const event of iterator) events.push(event);
      return events;
    },
  };
}

function committedEvent(events: TurnEvent[]) {
  const committed = events.find((event) => event.type === 'committed');
  assert.ok(committed, `expected a committed event, got ${events.map((event) => event.type).join(',') || '(none)'}`);
  assert.equal(committed.type, 'committed');
  return committed;
}
const terminalEvent = (events: TurnEvent[]) => events.at(-1);
const acceptedEvent = (events: TurnEvent[]) => {
  const accepted = events[0];
  assert.equal(accepted?.type, 'accepted', `expected accepted first, got ${accepted?.type}`);
  assert.equal(accepted.type, 'accepted');
  return accepted;
};

function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
/** Frozen §2.1 identity; chatType is canonical lowercase. */
function requestHash(input: { chatType: string; targetTurnId?: string | null; content?: string | null }) {
  return sha256(JSON.stringify({ chatType: input.chatType.toLowerCase(), targetTurnId: input.targetTurnId ?? null, content: input.content ?? null }));
}

// ---------------------------------------------------------------- schema ----
async function columns(store: StoryStore, table: string): Promise<Set<string>> {
  const rows = (await store.pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1', [table])).rows;
  return new Set(rows.map((row) => String(row.column_name)));
}
async function tableExists(store: StoryStore, table: string): Promise<boolean> {
  return (await store.pool.query('SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=$1', [table])).rowCount === 1;
}
async function columnNames(store: StoryStore, table: string) { return await columns(store, table); }
async function turnRow(store: StoryStore, id: string) {
  const names = await columns(store, 'turns');
  const wanted = ['operation', 'chat_type', 'target_turn_id', 'request_hash', 'continuation', 'rewrite_reference', 'snapshot_id', 'committed_revision', 'archived_at', 'superseded_by', 'seq', 'status', 'base_revision']
    .filter((name) => names.has(name));
  return (await store.pool.query(`SELECT ${wanted.map((name) => `"${name}"`).join(',')} FROM turns WHERE id=$1`, [id])).rows[0] as Record<string, any>;
}
async function messageRows(store: StoryStore, sessionId: string) {
  const names = await columns(store, 'messages');
  const archived = names.has('archived_at') ? ',archived_at' : '';
  return (await store.pool.query(`SELECT id,role,content,kind,turn_id,seq${archived} FROM messages WHERE session_id=$1 ORDER BY seq`, [sessionId])).rows as Array<Record<string, any>>;
}
async function activeSettlement(store: StoryStore, turnId: string) {
  return (await store.pool.query('SELECT id,status,attempts,error_code FROM world_settlements WHERE turn_id=$1', [turnId])).rows[0] as Record<string, any> | undefined;
}
async function archivedSettlement(store: StoryStore, turnId: string) {
  if (!await tableExists(store, 'world_settlement_archive')) return undefined;
  return (await store.pool.query('SELECT * FROM world_settlement_archive WHERE turn_id=$1', [turnId])).rows[0] as Record<string, any> | undefined;
}
async function visibleMessages(base: string, sessionId: string, owner = 'alice'): Promise<Message[]> {
  const detail = await (await fetch(`${base}/api/sessions/${sessionId}`, { headers: { 'x-test-owner': owner } })).json() as SessionDetail;
  return detail.messages;
}
async function turnView(base: string, turnId: string): Promise<TurnView> {
  return await (await fetch(`${base}/api/turns/${turnId}`, { headers: { 'x-test-owner': 'alice' } })).json() as TurnView;
}

/** Stable projection of every world-derived surface a rewrite must roll back. */
interface WorldFacts {
  revision: number; scene: unknown; clockMode: string; clockRate: number; storyElapsedMs: number; storyTime: unknown;
  entities: unknown[]; archivedEntityIds: string[]; knowledge: unknown[]; memory: unknown[]; storyEvents: unknown[]; events: unknown[]; direction: unknown[];
}
function withoutVolatileScene(value: unknown) {
  if (!value || typeof value !== 'object') return value;
  const scene = { ...(value as Record<string, unknown>) };
  delete scene.updatedAt;
  return scene;
}
const VOLATILE_ENTITY_STATE = new Set(['lastEncounterAt', 'lastEncounterStoryTime', 'lastSettledAt', 'lastSettledWorldMs', 'lastSettledActiveMs', 'lastSettledStoryTime', 'lastSettledStoryMs']);
function stableState(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state;
  const copy = { ...(state as Record<string, unknown>) };
  for (const key of VOLATILE_ENTITY_STATE) delete copy[key];
  return copy;
}
function stableEntity(entity: Record<string, any>): Record<string, any> {
  return { ...entity, state: stableState(entity.state) };
}
async function worldFacts(store: StoryStore, worldId: string): Promise<WorldFacts> {
  const rows = async (sql: string, params?: unknown[]) => (await store.pool.query(sql, params ?? (sql.includes('$1') ? [worldId] : []))).rows as Array<Record<string, any>>;
  const world = (await rows('SELECT * FROM worlds WHERE id=$1'))[0];
  const entityNames = await columns(store, 'world_entities');
  const entityArchived = entityNames.has('archived_at') ? 'WHERE archived_at IS NULL' : '';
  const entityColumns = ['id', 'kind', 'name', 'description', 'state', 'known_by_character_ids', 'version', ...(entityNames.has('archived_at') ? ['archived_at'] : [])].join(',');
  return {
    revision: Number(world.revision),
    scene: withoutVolatileScene(world.scene),
    clockMode: world.clock_mode,
    clockRate: world.clock_rate,
    storyElapsedMs: Number(world.story_elapsed_ms),
    storyTime: world.story_time,
    entities: (await rows(`SELECT ${entityColumns} FROM world_entities ${entityArchived} ORDER BY id`)).map((row) => stableEntity({ ...row, archived_at: undefined, version: Number(row.version) })),
    archivedEntityIds: entityNames.has('archived_at') ? (await rows('SELECT id FROM world_entities WHERE archived_at IS NOT NULL ORDER BY id')).map((row) => String(row.id)) : [],
    knowledge: (await rows('SELECT character_id,entity_id,version,snapshot FROM world_entity_knowledge ORDER BY character_id,entity_id')).map((row) => ({ ...row, version: Number(row.version), snapshot: row.snapshot ? { ...row.snapshot, state: stableState(row.snapshot.state) } : row.snapshot })),
    memory: await rows('SELECT character_id,source_turn_id,summary FROM world_memory_snapshots ORDER BY character_id,summary'),
    storyEvents: await rows('SELECT id,version,record,source_turn_id FROM world_story_events ORDER BY id'),
    events: await rows('SELECT kind,text,visibility,character_id,source_turn_id,status FROM events ORDER BY text'),
    direction: await rows('SELECT status,plan,error_code FROM world_directions'),
  };
}
/** Facts a successful rewrite must restore, excluding monotonic revision. */
function restorable(facts: WorldFacts, includeDirection = true) {
  return {
    scene: facts.scene, clockMode: facts.clockMode, clockRate: facts.clockRate,
    storyElapsedMs: facts.storyElapsedMs, storyTime: facts.storyTime,
    entities: facts.entities, knowledge: facts.knowledge, memory: facts.memory,
    storyEvents: facts.storyEvents, events: facts.events,
    ...(includeDirection ? { direction: facts.direction } : {}),
  };
}

const dialogueOnly = (messages: Message[]) => messages.filter((message) => message.kind !== 'operation').map((message) => [message.id, message.content]);
async function settled(store: StoryStore, turnId: string) {
  let last: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 400; attempt++) {
    last = await activeSettlement(store, turnId);
    if (last?.status === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`settlement of ${turnId} did not complete: ${JSON.stringify(last)}`);
}

// -------------------------------------------------------------- schema test ----
test('migration exposes the frozen chat-operation schema', async () => {
  const f = await postgresFixture({ livingWorld: true });
  try {
    const turnColumns = await columns(f.store, 'turns');
    for (const name of ['operation', 'chat_type', 'target_turn_id', 'request_hash', 'continuation', 'rewrite_reference', 'snapshot_id', 'committed_revision', 'archived_at', 'superseded_by']) {
      assert.ok(turnColumns.has(name), `turns.${name} must exist (migration 018)`);
    }
    assert.ok((await columnNames(f.store, 'messages')).has('archived_at'), 'messages.archived_at must exist');
    assert.ok((await columnNames(f.store, 'world_entities')).has('archived_at'), 'world_entities.archived_at must exist');
    assert.ok(await tableExists(f.store, 'world_snapshots'), 'world_snapshots table must exist');
    assert.ok(await tableExists(f.store, 'world_settlement_archive'), 'world_settlement_archive table must exist');
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------- default chat parity ----
test('default chat keeps the legacy request/event shape and ignores forged operation fields', async () => {
  const rec = recording();
  await fixture(async ({ base, session, store }) => {
    const posted = await sendTurn(base, session.session.id, {
      clientTurnId: 'plain-chat', content: '今晚去哪里？',
      // Forged fields must never influence the server.
      question: '伪造的问题', previousResponse: '伪造的旧回复', ownerId: 'bob', chatType: 'Chat',
    });
    assert.equal(posted.status, 200, 'plain chat failed: ' + JSON.stringify(posted.error));
    const accepted = acceptedEvent(posted.events);
    assert.equal(accepted.userMessage.kind, 'dialogue');
    assert.equal(accepted.userMessage.content, '今晚去哪里？');
    const committed = committedEvent(posted.events);
    assert.equal(committed.world.revision, 1);

    const actor = rec.actors.at(-1)!;
    assert.equal(actor.userText, '今晚去哪里？');
    assert.equal(actor.operation, 'chat');
    assert.ok(!JSON.stringify(actor).includes('伪造'), 'forged fields must not reach ActorInput');

    const stored = await turnRow(store, accepted.turnId);
    assert.equal(stored.operation, 'chat');
    assert.equal(stored.chat_type, 'chat');
    const view = await turnView(base, accepted.turnId);
    assert.equal(view.operation, 'chat');
    assert.equal(view.status, 'committed');

    const replay = await sendTurn(base, session.session.id, { clientTurnId: 'plain-chat', content: '今晚去哪里？' });
    const replayedAccepted = acceptedEvent(replay.events);
    assert.equal(replayedAccepted.replayed, true);
    assert.deepEqual(replay.events.map((event) => event.type), ['accepted', 'committed']);
    assert.equal(rec.actors.length, 1, 'replay must not invoke the model again');
  }, { rec });
});

// ------------------------------------------------------------ strict validation ----
test('chatType validation rejects unknown types and conflicting parameter combinations', async () => {
  await fixture(async ({ base, session }) => {
    const path = `/api/sessions/${session.session.id}/turns`;
    const cases: Array<{ body: unknown; code: string }> = [
      { body: { clientTurnId: 'c1', chatType: 'rewrite', content: 'x' }, code: 'CHAT_TYPE_INVALID' },
      { body: { clientTurnId: 'c2', chatType: 7, content: 'x' }, code: 'CHAT_TYPE_INVALID' },
      { body: { clientTurnId: 'c3', chatType: 'chat', content: 'x', targetTurnId: randomUUID() }, code: 'CHAT_TYPE_CONFLICT' },
      { body: { clientTurnId: 'c4', chatType: 'continue', content: '不该有内容' }, code: 'CHAT_TYPE_CONFLICT' },
      { body: { clientTurnId: 'c5', chatType: 'continue', targetTurnId: randomUUID() }, code: 'CHAT_TYPE_CONFLICT' },
      { body: { clientTurnId: 'c6', chatType: 'regenerate', content: '不该有内容', targetTurnId: randomUUID() }, code: 'CHAT_TYPE_CONFLICT' },
      { body: { clientTurnId: 'c7', chatType: 'regenerate' }, code: 'TARGET_INVALID' },
      { body: { clientTurnId: 'c8', chatType: 'edit_regenerate', targetTurnId: randomUUID() }, code: 'INPUT_INVALID' },
      { body: { clientTurnId: 'c9', chatType: 'edit_regenerate', content: 'x' }, code: 'TARGET_INVALID' },
      { body: { chatType: 'continue' }, code: 'INPUT_INVALID' },
    ];
    for (const item of cases) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'alice' }, body: JSON.stringify(item.body) });
      assert.equal(response.status, 422, `expected 422 for ${JSON.stringify(item.body)}`);
      const body = await response.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, item.code, `expected ${item.code} for ${JSON.stringify(item.body)}`);
    }
  });
});

test('PascalCase chatType values are accepted and normalized to the canonical lowercase identity', async () => {
  const rec = recording();
  await fixture(async ({ base, session, store }) => {
    const send = async (body: Record<string, unknown>) => {
      const posted = await sendTurn(base, session.session.id, body);
      assert.equal(posted.status, 200, JSON.stringify(posted.error));
      return acceptedEvent(posted.events);
    };
    const plain = await send({ clientTurnId: 'pascal-chat', content: '第一句。', chatType: 'Chat' });
    assert.equal((await turnRow(store, plain.turnId)).chat_type, 'chat');
    await settled(store, plain.turnId);

    const continued = await send({ clientTurnId: 'pascal-continue', chatType: 'Continue' });
    const continuedRow = await turnRow(store, continued.turnId);
    assert.equal(continuedRow.chat_type, 'continue');
    assert.equal(continuedRow.request_hash, requestHash({ chatType: 'continue', targetTurnId: null, content: null }));
    await settled(store, continued.turnId);

    // A rewrite may only target an ordinary chat turn.
    const fresh = await send({ clientTurnId: 'pascal-fresh', content: '准备重写的一轮。' });
    await settled(store, fresh.turnId);

    const regenerated = await send({ clientTurnId: 'pascal-regenerate', chatType: 'Regenerate', targetTurnId: fresh.turnId });
    const regenerateRow = await turnRow(store, regenerated.turnId);
    assert.equal(regenerateRow.chat_type, 'regenerate');
    assert.equal(regenerateRow.target_turn_id, fresh.turnId);
    assert.equal(regenerateRow.request_hash, requestHash({ chatType: 'regenerate', targetTurnId: fresh.turnId, content: null }));
    await settled(store, regenerated.turnId);

    const edited = await send({ clientTurnId: 'pascal-edit', chatType: 'EditRegenerate', targetTurnId: regenerated.turnId, content: '编辑后的新问题。' });
    const editRow = await turnRow(store, edited.turnId);
    assert.equal(editRow.chat_type, 'edit_regenerate');
    assert.equal(editRow.target_turn_id, regenerated.turnId);
    assert.equal(editRow.request_hash, requestHash({ chatType: 'edit_regenerate', targetTurnId: regenerated.turnId, content: '编辑后的新问题。' }));
    assert.equal((await turnView(base, edited.turnId)).status, 'committed');
  }, { rec });
});

// ----------------------------------------------------------------- continue ----
test('continue stores an operation message with the exact continuation tail and no fake player evidence', async () => {
  const rec = recording();
  const firstReply = '林晚把信折好，放进抽屉。\n\n“明天再说吧。”';
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'first', content: '把信收好。' });
    const firstCommitted = committedEvent(first.events);
    const firstTurnId = firstCommitted.turnId;
    const savedAssistant = (firstCommitted.messages ?? [firstCommitted.message]).find((message) => message.role === 'assistant')!;
    assert.equal(savedAssistant.content, firstReply);
    await settled(store, firstTurnId);

    const before = await worldFacts(store, session.world.id);
    const continued = await sendTurn(base, session.session.id, { clientTurnId: 'continue-1', chatType: 'continue' });
    assert.equal(continued.status, 200);
    const accepted = acceptedEvent(continued.events);
    assert.equal(accepted.userMessage.role, 'user');
    assert.equal(accepted.userMessage.kind, 'operation');
    assert.equal(accepted.userMessage.content, '（继续）');
    const committed = committedEvent(continued.events);
    assert.equal(committed.turnId, accepted.turnId);

    // ActorInput boundary: continue carries no user text at all.
    const actor = rec.actors.at(-1)!;
    assert.equal(actor.userText, '');
    assert.equal(actor.operation, 'chat', 'harness contract keeps operation values chat|opening');

    // Server-authoritative continuation reference, frozen at begin time.
    const stored = await turnRow(store, accepted.turnId);
    assert.equal(stored.chat_type, 'continue');
    assert.equal(stored.target_turn_id, null);
    assert.equal(stored.request_hash, requestHash({ chatType: 'continue', targetTurnId: null, content: null }));
    const continuation = stored.continuation;
    assert.ok(continuation && typeof continuation === 'object', 'turns.continuation must freeze the reference');
    assert.equal(continuation.turnId, firstTurnId);
    assert.equal(continuation.messageId, savedAssistant.id);
    assert.equal(continuation.text, firstReply, 'continuation must be the exact saved assistant text');

    // The operation context handed to the runtime factory mirrors the frozen data.
    const context = rec.contexts.at(-1);
    assert.ok(context, 'operation turns must resolve a per-turn operation runtime');
    assert.equal(context!.chatType, 'continue');
    assert.equal(context!.continuation?.turnId, firstTurnId);
    assert.equal(context!.continuation?.text, firstReply);

    // WorldOps receives no operation text and creates no player memory.
    await settled(store, accepted.turnId);
    const settlement = rec.settlements.find((input) => input.turnId === accepted.turnId);
    assert.ok(settlement, 'continue must settle through WorldOps');
    assert.equal(settlement!.userText, '');
    const memoryRows = (await store.pool.query('SELECT text FROM events WHERE source_turn_id=$1', [accepted.turnId])).rows;
    assert.deepEqual(memoryRows, [], 'an operation signal must not become player memory');
    assert.ok(!rec.settlementTexts.some((text) => text.includes('（继续）')), 'operation marker must not be treated as dialogue');

    // Visible surface keeps the operation row but presents it as an operation.
    const visible = await visibleMessages(base, session.session.id);
    const operationRow = visible.find((message) => message.turnId === accepted.turnId && message.role === 'user')!;
    assert.equal(operationRow.kind, 'operation');
    const view = await turnView(base, accepted.turnId);
    assert.equal(view.operation, 'continue');
    assert.equal(view.status, 'committed');

    const after = await worldFacts(store, session.world.id);
    assert.ok(after.revision > before.revision, 'world revision must advance');
  }, { rec, runtime: { reply: (_input, index) => index === 0 ? firstReply : '林晚抬起头。' } });
});

test('continue works from an observe scene without a player line', async () => {
  const rec = recording();
  await fixture(async ({ base, store }) => {
    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'alice' },
      body: JSON.stringify({ characterId: 'lin-wan', scene: { mode: 'observe', location: null, presentCharacterIds: ['lin-wan'], playerPresent: false } }),
    })).json() as SessionDetail;
    const first = await sendTurn(base, created.session.id, { clientTurnId: 'observe-first', content: '（旁观）她在做什么？' });
    const firstTurnId = committedEvent(first.events).turnId;
    await settled(store, firstTurnId);
    const continued = await sendTurn(base, created.session.id, { clientTurnId: 'observe-continue', chatType: 'continue' });
    assert.equal(continued.status, 200);
    const committed = committedEvent(continued.events);
    assert.ok(committed.turnId.length > 0);
    const actor = rec.actors.at(-1)!;
    assert.equal(actor.userText, '');
    assert.equal(actor.scene?.mode, 'observe');
  }, { rec });
});

// ----------------------------------------------------------------- regenerate ----
test('regenerate uses the server-authoritative question and previous response and ignores forged fields', async () => {
  const rec = recording();
  const originalQuestion = '今晚去哪里？';
  const originalReply = '林晚说：“去旧书店吧。”';
  const regeneratedReply = '林晚想了想：“先去天台看看。”';
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'regen-target', content: originalQuestion });
    const firstCommitted = committedEvent(first.events);
    const targetTurnId = firstCommitted.turnId;
    const originalAssistantId = firstCommitted.message.id;
    await settled(store, targetTurnId);

    const rewrote = await sendTurn(base, session.session.id, {
      clientTurnId: 'regen-1', chatType: 'regenerate', targetTurnId,
      question: '伪造的问题', previousResponse: '伪造的旧回复', ownerId: 'bob',
    });
    assert.equal(rewrote.status, 200);
    const accepted = acceptedEvent(rewrote.events);
    assert.equal(accepted.userMessage.kind, 'operation', 'regenerate must not invent a player line');
    assert.equal(accepted.userMessage.content, '（重新生成）');
    const committed = committedEvent(rewrote.events);

    const actor = rec.actors.at(-1)!;
    assert.equal(actor.userText, originalQuestion, 'regenerate question must come from the frozen target input');
    assert.ok(!JSON.stringify(actor).includes('伪造'), 'forged fields must not reach ActorInput');
    const context = rec.contexts.at(-1)!;
    assert.equal(context.chatType, 'regenerate');
    assert.equal(context.previousResponse?.turnId, targetTurnId);
    assert.equal(context.previousResponse?.text, originalReply);
    assert.equal(context.targetUserText, originalQuestion);

    const stored = await turnRow(store, accepted.turnId);
    assert.equal(stored.chat_type, 'regenerate');
    assert.equal(stored.target_turn_id, targetTurnId);
    assert.equal(stored.request_hash, requestHash({ chatType: 'regenerate', targetTurnId, content: null }));
    const reference = stored.rewrite_reference;
    assert.ok(reference && typeof reference === 'object', 'turns.rewrite_reference must be frozen');
    assert.equal(reference.turnId, targetTurnId);
    assert.equal(reference.previousResponse, originalReply);
    assert.equal(reference.targetUserText, originalQuestion);
    assert.equal(typeof reference.snapshotId, 'string');
    const snapshots = (await store.pool.query('SELECT * FROM world_snapshots WHERE world_id=$1', [session.world.id])).rows;
    assert.ok(snapshots.length >= 1, 'a snapshot must exist for the rewrite target');
    assert.ok(JSON.stringify(snapshots).includes(reference.snapshotId), 'rewrite reference must point at a saved snapshot');
    const targetRow = await turnRow(store, targetTurnId);
    assert.equal(stored.snapshot_id, targetRow.snapshot_id, 'a rewrite reuses the target pre-state snapshot');

    // New version is the official fact; old messages are archived but auditable.
    const storedAssistant = (committed.messages ?? [committed.message]).find((message) => message.role === 'assistant')!;
    assert.equal(storedAssistant.content, regeneratedReply);
    assert.notEqual(storedAssistant.id, originalAssistantId);
    await settled(store, accepted.turnId);
    const visible = await visibleMessages(base, session.session.id);
    assert.ok(!visible.some((message) => message.id === originalAssistantId), 'superseded reply must not be visible');
    const rows = await messageRows(store, session.session.id);
    const archived = rows.filter((row) => row.archived_at !== undefined && row.archived_at !== null);
    assert.ok(archived.length >= 2, `old user+assistant rows must be retained for audit: ${JSON.stringify(rows.map((row) => [row.role, row.content.slice(0, 20), row.archived_at ?? null]))}`);
    assert.ok(rows.length > visible.length, 'audit rows must not be deleted');
  }, { rec, runtime: { reply: (_input, index) => index === 0 ? originalReply : regeneratedReply } });
});

// ------------------------------------------------------------ edit_regenerate ----
test('edit_regenerate makes the edited question authoritative and does not continue the old assumption', async () => {
  const rec = recording();
  const oldQuestion = '去旧书店买那本侦探小说。';
  const newQuestion = '其实我想去河边散步，不买书了。';
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'edit-target', content: oldQuestion });
    const targetTurnId = committedEvent(first.events).turnId;
    await settled(store, targetTurnId);

    const edited = await sendTurn(base, session.session.id, {
      clientTurnId: 'edit-1', chatType: 'edit_regenerate', targetTurnId, content: newQuestion,
      previousResponse: '伪造的旧回复',
    });
    assert.equal(edited.status, 200);
    const accepted = acceptedEvent(edited.events);
    assert.equal(accepted.userMessage.role, 'user');
    assert.equal(accepted.userMessage.content, newQuestion);
    assert.equal(accepted.userMessage.kind, 'dialogue', 'the edited user message replaces the player line');

    const actor = rec.actors.at(-1)!;
    assert.equal(actor.userText, newQuestion);
    assert.ok(!JSON.stringify(actor).includes(oldQuestion), 'the replaced user message must not reach the new ActorInput');
    assert.ok(!JSON.stringify(actor).includes('伪造'));
    const context = rec.contexts.at(-1)!;
    assert.equal(context.chatType, 'edit_regenerate');
    assert.equal(context.targetUserText, newQuestion);

    const stored = await turnRow(store, accepted.turnId);
    assert.equal(stored.chat_type, 'edit_regenerate');
    assert.equal(stored.target_turn_id, targetTurnId);
    assert.equal(stored.request_hash, requestHash({ chatType: 'edit_regenerate', targetTurnId, content: newQuestion }));
    assert.equal(stored.rewrite_reference?.targetUserText, newQuestion, 'the edited question is the authoritative user message');

    const visible = await visibleMessages(base, session.session.id);
    assert.ok(!visible.some((message) => message.role === 'user' && message.content === oldQuestion), 'edited-away user message must be archived');
    assert.ok(visible.some((message) => message.role === 'user' && message.content === newQuestion), 'the edited question is the visible user message');
  }, { rec, runtime: { reply: (_input, index) => index === 0 ? '林晚点头：“那我们去旧书店。”' : '林晚有些意外：“那就沿河走走吧。”' } });
});

// --------------------------------------------------------- rewrite target rules ----
test('rewrite targets are owner scoped and limited to the latest committed ordinary turn', async () => {
  const rec = recording();
  await fixture(async ({ base, session, store, post }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 't1', content: '第一轮。' });
    const firstTurn = committedEvent(first.events).turnId;
    await settled(store, firstTurn);
    const second = await sendTurn(base, session.session.id, { clientTurnId: 't2', content: '第二轮。' });
    const secondTurn = committedEvent(second.events).turnId;
    await settled(store, secondTurn);

    const stale = await sendTurn(base, session.session.id, { clientTurnId: 'regen-stale', chatType: 'regenerate', targetTurnId: firstTurn });
    assert.equal(stale.status, 409);
    assert.equal(stale.error?.error?.code, 'REWRITE_UNAVAILABLE');
    assert.match(String(stale.error?.error?.message), /最新|重写/u);

    // A different owner cannot reference this turn.
    const bobSession = await (await post('/api/sessions', { characterId: 'lin-wan' }, 'bob')).json() as SessionDetail;
    const foreign = await sendTurn(base, bobSession.session.id, { clientTurnId: 'regen-foreign', chatType: 'regenerate', targetTurnId: secondTurn }, 'bob');
    assert.equal(foreign.status, 404, JSON.stringify(foreign.error));
    assert.equal(foreign.error?.error?.code, 'TURN_NOT_FOUND', JSON.stringify(foreign.error));

    // Same owner, but the target belongs to another session.
    const otherSession = await (await post('/api/sessions', { characterId: 'lin-wan' })).json() as SessionDetail;
    const cross = await sendTurn(base, otherSession.session.id, { clientTurnId: 'regen-cross', chatType: 'regenerate', targetTurnId: secondTurn });
    assert.equal(cross.status, 404, JSON.stringify(cross.error));
    assert.equal(cross.error?.error?.code, 'TURN_NOT_FOUND', JSON.stringify(cross.error));

    // Malformed target ids are validation errors, not rewrites.
    const malformed = await sendTurn(base, session.session.id, { clientTurnId: 'regen-bad', chatType: 'regenerate', targetTurnId: 'not-a-turn-id' });
    assert.equal(malformed.status, 422);
    assert.equal(malformed.error?.error?.code, 'TARGET_INVALID');

    // A scene edit after the target is a later world interaction: no longer safely restorable.
    const current = await (await fetch(`${base}/api/sessions/${session.session.id}`, { headers: { 'x-test-owner': 'alice' } })).json() as SessionDetail;
    const edited = await fetch(`${base}/api/worlds/${session.world.id}/scene`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-owner': 'alice' },
      body: JSON.stringify({ expectedRevision: current.world.revision, scene: { ...current.world.scene, location: '天台' }, sessionId: session.session.id }),
    });
    assert.equal(edited.status, 200, `scene edit failed: ${await edited.clone().text()}`);
    const afterWorldChange = await sendTurn(base, session.session.id, { clientTurnId: 'regen-after-scene', chatType: 'regenerate', targetTurnId: secondTurn });
    assert.equal(afterWorldChange.status, 409);
    assert.equal(afterWorldChange.error?.error?.code, 'REWRITE_UNAVAILABLE');
  }, { rec });
});

test('an opening turn can never be rewritten', async () => {
  const rec = recording();
  await fixture(async ({ base, post }) => {
    const created = await (await post('/api/sessions', { characterId: 'lin-wan', dynamicOpening: true })).json() as SessionDetail;
    const opening = await fetch(`${base}/api/sessions/${created.session.id}/opening`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'alice' }, body: JSON.stringify({ clientTurnId: `opening:${created.session.id}` }) });
    assert.equal(opening.status, 200);
    const events: TurnEvent[] = [];
    for await (const event of sseEvents(opening)) events.push(event);
    const committed = committedEvent(events);
    const attempt = await sendTurn(base, created.session.id, { clientTurnId: 'regen-opening', chatType: 'regenerate', targetTurnId: committed.turnId });
    assert.equal(attempt.status, 409);
    assert.equal(attempt.error?.error?.code, 'REWRITE_UNAVAILABLE');
  }, { rec });
});

// ------------------------------------------------------------------ idempotency ----
test('operation turns are idempotent by clientTurnId and reject a conflicting replay', async () => {
  const rec = recording();
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'idem-target', content: '原问题。' });
    const targetTurnId = committedEvent(first.events).turnId;
    await settled(store, targetTurnId);

    const request = { clientTurnId: 'idem-regen', chatType: 'regenerate', targetTurnId };
    const accepted = await sendTurn(base, session.session.id, request);
    assert.equal(accepted.status, 200);
    const acceptedTurnId = committedEvent(accepted.events).turnId;
    const calls = rec.actors.length;

    const replay = await sendTurn(base, session.session.id, request);
    assert.equal(replay.status, 200);
    assert.equal(acceptedEvent(replay.events).replayed, true);
    assert.deepEqual(replay.events.map((event) => event.type), ['accepted', 'committed']);
    assert.equal(committedEvent(replay.events).turnId, acceptedTurnId);
    assert.equal(rec.actors.length, calls, 'an idempotent replay must not call the model');

    const conflict = await sendTurn(base, session.session.id, { ...request, targetTurnId: randomUUID() });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.error?.error?.code, 'CLIENT_TURN_CONFLICT');
    const conflictingKind = await sendTurn(base, session.session.id, { clientTurnId: 'idem-regen', chatType: 'continue' });
    assert.equal(conflictingKind.status, 409);
    assert.equal(conflictingKind.error?.error?.code, 'CLIENT_TURN_CONFLICT');

    const stored = await turnRow(store, acceptedTurnId);
    assert.equal(stored.chat_type, 'regenerate');
    assert.equal(stored.target_turn_id, targetTurnId);
  }, { rec });
});

// --------------------------------------------------------- failure / cancellation ----
test('failed rewrite keeps the old reply and world intact and retries the same signal', async () => {
  const rec = recording();
  const originalReply = '林晚说：“别急，先坐下。”';
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'fail-target', content: '我很着急。' });
    const targetTurnId = committedEvent(first.events).turnId;
    await settled(store, targetTurnId);
    const visibleBefore = await visibleMessages(base, session.session.id);
    const factsBefore = await worldFacts(store, session.world.id);

    const failed = await sendTurn(base, session.session.id, { clientTurnId: 'fail-regen', chatType: 'regenerate', targetTurnId });
    assert.equal(failed.status, 200);
    const failedAccepted = acceptedEvent(failed.events);
    assert.equal(terminalEvent(failed.events)?.type, 'failed');
    assert.equal((await turnView(base, failedAccepted.turnId)).status, 'failed');

    const visibleAfter = await visibleMessages(base, session.session.id);
    assert.deepEqual(dialogueOnly(visibleAfter), dialogueOnly(visibleBefore), 'a failed rewrite must keep the old story untouched');
    assert.ok(visibleAfter.some((message) => message.kind === 'operation'), 'the failed operation keeps a status line, not a player line');
    const factsAfter = await worldFacts(store, session.world.id);
    assert.equal(factsAfter.revision, factsBefore.revision, 'a failed rewrite must not bump the world revision');
    assert.deepEqual(restorable(factsAfter, false), restorable(factsBefore, false), 'a failed rewrite must not change the world');

    // Retry must reuse the same operation identity (chatType + target), not a plain chat.
    const retried = await sendTurn(base, session.session.id, { clientTurnId: 'fail-regen', chatType: 'regenerate', targetTurnId });
    assert.equal(retried.status, 200);
    const retriedTurnId = committedEvent(retried.events).turnId;
    assert.equal((await turnView(base, retriedTurnId)).status, 'committed');
    const retriedTurn = await turnRow(store, retriedTurnId);
    assert.equal(retriedTurn.chat_type, 'regenerate');
    assert.equal(retriedTurn.target_turn_id, targetTurnId);
    assert.equal(rec.actors.at(-1)!.userText, '我很着急。');
  }, { rec, runtime: {
    reply: (_input, index) => index === 0 ? originalReply : '林晚沉默片刻。',
    failActor: (_input, index) => index === 1,
  } });
});

test('cancelled rewrite keeps the old world intact and keeps its chatType/target on retry', async () => {
  const rec = recording();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await fixture(async ({ base, session, store, post }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'cancel-target', content: '我们谈谈。' });
    const targetTurnId = committedEvent(first.events).turnId;
    await settled(store, targetTurnId);
    const visibleBefore = await visibleMessages(base, session.session.id);
    const factsBefore = await worldFacts(store, session.world.id);

    const pending = await openTurn(base, session.session.id, { clientTurnId: 'cancel-regen', chatType: 'regenerate', targetTurnId });
    const accepted = await pending.first();
    assert.equal(accepted.type, 'accepted');
    const turnId = accepted.turnId;
    await until(async () => (await turnView(base, turnId)).status === 'running', 'rewrite running');
    const cancelled = await post(`/api/turns/${turnId}/cancel`, {});
    assert.equal(cancelled.status, 200);
    release();
    const events = await pending.rest();
    assert.ok(['cancelled', 'failed'].includes(terminalEvent(events)?.type ?? ''), `expected terminal cancellation, got ${terminalEvent(events)?.type}`);
    await until(async () => (await turnView(base, turnId)).status === 'cancelled', 'durable cancellation');

    const visibleAfter = await visibleMessages(base, session.session.id);
    assert.deepEqual(dialogueOnly(visibleAfter), dialogueOnly(visibleBefore), 'a cancelled rewrite must keep the old story untouched');
    const factsAfter = await worldFacts(store, session.world.id);
    assert.equal(factsAfter.revision, factsBefore.revision);
    assert.deepEqual(restorable(factsAfter, false), restorable(factsBefore, false));

    const retried = await sendTurn(base, session.session.id, { clientTurnId: 'cancel-regen', chatType: 'regenerate', targetTurnId });
    assert.equal(retried.status, 200);
    const retriedRow = await turnRow(store, committedEvent(retried.events).turnId);
    assert.equal(retriedRow.chat_type, 'regenerate');
    assert.equal(retriedRow.target_turn_id, targetTurnId);
  }, { rec, runtime: { actorGate: (_input, index) => index === 1 ? gate : undefined, reply: (_input, index) => index === 0 ? '林晚说：“坐下说。”' : '林晚开口了。' } });
});

// ------------------------------------------------------ successful rewrite rollback ----
test('successful rewrite rolls back every derived fact, keeps audit rows, and advances revision monotonically', async () => {
  const rec = recording();
  const itemId = randomUUID();
  const oldReply = '林晚从书架取下那本旧信。\n“先放在这里吧。”';
  const newReply = '林晚没有去碰书架，只是抬眼看他。';
  let linWanDescription = '';
  const oldLocation = '旧书店二楼';
  const newLocation = '河边的长椅';
  let linWanName = '林晚';
  await fixture(async ({ base, session, store }) => {
    const seeded = (await store.pool.query("SELECT name,description FROM world_entities WHERE world_id=$1 AND id='lin-wan'", [session.world.id])).rows[0];
    linWanName = String(seeded?.name ?? '林晚');
    linWanDescription = String(seeded?.description ?? '');
    const before = await worldFacts(store, session.world.id);
    const preSnapshotCount = (await store.pool.query('SELECT * FROM world_snapshots WHERE world_id=$1', [session.world.id])).rows.length;

    const first = await sendTurn(base, session.session.id, { clientTurnId: 'rollback-target', content: '把那本旧信收好。' });
    const targetTurnId = committedEvent(first.events).turnId;
    await settled(store, targetTurnId);
    const dirty = await worldFacts(store, session.world.id);
    assert.notDeepEqual(restorable(dirty), restorable(before), 'the fixture settlement must actually change world-derived facts');
    assert.equal(dirty.entities.some((entity: any) => entity.id === itemId), true);
    assert.equal(dirty.memory.length, 1);
    assert.equal(dirty.storyEvents.length, 1);
    assert.equal(dirty.events.length, 1);
    assert.equal((dirty.scene as any)?.location, oldLocation);
    const targetSnapshotId = (await turnRow(store, targetTurnId)).snapshot_id;
    assert.ok(targetSnapshotId, 'the rewrite target must have a pre-state snapshot id');

    // A director/progress cursor written after the target is likewise rolled back.
    await store.pool.query(
      "INSERT INTO world_directions(owner_id,world_id,requested_turn_id,status,plan,guard) VALUES('alice',$1,$2,'completed',$3,$4) ON CONFLICT(owner_id,world_id) DO UPDATE SET requested_turn_id=EXCLUDED.requested_turn_id,status=EXCLUDED.status,plan=EXCLUDED.plan,guard=EXCLUDED.guard,attempt=NULL",
      [session.world.id, targetTurnId, { planType: 'mainline', version: 1, id: 'stale-plan', status: 'active', goal: '去旧书店', targetTurns: 5, currentStageId: 'go', basedOnTurnId: targetTurnId, invalidWhen: [], stages: [{ id: 'go', goal: '去旧书店', completionCondition: '到达', status: 'active', budgetTurns: 5 }] }, { focusId: 'lin-wan' }],
    );

    const rewrite = await sendTurn(base, session.session.id, { clientTurnId: 'rollback-regen', chatType: 'regenerate', targetTurnId });
    assert.equal(rewrite.status, 200);
    const committed = committedEvent(rewrite.events);
    const acceptedTurnId = committed.turnId;
    assert.ok(committed.world.revision > dirty.revision, 'committed world revision must increase');
    await settled(store, acceptedTurnId);

    const after = await worldFacts(store, session.world.id);
    assert.ok(after.revision > dirty.revision, 'world revision must be monotonic across a rewrite');
    assert.equal(after.entities.some((entity: any) => entity.id === itemId), false, 'old item must not survive in the active projection');
    assert.ok(after.archivedEntityIds.includes(itemId), 'the rolled-back item must be archived, not physically deleted');
    assert.deepEqual(after.memory, [], 'old memory summary must not survive');
    assert.deepEqual(after.storyEvents, [], 'old event ledger record must not survive');
    assert.deepEqual(after.events, [], 'old player memory evidence must not survive');
    assert.equal(after.direction.some((row: any) => row.plan && row.plan.id === 'stale-plan'), false, 'the stale plan cursor must be rolled back');
    assert.equal(after.direction.every((row: any) => row.plan === null), true, 'no superseded plan survives the restore');
    assert.deepEqual(after.entities, before.entities, 'entity projection must match the pre-turn state');
    assert.deepEqual(after.knowledge, before.knowledge, 'knowledge projection must match the pre-turn state');
    assert.deepEqual(after.storyTime, before.storyTime);
    assert.equal(after.storyElapsedMs, before.storyElapsedMs);
    assert.equal(after.clockMode, before.clockMode);
    assert.equal((after.scene as any)?.location, newLocation, 'new generation scene is the only remaining scene');

    // Audit: old turn/messages retained in the database, hidden from the product surface.
    const visible = await visibleMessages(base, session.session.id);
    assert.ok(!visible.some((message) => message.content === oldReply), 'superseded reply must be hidden');
    assert.ok(visible.some((message) => message.content === newReply), 'new reply must be visible');
    const rows = await messageRows(store, session.session.id);
    assert.ok(rows.length > visible.length, 'superseded rows must be archived, never deleted');
    assert.ok(rows.filter((row) => row.archived_at !== undefined && row.archived_at !== null).length >= 2, 'old user+assistant must be archived for audit');
    assert.equal((await store.pool.query('SELECT status FROM turns WHERE id=$1', [targetTurnId])).rows[0].status, 'committed');
    const oldTurnRow = await turnRow(store, targetTurnId);
    assert.ok(oldTurnRow.archived_at, 'superseded turn must be marked archived');
    assert.equal(oldTurnRow.superseded_by, acceptedTurnId, 'superseded turn must point at its replacement');
    const rewriteRow = await turnRow(store, acceptedTurnId);
    assert.equal(rewriteRow.snapshot_id, targetSnapshotId, 'rewrite turn reuses the target pre-state snapshot');
    assert.ok(rewriteRow.committed_revision !== null && rewriteRow.committed_revision !== undefined, 'rewrite turn records its committed revision');

    const snapshotCount = (await store.pool.query('SELECT * FROM world_snapshots WHERE world_id=$1', [session.world.id])).rows.length;
    assert.ok(snapshotCount > preSnapshotCount, 'each turn must freeze a pre-state snapshot');
  }, { rec, runtime: {
    reply: (_input, index) => index === 0 ? oldReply : newReply,
    scene: (input, index) => ({ ...input.scene!, location: index === 0 ? oldLocation : newLocation, presentCharacterIds: [input.character.id] }),
    settleChanges: (input) => input.turnId === rec.actors[0]?.turnId ? [
      { op: 'create', entity: { id: itemId, kind: 'item', name: '旧信', description: '书架上的旧信', state: { holderCharacterId: 'lin-wan' }, knownByCharacterIds: ['lin-wan'] }, witnessedByCharacterIds: ['lin-wan'] },
      { op: 'update', entity: { id: 'lin-wan', kind: 'npc', name: linWanName, description: linWanDescription, state: { arc: '记得把旧信收好。' } }, arcSource: { source: 'actor', characterId: 'lin-wan', quote: oldReply }, witnessedByCharacterIds: ['lin-wan'] },
    ] : [],
    settleMemory: (input) => input.turnId === rec.actors[0]?.turnId ? [
      { kind: 'fact', text: input.userText, visibility: 'private', characterId: 'lin-wan', evidence: { source: 'user', turnId: input.turnId } },
    ] : [],
    settleLedger: (input) => input.turnId === rec.actors[0]?.turnId ? [
      { id: 'old-letter-event', kind: 'item', subjectId: 'lin-wan', summary: '取走了旧信', phase: 'planned', sourceTurnId: input.turnId, lastSourceTurnId: input.turnId, evidenceIds: ['source-1'], version: 1 },
    ] : [],
  } });
});

// -------------------------------------------------------------- late settlement ----
test('a late background settlement from the superseded turn is fenced', async () => {
  const rec = recording();
  const staleItemId = randomUUID();
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  let oldTurnId = '';
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'fence-target', content: '打开抽屉。' });
    oldTurnId = committedEvent(first.events).turnId;
    await until(async () => (await activeSettlement(store, oldTurnId))?.status === 'running', 'old settlement running');

    const rewrite = await sendTurn(base, session.session.id, { clientTurnId: 'fence-regen', chatType: 'regenerate', targetTurnId: oldTurnId });
    assert.equal(rewrite.status, 200);
    const newTurnId = committedEvent(rewrite.events).turnId;
    await settled(store, newTurnId);
    const revisionAtRewrite = (await worldFacts(store, session.world.id)).revision;

    // The superseded job is sealed into the archive and removed from the active queue.
    const sealed = await archivedSettlement(store, oldTurnId);
    assert.ok(sealed, 'the superseded settlement must be archived for audit');
    assert.equal(sealed!.superseded_by_turn_id, newTurnId);
    assert.equal(await activeSettlement(store, oldTurnId), undefined, 'the superseded settlement must leave the active queue');

    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await worldFacts(store, session.world.id);
    assert.equal(after.entities.some((entity: any) => entity.id === staleItemId), false, 'a late settlement must not create world facts');
    assert.equal(after.revision, revisionAtRewrite, 'a late settlement must not bump the world revision');
    assert.equal(await activeSettlement(store, oldTurnId), undefined);
  }, { rec, runtime: {
    reply: (_input, index) => index === 0 ? '林晚打开抽屉。' : '林晚没有动抽屉。',
    settlementGate: (input) => input.turnId === oldTurnId ? oldGate : undefined,
    settleChanges: (input) => input.turnId === oldTurnId ? [
      { op: 'create', entity: { id: staleItemId, kind: 'item', name: '迟到的旧物', description: '迟到的结果', state: {}, knownByCharacterIds: ['lin-wan'] }, witnessedByCharacterIds: ['lin-wan'] },
    ] : [],
  } });
});
﻿
// ------------------------------------- archived projection & rewrite baseline ----
const itemCreate = (input: { turnId: string }, id: string) => ({
  op: 'create' as const,
  entity: { id, kind: 'item' as const, name: '旧信', description: '书架上的旧信', state: { holderCharacterId: 'lin-wan' }, knownByCharacterIds: ['lin-wan'] },
  witnessedByCharacterIds: ['lin-wan'],
});

test('a rewritten-away entity never re-enters a later ActorInput/contextPack and the archive stays out of dialogue reads', async () => {
  const rec = recording();
  const itemId = randomUUID();
  const oldReply = '林晚把旧信放回书架，没有多说什么。';
  const newReply = '林晚没有碰书架，只是看向门外。';
  let targetTurnId = '';
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'proj-target', content: '把旧信收好。' });
    targetTurnId = committedEvent(first.events).turnId;
    await settled(store, targetTurnId);
    assert.equal((await store.pool.query('SELECT id FROM world_entities WHERE world_id=$1 AND id=$2 AND archived_at IS NULL', [session.world.id, itemId])).rowCount, 1);

    const rewrite = await sendTurn(base, session.session.id, { clientTurnId: 'proj-regen', chatType: 'regenerate', targetTurnId });
    const rewriteTurnId = committedEvent(rewrite.events).turnId;
    await settled(store, rewriteTurnId);
    const archived = (await store.pool.query('SELECT archived_at FROM world_entities WHERE world_id=$1 AND id=$2', [session.world.id, itemId])).rows[0];
    assert.ok(archived?.archived_at, 'a rolled-back entity is archived, never deleted');

    // The rewrite turn's own Actor input must already exclude the archived target state.
    const rewriteActor = rec.actors.find((input) => input.turnId === rewriteTurnId)!;
    assert.ok(!JSON.stringify(rewriteActor).includes(itemId), 'the archived item must not be in the rewrite ActorInput');
    // Harness binds the dialogue tool to the current turn id, so beforeTurnId must be the new
    // rewrite turn (dialogue-tool.ts:24). Safety is enforced by the host read: archived turns and
    // anything after the target are never returned.
    assert.equal((rewriteActor.contextPack as any)?.dialogue?.beforeTurnId, rewriteTurnId,
      'the dialogue binding follows the current Actor turn id');
    const targetSeq = Number((await store.pool.query('SELECT seq FROM turns WHERE id=$1', [targetTurnId])).rows[0].seq);
    const rewriteRead = await store.readDialogue('alice', { worldId: session.world.id, sourceTurnId: rewriteTurnId, characterId: 'lin-wan' });
    const rewriteEpisodes = (rewriteRead as { episodes?: Array<{ turnId: string }> }).episodes ?? [];
    assert.equal(rewriteEpisodes.some((episode) => episode.turnId === targetTurnId), false, 'the superseded archived turn must never be readable');
    assert.ok(!JSON.stringify(rewriteRead).includes(oldReply), 'the superseded reply must not come back through read_dialogue');
    // An explicit archived turn id is either rejected or returns nothing; it never leaks the reply.
    let archivedRead = '';
    try {
      archivedRead = JSON.stringify(await store.readDialogue('alice', { worldId: session.world.id, sourceTurnId: rewriteTurnId, characterId: 'lin-wan', turnIds: [targetTurnId] }));
    } catch {
      archivedRead = '';
    }
    assert.ok(!archivedRead.includes(oldReply), 'an explicit archived turn id must never return the replaced reply');
    assert.ok(Number.isSafeInteger(targetSeq));

    // A later ordinary chat must not resurrect it through worldContext/contextPack/history.
    const next = await sendTurn(base, session.session.id, { clientTurnId: 'proj-next', content: '继续聊天。' });
    const nextTurnId = committedEvent(next.events).turnId;
    const actor = rec.actors.at(-1)!;
    const serialized = JSON.stringify(actor);
    assert.ok(!serialized.includes(itemId), 'archived items must not enter ActorInput/worldContext/contextPack');
    assert.equal((actor.worldContext?.entities ?? []).some((entity: any) => entity.id === itemId), false);
    assert.equal((actor.contextPack as any)?.dialogue?.beforeTurnId, nextTurnId, 'a normal chat reads dialogue before its own turn');
    assert.ok(!serialized.includes(oldReply), 'the superseded reply must not return through history/episodes/contextPack');

    // Scoped dialogue reads also skip archived turns.
    const read = await store.readDialogue('alice', { worldId: session.world.id, sourceTurnId: nextTurnId, characterId: 'lin-wan', turnIds: [targetTurnId] });
    assert.ok(!JSON.stringify(read).includes(oldReply), 'read_dialogue must not return the archived reply');
  }, { rec, runtime: {
    reply: (_input, index) => index === 0 ? oldReply : newReply,
    settleChanges: (input) => input.turnId === targetTurnId ? [itemCreate(input, itemId)] : [],
  } });
});

test('a second rewrite is taken from the active projection, so an earlier rollback cannot resurrect', async () => {
  const rec = recording();
  const itemId = randomUUID();
  const revisions: number[] = [];
  let firstTurnId = '';
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'multi-1', content: '把旧信收好。' });
    firstTurnId = committedEvent(first.events).turnId;
    await settled(store, firstTurnId);
    revisions.push((await worldFacts(store, session.world.id)).revision);

    const firstRewrite = await sendTurn(base, session.session.id, { clientTurnId: 'multi-2', chatType: 'regenerate', targetTurnId: firstTurnId });
    const firstRewriteTurn = committedEvent(firstRewrite.events).turnId;
    await settled(store, firstRewriteTurn);
    revisions.push((await worldFacts(store, session.world.id)).revision);
    const firstSnapshot = await store.pool.query('SELECT data FROM world_snapshots WHERE id=(SELECT snapshot_id FROM turns WHERE id=$1)', [firstRewriteTurn]);
    assert.ok(!JSON.stringify(firstSnapshot.rows[0]?.data ?? {}).includes(itemId), 'the rollback snapshot must contain the active projection only');

    const chat = await sendTurn(base, session.session.id, { clientTurnId: 'multi-3', content: '普通的一轮新对话。' });
    const chatTurn = committedEvent(chat.events).turnId;
    await settled(store, chatTurn);
    revisions.push((await worldFacts(store, session.world.id)).revision);

    const secondRewrite = await sendTurn(base, session.session.id, { clientTurnId: 'multi-4', chatType: 'regenerate', targetTurnId: chatTurn });
    const secondRewriteTurn = committedEvent(secondRewrite.events).turnId;
    await settled(store, secondRewriteTurn);
    const after = await worldFacts(store, session.world.id);
    revisions.push(after.revision);

    assert.equal(after.entities.some((entity: any) => entity.id === itemId), false, 'the first rollback item must not resurrect');
    const activeRows = await store.pool.query('SELECT id FROM world_entities WHERE world_id=$1 AND id=$2 AND archived_at IS NULL', [session.world.id, itemId]);
    assert.equal(activeRows.rowCount, 0);
    for (let index = 1; index < revisions.length; index++) assert.ok(revisions[index] > revisions[index - 1], `world revision must be monotonic: ${revisions.join(',')}`);
    const visible = await visibleMessages(base, session.session.id);
    const newestReply = visible.filter((message) => message.turnId === secondRewriteTurn && message.role === 'assistant');
    assert.equal(newestReply.length, 1, 'only the newest rewrite version is visible');
    assert.equal(visible.some((message) => message.turnId === chatTurn || message.turnId === firstTurnId), false, 'superseded turns must be hidden');
  }, { rec, runtime: {
    reply: (_input, index) => index === 0 ? '旧信被收好。' : index === 1 ? '旧信被放下。' : '新的一轮聊天。',
    settleChanges: (input) => input.turnId === firstTurnId ? [itemCreate(input, itemId)] : [],
  } });
});

test('an unfinished earlier background settlement blocks a rewrite instead of rolling back committed facts', async () => {
  const rec = recording();
  const itemId = randomUUID();
  let firstTurnId = '';
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await fixture(async ({ base, session, store }) => {
    const first = await sendTurn(base, session.session.id, { clientTurnId: 'base-1', content: '打开抽屉。' });
    firstTurnId = committedEvent(first.events).turnId;
    await until(async () => (await activeSettlement(store, firstTurnId))?.status === 'running', 'first settlement running');
    const second = await sendTurn(base, session.session.id, { clientTurnId: 'base-2', content: '再说一句。' });
    const secondTurnId = committedEvent(second.events).turnId;
    const blocked = await sendTurn(base, session.session.id, { clientTurnId: 'base-regen', chatType: 'regenerate', targetTurnId: secondTurnId });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.error?.error?.code, 'REWRITE_UNAVAILABLE');
    assert.match(String(blocked.error?.error?.message), /后台|整理|未完成|最新/u);

    releaseFirst();
    await settled(store, firstTurnId);
    await settled(store, secondTurnId);
    const facts = await worldFacts(store, session.world.id);
    assert.equal(facts.entities.some((entity: any) => entity.id === itemId), true, 'an earlier committed settlement must not be rolled back');
    assert.ok(facts.archivedEntityIds.length === 0);
  }, { rec, runtime: {
    reply: (_input, index) => index === 0 ? '抽屉被打开。' : '她应了一声。',
    settlementGate: (input) => input.turnId === firstTurnId ? gate : undefined,
    settleChanges: (input) => input.turnId === firstTurnId ? [itemCreate(input, itemId)] : [],
  } });
});
