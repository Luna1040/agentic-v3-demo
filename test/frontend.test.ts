import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient, parseEvent, StreamInterruptedError } from '../web/api';
import { acceptUser, applyTurnEvent, initialConversation, markAttemptStatus, recoverTurn, shouldSendOnEnter, type ConversationState } from '../web/conversation-state';
import type { Message, SessionDetail, TurnEvent } from '../shared/contracts';

const user: Message = { id: 'm-user', turnId: 't1', sessionId: 's1', role: 'user', content: '你好', createdAt: '2026-10-21T00:00:00.000Z', status: 'pending' };
const assistant: Message = { ...user, id: 'm-assistant', role: 'assistant', content: '你好呀', status: 'committed' };
const world = { id: 'w1', title: '故事', revision: 1, createdAt: user.createdAt, events: [] };
const detail: SessionDetail = { session: { id: 's1', characterId: 'c1', worldId: 'w1', title: '对话', createdAt: user.createdAt, updatedAt: user.createdAt }, messages: [{ ...user, id: 'local-c1', turnId: null, status: 'pending' }], world, hasMore: false, nextBefore: null };
const running = (): ConversationState => ({ ...initialConversation, loading: false, detail: structuredClone(detail), pending: { clientTurnId: 'c1', content: user.content, turnId: null }, phase: 'responding' });
const block = (event: TurnEvent) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;

test('SSE handles fragmented UTF-8, CRLF and a persisted terminal event', async () => {
  const expected: TurnEvent[] = [
    { type: 'accepted', turnId: 't1', userMessage: user },
    { type: 'delta', turnId: 't1', text: '你好，林晚。' },
    { type: 'committed', turnId: 't1', message: assistant, world }
  ];
  const bytes = new TextEncoder().encode(expected.map(block).join(''));
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  const received: TurnEvent[] = [];
  await createApiClient({ fetch }).stream('s1', { clientTurnId: 'c1', content: '你好' }, event => received.push(event));
  assert.deepEqual(received, expected);
});

test('EOF without terminal is interrupted, including after visible tokens', async () => {
  const fetch: typeof globalThis.fetch = async () => new Response(block({ type: 'accepted', turnId: 't1', userMessage: user }) + block({ type: 'delta', turnId: 't1', text: '一半的回复' }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(createApiClient({ fetch }).stream('s1', { clientTurnId: 'c1', content: '你好' }, () => {}), (error: unknown) => error instanceof StreamInterruptedError && error.turnId === 't1');
});

test('EOF in JSON before accepted is a recoverable interruption without raw parser errors', async () => {
  const fetch: typeof globalThis.fetch = async () => new Response('event: accepted\ndata: {"type":"accepted","turnId":"t1","userMessage":', { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(createApiClient({ fetch }).stream('s1', { clientTurnId: 'c1', content: '你好' }, () => {}), (error: unknown) => {
    assert.ok(error instanceof StreamInterruptedError);
    assert.equal(error.turnId, null);
    assert.equal(error.message, '连接中断，正在确认消息是否已保存。');
    return true;
  });
});

test('EOF in JSON after accepted retains the turn ID for persisted-result recovery', async () => {
  const fetch: typeof globalThis.fetch = async () => new Response(block({ type: 'accepted', turnId: 't1', userMessage: user }) + 'event: delta\ndata: {"type":"delta","turnId":"t1","text":"部分回复', { headers: { 'content-type': 'text/event-stream' } });
  const events: TurnEvent[] = [];
  await assert.rejects(createApiClient({ fetch }).stream('s1', { clientTurnId: 'c1', content: '你好' }, event => events.push(event)), (error: unknown) => error instanceof StreamInterruptedError && error.turnId === 't1');
  assert.deepEqual(events.map(event => event.type), ['accepted']);
});

test('normal and streaming requests both receive host URL, identity and abort signal', async () => {
  const captured: { url: string; init?: RequestInit }[] = [];
  const signal = new AbortController().signal;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    captured.push({ url: String(input), init });
    return String(input).endsWith('/turns')
      ? new Response(block({ type: 'cancelled', turnId: 't1', code: 'CANCELLED', message: '已停止' }), { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({});
  };
  const client = createApiClient({ baseUrl: 'https://host.example/feature/api/', fetch, getHeaders: async () => ({ Authorization: 'Bearer fixture', 'X-Host-Tenant': 'test' }) });
  await client.bootstrap({ signal });
  await client.stream('s/1', { clientTurnId: 'c1', content: '你好' }, () => {}, { signal });
  assert.equal(captured[0].url, 'https://host.example/feature/api/bootstrap');
  assert.equal(captured[1].url, 'https://host.example/feature/api/sessions/s%2F1/turns');
  for (const call of captured) {
    assert.equal(new Headers(call.init?.headers).get('authorization'), 'Bearer fixture');
    assert.equal(new Headers(call.init?.headers).get('x-host-tenant'), 'test');
    assert.equal(call.init?.signal, signal);
  }
});

test('protocol rejects mismatched event names, malformed data and inconsistent turn IDs', async () => {
  assert.equal(parseEvent(': keepalive'), null);
  assert.throws(() => parseEvent('event: delta\ndata: not-json'));
  assert.throws(() => parseEvent('event: accepted\ndata: {"type":"delta","turnId":"t1","text":"x"}'));
  const fetch: typeof globalThis.fetch = async () => new Response(block({ type: 'accepted', turnId: 't1', userMessage: user }) + block({ type: 'cancelled', turnId: 't2', code: 'CANCELLED', message: 'x' }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(createApiClient({ fetch }).stream('s1', { clientTurnId: 'c1', content: '你好' }, () => {}), /轮次不一致/);
});

test('accepted replaces optimistic user ID, and replay never duplicates it', () => {
  const current = running();
  const accepted = applyTurnEvent(current, { type: 'accepted', turnId: 't1', userMessage: user });
  assert.deepEqual(accepted.detail?.messages.map(message => message.id), ['m-user']);
  assert.deepEqual(acceptUser(accepted.detail!.messages, accepted.pending!, user), [user]);
});

test('story changes appear only on committed, final message appears once', () => {
  let current = applyTurnEvent(running(), { type: 'accepted', turnId: 't1', userMessage: user });
  current = applyTurnEvent(current, { type: 'delta', turnId: 't1', text: '回复' });
  current = applyTurnEvent(current, { type: 'phase', turnId: 't1', phase: 'settling' });
  assert.equal(current.detail?.world.revision, 1);
  assert.equal(current.detail?.messages.length, 1);
  const event: TurnEvent = { type: 'committed', turnId: 't1', message: assistant, world: { ...world, revision: 2 } };
  current = applyTurnEvent(current, event);
  assert.equal(current.detail?.world.revision, 2);
  assert.equal(current.draft, '');
  assert.equal(current.pending, null);
  assert.equal(current.detail?.messages.find(message => message.id === user.id)?.status, 'committed');
  assert.equal(applyTurnEvent(current, event).detail?.messages.length, 2);
});

test('stale turn events and other-session recovery cannot change the active conversation', () => {
  const current = { ...running(), pending: { clientTurnId: 'c2', content: '新一轮', turnId: 't2' } };
  assert.equal(applyTurnEvent(current, { type: 'delta', turnId: 't1', text: '过期回复' }), current);
  assert.equal(recoverTurn(current, { id: 't1', sessionId: 'other-session', worldId: 'w1', status: 'committed', phase: 'settling', userMessage: user, assistantMessage: assistant }), current);
  assert.equal(recoverTurn(current, { id: 't1', sessionId: 's1', worldId: 'w1', status: 'cancelled', phase: 'responding', userMessage: user }), current);
});

test('recovery reuses persisted messages and preserves retry identity on failure', () => {
  const complete = recoverTurn(running(), { id: 't1', worldId: 'w1', sessionId: 's1', status: 'committed', phase: 'settling', userMessage: user, assistantMessage: assistant });
  assert.deepEqual(complete.detail?.messages.map(message => message.id), ['m-user', 'm-assistant']);
  assert.equal(complete.pending, null);
  assert.equal(complete.detail?.messages[0].status, 'committed');
  const failed = recoverTurn(running(), { id: 't1', worldId: 'w1', sessionId: 's1', status: 'failed', phase: 'responding', userMessage: user, error: { code: 'TIMEOUT', message: '请求超时' } });
  assert.equal(failed.failed?.clientTurnId, 'c1');
  assert.equal(failed.failed?.turnId, 't1');
  assert.equal(failed.detail?.world.revision, 1);
  assert.equal(failed.detail?.messages[0].status, 'failed');
});

test('all streamed terminal states settle the accepted user message without changing older turns', () => {
  const older: Message = { ...user, id: 'old-user', turnId: 'old-turn', status: 'committed' };
  for (const type of ['committed', 'failed', 'cancelled'] as const) {
    const initial = running();
    initial.detail!.messages.unshift(older);
    const accepted = applyTurnEvent(initial, { type: 'accepted', turnId: 't1', userMessage: user });
    assert.equal(accepted.detail!.messages.find(message => message.id === user.id)?.status, 'pending');
    const event: TurnEvent = type === 'committed' ? { type, turnId: 't1', message: assistant, world } : { type, turnId: 't1', code: 'TEST', message: '本轮结束' };
    const completed = applyTurnEvent(accepted, event);
    assert.equal(completed.detail!.messages.find(message => message.id === user.id)?.status, type);
    assert.equal(completed.detail!.messages.find(message => message.id === older.id)?.status, 'committed');
    assert.equal(completed.detail!.messages.some(message => message.status === 'pending'), false);
  }
});

test('turn recovery normalizes pending user snapshots to the authoritative terminal status', () => {
  for (const status of ['committed', 'failed', 'cancelled'] as const) {
    const result = recoverTurn(running(), { id: 't1', worldId: 'w1', sessionId: 's1', status, phase: 'settling', userMessage: user, ...(status === 'committed' ? { assistantMessage: assistant } : {}) });
    assert.equal(result.detail!.messages.find(message => message.id === user.id)?.status, status);
    assert.equal(result.detail!.messages.some(message => message.status === 'pending'), false);
    assert.equal(result.pending, null);
  }
});

test('retry and unresolved recovery update both optimistic and accepted messages of their own turn', () => {
  const pending = { clientTurnId: 'c1', content: user.content, turnId: 't1' };
  const messages: Message[] = [detail.messages[0], { ...user, status: 'cancelled' }, { ...user, id: 'older', turnId: 'older', status: 'committed' }];
  const retrying = markAttemptStatus(messages, pending, 'pending');
  assert.deepEqual(retrying.map(message => message.status), ['pending', 'pending', 'committed']);
  const unresolved = markAttemptStatus(retrying, pending, 'failed');
  assert.deepEqual(unresolved.map(message => message.status), ['failed', 'failed', 'committed']);
});

test('IME Enter and Shift+Enter never send a message', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }), false);
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false }), true);
});

test('planning phase and committed scene retain server authority', () => {
  const original = running();
  const planning = applyTurnEvent(original, { type: 'phase', turnId: 't1', phase: 'planning' });
  assert.equal(planning.phase, 'planning');
  assert.equal(planning.detail?.world.scene, undefined);
  const scene = { location: '旧书店二楼', presentCharacterIds: ['c1', 'c2'] };
  const completed = applyTurnEvent(planning, { type: 'committed', turnId: 't1', message: assistant, world: { ...world, revision: 2, scene } });
  assert.deepEqual(completed.detail?.world.scene, scene);
  assert.equal(original.detail?.world.scene, undefined);
});
