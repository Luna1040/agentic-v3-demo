import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, SessionDetail, TurnView } from '../shared/contracts';
import { createApiClient } from '../web/api';
import { initialConversation, needsOpening, persistedOpening, recoverTurn } from '../web/conversation-state';
import { readPersistedTurn } from '../web/turn-recovery';

const operation: Message = { id: 'op', sessionId: 'session', turnId: 'opening-turn', role: 'user', content: '内部开场操作', kind: 'operation', status: 'failed', createdAt: '' };
const detail: SessionDetail = { session: { id: 'session', worldId: 'world', characterId: 'root', title: '新场景', dynamicOpening: true, createdAt: '', updatedAt: '' }, world: { id: 'world', title: '世界', revision: 0, createdAt: '', events: [] }, messages: [], hasMore: false, nextBefore: null };
const turn = (status: TurnView['status']): TurnView => ({ id: 'opening-turn', worldId: 'world', sessionId: 'session', status, phase: 'planning', userMessage: { ...operation, status: status === 'running' ? 'pending' : status }, ...(status === 'failed' ? { error: { code: 'MAIN_AGENT_FAILED', message: '开场计划不合法' } } : {}) });

test('only an untouched dynamic session can automatically start, across reload and remount snapshots', () => {
  assert.equal(needsOpening(detail), true);
  for (const status of ['pending', 'failed', 'cancelled', 'committed'] as const) {
    const loaded = { ...detail, messages: [{ ...operation, status }] };
    assert.equal(needsOpening(loaded), false, `${status} must not trigger another paid opening`);
    assert.equal(needsOpening(structuredClone(loaded)), false, 'remount cannot erase persisted attempt evidence');
    assert.equal(persistedOpening(loaded)?.turnId, 'opening-turn');
  }
  assert.equal(needsOpening({ ...detail, hasMore: true }), false);
  assert.equal(needsOpening({ ...detail, messages: [{ ...operation, kind: 'dialogue' }] }), false);
  assert.equal(needsOpening({ ...detail, session: { ...detail.session, dynamicOpening: false } }), false);
});

test('loading failed or cancelled openings restores an explicit retry through GET only', async () => {
  const methods: string[] = [];
  for (const status of ['failed', 'cancelled'] as const) {
    const snapshot = { ...detail, messages: [{ ...operation, status }] };
    const attempt = persistedOpening(snapshot)!;
    let state = { ...initialConversation, loading: false, detail: snapshot, pending: attempt };
    const client = createApiClient({ fetch: async (url, init) => {
      methods.push(init?.method || 'GET');
      assert.equal(init?.method, 'GET');
      assert.equal(String(url), '/api/turns/opening-turn');
      return Response.json(turn(status));
    } });
    await readPersistedTurn(client, attempt.turnId!, new AbortController().signal, value => { state = recoverTurn(state, value) as typeof state; });
    assert.equal(state.pending, null);
    assert.equal(state.failed?.operation, 'opening');
    assert.equal(state.failed?.cancelled, status === 'cancelled');
    assert.equal(needsOpening(state.detail!), false);
  }
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('unknown pending opening polls persisted state and receives a commit without POST or model retry', async () => {
  const snapshot = { ...detail, messages: [{ ...operation, status: 'pending' as const }] };
  const attempt = persistedOpening(snapshot)!;
  let state = { ...initialConversation, loading: false, detail: snapshot, pending: attempt };
  const answer: Message = { ...operation, id: 'answer', role: 'assistant', kind: 'dialogue', status: 'committed', characterId: 'root', content: '这一幕已完成。' };
  let reads = 0;
  const client = createApiClient({ fetch: async (_url, init) => {
    assert.equal(init?.method, 'GET');
    reads++;
    return Response.json(reads === 1 ? turn('running') : { ...turn('committed'), assistantMessage: answer, assistantMessages: [answer] });
  } });
  await readPersistedTurn(client, attempt.turnId!, new AbortController().signal, value => { state = recoverTurn(state, value) as typeof state; }, { wait: async () => {} });
  assert.equal(reads, 2);
  assert.equal(state.failed, null);
  assert.equal(state.pending, null);
  assert.equal(state.detail?.messages.filter(message => message.id === answer.id).length, 1);
  assert.equal(persistedOpening(state.detail!), null);
  assert.equal(needsOpening(state.detail!), false);
});

test('aborted recovery cannot issue a request or apply a late response to another session', async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readPersistedTurn({ turn: async () => { assert.fail('no GET after cancellation'); } }, 'opening-turn', aborted.signal, () => assert.fail('no event after cancellation')), { name: 'AbortError' });
  const active = new AbortController();
  await assert.rejects(readPersistedTurn({ turn: async () => { active.abort(); return turn('committed'); } }, 'opening-turn', active.signal, () => assert.fail('late response must be ignored')), { name: 'AbortError' });
});
