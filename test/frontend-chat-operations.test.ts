/**
 * Pure-logic tests for the chat-operation client: request body shape, button
 * targets, operation status lines, committed-rewrite replacement, and
 * refresh/disconnect recovery. No jsdom, no new dependencies, no network.
 *
 * Run alone:
 *   node --no-warnings --experimental-transform-types test/frontend-chat-operations.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ApiClient } from '../web/api.ts';
import type { Attempt, ConversationState } from '../web/conversation-state.ts';
import type { Message, SessionDetail, TurnEvent, TurnView } from '../shared/contracts.ts';

// The browser bundle is compiled by Vite, so web/ modules import siblings without a
// file extension. Plain `node --experimental-transform-types` needs a resolver for
// that; registering it here keeps this test runnable without tsx/esbuild (sandboxed
// subprocess spawn is not available), and adds no file or dependency to the repo.
const RESOLVER = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL && context.parentURL.endsWith('.ts')) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
    throw error;
  }
}
`;
module.register('data:text/javascript,' + encodeURIComponent(RESOLVER));

const { createApiClient } = await import('../web/api.ts');
const chatOps = await import('../web/chat-operations.ts');
const conversation = await import('../web/conversation-state.ts');
const {
  CHAT_TYPES, isChatType, isOperationChatType, isRewriteChatType,
  operationLabel, operationMarkerChatType, operationPendingText, operationRetryLabel, operationStatusText,
  operationTargets, operationTargetsFor, turnChatType, turnRequestBody,
} = chatOps;
const {
  applyTurnEvent, attemptForSend, editRegenerateAttempt, initialConversation, isPlayerVisibleAttempt,
  operationAttempt, persistedOperationAttempt, recoverTurn, replaceRewriteTarget,
} = conversation;

const at = '2026-11-03T00:00:00.000Z';
const world = { id: 'w1', title: '世界', revision: 2, createdAt: at, events: [] };

function msg(partial: Partial<Message> & { id: string; turnId: string; role: 'user' | 'assistant' }): Message {
  return { sessionId: 's1', content: '', createdAt: at, status: 'committed', ...partial };
}
function detail(messages: Message[], extra: Partial<SessionDetail> = {}): SessionDetail {
  return { session: { id: 's1', characterId: 'lin-wan', worldId: 'w1', title: '对话', createdAt: at, updatedAt: at }, messages, world, hasMore: false, nextBefore: null, ...extra };
}
const block = (event: TurnEvent) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;

/** Send through the real API client with a stub transport and return the parsed request body. */
async function capturedStreamBody(input: Parameters<ApiClient['stream']>[1]) {
  const captured: Array<{ url: string; body: unknown }> = [];
  const fetchStub: typeof globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(block({ type: 'accepted', turnId: 't1', userMessage: msg({ id: 'u1', turnId: 't1', role: 'user', content: '正文' }) })
      + block({ type: 'committed', turnId: 't1', message: msg({ id: 'a1', turnId: 't1', role: 'assistant', content: '回复' }), world }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const scoped = createApiClient({ fetch: fetchStub });
  await scoped.stream('s1', input, () => {});
  assert.equal(captured.length, 1);
  return { url: captured[0].url, body: captured[0].body };
}

// ------------------------------------------------------------ request shape ----
test('turnRequestBody keeps the legacy chat body and whitelists operation fields only', () => {
  const legacy = turnRequestBody({ clientTurnId: 'c1', content: '你好' });
  assert.deepEqual(legacy, { clientTurnId: 'c1', content: '你好' });
  assert.equal('chatType' in legacy, false, 'plain chat must not send a chatType key');

  assert.deepEqual(turnRequestBody({ clientTurnId: 'c2', chatType: 'chat', content: '你好' }), { clientTurnId: 'c2', content: '你好' });
  assert.deepEqual(turnRequestBody({ clientTurnId: 'c3', chatType: 'continue' }), { clientTurnId: 'c3', chatType: 'continue' });
  assert.deepEqual(turnRequestBody({ clientTurnId: 'c4', chatType: 'regenerate', targetTurnId: 't1' }), { clientTurnId: 'c4', chatType: 'regenerate', targetTurnId: 't1' });
  assert.deepEqual(turnRequestBody({ clientTurnId: 'c5', chatType: 'edit_regenerate', targetTurnId: 't1', content: '编辑后' }), { clientTurnId: 'c5', chatType: 'edit_regenerate', targetTurnId: 't1', content: '编辑后' });

  // Operation turns never carry player content they do not own.
  assert.deepEqual(turnRequestBody({ clientTurnId: 'c6', chatType: 'continue', content: '伪造台词' }), { clientTurnId: 'c6', chatType: 'continue' });
  assert.deepEqual(turnRequestBody({ clientTurnId: 'c7', chatType: 'regenerate', content: '伪造台词', targetTurnId: 't1' }), { clientTurnId: 'c7', chatType: 'regenerate', targetTurnId: 't1' });

  // Forged fields (question/previousResponse/ownerId/anything unknown) are never serialized.
  const forged = turnRequestBody({ clientTurnId: 'c8', content: '正文', question: 'q', previousResponse: 'old', ownerId: 'bob', extra: 1 } as never);
  assert.deepEqual(forged, { clientTurnId: 'c8', content: '正文' });

  // An unknown signal downgrades to the strictly validated chat shape.
  assert.deepEqual(turnRequestBody({ clientTurnId: 'c9', chatType: 'rewrite' as never, content: '正文' }), { clientTurnId: 'c9', content: '正文' });
});

test('createApiClient.stream sends exactly the whitelisted operation body to the turns endpoint', async () => {
  const cases: Array<[Parameters<ApiClient['stream']>[1], Record<string, unknown>]> = [
    [{ clientTurnId: 'c1', content: '你好' }, { clientTurnId: 'c1', content: '你好' }],
    [{ clientTurnId: 'c2', chatType: 'continue' }, { clientTurnId: 'c2', chatType: 'continue' }],
    [{ clientTurnId: 'c3', chatType: 'regenerate', targetTurnId: 't1' }, { clientTurnId: 'c3', chatType: 'regenerate', targetTurnId: 't1' }],
    [{ clientTurnId: 'c4', chatType: 'edit_regenerate', targetTurnId: 't1', content: '编辑后' }, { clientTurnId: 'c4', chatType: 'edit_regenerate', targetTurnId: 't1', content: '编辑后' }],
  ];
  for (const [input, expected] of cases) {
    const sent = await capturedStreamBody(input);
    assert.equal(sent.url, '/api/sessions/s1/turns');
    assert.deepEqual(sent.body, expected);
  }
  // Forged transport-level data cannot smuggle fields through the shared builder.
  const forged = await capturedStreamBody({ clientTurnId: 'c5', chatType: 'continue', ownerId: 'bob', previousResponse: '伪造' } as never);
  assert.deepEqual(forged.body, { clientTurnId: 'c5', chatType: 'continue' });
});

test('chatType guards separate operation signals from ordinary chat', () => {
  assert.deepEqual([...CHAT_TYPES], ['chat', 'continue', 'regenerate', 'edit_regenerate']);
  for (const value of CHAT_TYPES) {
    assert.equal(isChatType(value), true);
    assert.equal(isOperationChatType(value), value !== 'chat');
    assert.equal(isRewriteChatType(value), value === 'regenerate' || value === 'edit_regenerate');
  }
  for (const value of [undefined, null, '', 'Chat', 'Continue', 'rewrite', 7]) {
    assert.equal(isChatType(value), false);
    assert.equal(isRewriteChatType(value as never), false);
  }
});

// --------------------------------------------------------------- button targets ----
const oldTurn = [
  msg({ id: 'u-old', turnId: 't-old', role: 'user', content: '上一句' }),
  msg({ id: 'a-old', turnId: 't-old', role: 'assistant', content: '上一段回复' }),
];
const latestTurn = [
  msg({ id: 'u-new', turnId: 't-new', role: 'user', content: '最新一句' }),
  msg({ id: 'a-new', turnId: 't-new', role: 'assistant', content: '最新回复' }),
];

test('buttons belong to the newest committed turn only and never to an operation message', () => {
  const targets = operationTargets([...oldTurn, ...latestTurn]);
  assert.deepEqual(targets, { turnId: 't-new', assistantMessageId: 'a-new', userMessageId: 'u-new', canContinue: true, canRegenerate: true });

  // A pending or failed latest turn never owns a target; the previous committed turn does.
  const pendingTurn = [...oldTurn, ...latestTurn, msg({ id: 'u-pending', turnId: 't-latest', role: 'user', content: '未完成', status: 'pending' })];
  assert.equal(operationTargets(pendingTurn).turnId, 't-new');
  const failedTurn = [...oldTurn, ...latestTurn].map((message, index) => index >= 2 ? { ...message, status: 'failed' as const } : message);
  assert.equal(operationTargets(failedTurn).turnId, 't-old');
  assert.equal(operationTargets(failedTurn).canRegenerate, true);

  // Continue's operation line means the newest turn was an operation: regenerate is unavailable.
  const continueTurn = [...oldTurn, msg({ id: 'op', turnId: 't-continue', role: 'user', kind: 'operation', content: '（继续）' }), msg({ id: 'op-reply', turnId: 't-continue', role: 'assistant', content: '继续后的回复' })];
  const continued = operationTargets(continueTurn);
  assert.equal(continued.turnId, 't-continue');
  assert.equal(continued.canContinue, true);
  assert.equal(continued.canRegenerate, false, 'an operation turn is not rewritable');
  assert.equal(continued.userMessageId, null);

  // An opening is not rewritable either.
  const openingTurn = [msg({ id: 'opening', turnId: 't-opening', role: 'user', kind: 'operation', content: '开场' }), msg({ id: 'opening-reply', turnId: 't-opening', role: 'assistant', content: '第一幕' })];
  assert.equal(operationTargets(openingTurn).canRegenerate, false);

  // Missing assistant text leaves nothing to continue from.
  assert.equal(operationTargets([msg({ id: 'u-only', turnId: 't1', role: 'user', content: '只有提问' })]).canContinue, false);

  // blockedTurnIds only stops regeneration; Continue still legitimately extends the newest scene.
  const blocked = operationTargets([...oldTurn, ...latestTurn], { blockedTurnIds: ['t-new'] });
  assert.equal(blocked.canRegenerate, false);
  assert.equal(blocked.canContinue, true);

  // The server-computed rewritable hint wins over local inference.
  const hinted = operationTargets([...oldTurn, { ...latestTurn[0], rewritable: false }, { ...latestTurn[1], rewritable: false }]);
  assert.equal(hinted.canRegenerate, false);

  // Pending operation messages do not own targets yet, even for continue.
  const pendingOperation = [...oldTurn, msg({ id: 'op', turnId: 't-new', role: 'user', kind: 'operation', content: '（继续）', status: 'pending' })];
  assert.equal(operationTargets(pendingOperation).turnId, 't-old');
});

test('session rewriteTarget is authoritative for reloads', () => {
  const withTarget = detail([...oldTurn, ...latestTurn], { rewriteTarget: { turnId: 't-new', available: true } });
  const targets = operationTargetsFor(withTarget);
  assert.equal(targets.turnId, 't-new');
  assert.equal(targets.userMessageId, 'u-new');
  assert.equal(targets.canRegenerate, true);

  const unavailable = operationTargetsFor(detail([...oldTurn, ...latestTurn], { rewriteTarget: { turnId: 't-new', available: false } }));
  assert.equal(unavailable.canRegenerate, false, 'the server says this turn cannot be rewritten');
  assert.equal(unavailable.canContinue, true);

  // Legacy payloads without rewriteTarget keep working from persisted messages.
  assert.equal(operationTargetsFor(detail([...oldTurn, ...latestTurn])).canRegenerate, true);
  assert.equal(operationTargetsFor(null).canContinue, false);
});

test('operation status lines are display-only and never player dialogue', () => {
  assert.equal(operationMarkerChatType('（继续）'), 'continue');
  assert.equal(operationMarkerChatType('（重新生成）'), 'regenerate');
  assert.equal(operationMarkerChatType('（编辑并重写）'), 'edit_regenerate');
  assert.equal(operationMarkerChatType(''), null);
  assert.equal(operationMarkerChatType('普通台词'), null);

  assert.equal(operationLabel({ kind: 'operation', content: '（继续）' }), '继续演出');
  assert.equal(operationLabel({ kind: 'operation', content: '（重新生成）' }), '重新生成');
  assert.equal(operationLabel({ kind: 'dialogue', content: '（继续）' }), null);
  assert.equal(operationLabel({ kind: 'operation', content: '未知标记' }), null);

  assert.equal(operationStatusText('pending'), '进行中');
  assert.equal(operationStatusText('failed'), '未完成');
  assert.equal(operationStatusText('cancelled'), '已停止');
  assert.equal(operationStatusText('committed'), '已完成');
  assert.equal(operationPendingText('continue'), '正在继续演出');
  assert.match(operationRetryLabel('regenerate'), /重试/);
});

// ------------------------------------------------------------ attempt identities ----
test('operation attempts carry the frozen chatType/target and stay invisible as player text', () => {
  const cont = operationAttempt('continue');
  assert.equal(cont.content, '');
  assert.equal(cont.chatType, 'continue');
  assert.equal(cont.turnId, null);
  assert.equal('targetTurnId' in cont, false);

  const regen = operationAttempt('regenerate', 't1');
  assert.deepEqual({ chatType: regen.chatType, targetTurnId: regen.targetTurnId, content: regen.content }, { chatType: 'regenerate', targetTurnId: 't1', content: '' });

  const edit = editRegenerateAttempt('t1', '  编辑后的消息  ');
  assert.equal(edit.chatType, 'edit_regenerate');
  assert.equal(edit.targetTurnId, 't1');
  assert.equal(edit.content, '编辑后的消息');
  assert.equal(isPlayerVisibleAttempt(edit), true);
  assert.equal(isPlayerVisibleAttempt(regen), false);
  assert.equal(isPlayerVisibleAttempt(cont), false);
  assert.equal(isPlayerVisibleAttempt({ clientTurnId: 'c', content: '你好', turnId: null }), true);

  // A retry copies the attempt verbatim, so the server sees the same idempotency identity.
  const retry = attemptForSend('', { ...regen, turnId: 't9' });
  assert.equal(retry.clientTurnId, regen.clientTurnId);
  assert.equal(retry.chatType, 'regenerate');
  assert.equal(retry.targetTurnId, 't1');
  assert.equal(retry.turnId, 't9');
});

// ------------------------------------------------------------------- recovery ----
﻿test('a committed rewrite replaces the old version instead of appending a second story', () => {
  const target = { clientTurnId: 'ctid-regen', content: '', turnId: null, chatType: 'regenerate' as const, targetTurnId: 't-new' };
  const state: ConversationState = { ...initialConversation, loading: false, detail: detail([...oldTurn, ...latestTurn]), pending: target };
  const newReply = msg({ id: 'a-rewritten', turnId: 't-rewritten', role: 'assistant', content: '重写后的回复', rewritable: true });
  const next = applyTurnEvent(state, { type: 'committed', turnId: 't-rewritten', message: newReply, messages: [newReply], world: { ...world, revision: 3 } });
  assert.equal(next.pending, null);
  assert.equal(next.detail?.world.revision, 3);
  assert.ok(!next.detail!.messages.some((message) => message.turnId === 't-new'), 'the superseded turn must disappear');
  assert.ok(next.detail!.messages.some((message) => message.id === 'a-rewritten'));
  assert.ok(next.detail!.messages.some((message) => message.id === 'u-old'), 'unrelated history must stay');
  // Applying the same terminal event again never duplicates the new version.
  assert.equal(applyTurnEvent(next, { type: 'committed', turnId: 't-rewritten', message: newReply, messages: [newReply], world: { ...world, revision: 3 } }).detail?.messages.length, next.detail!.messages.length);
  assert.deepEqual(replaceRewriteTarget([...oldTurn, ...latestTurn], 't-new').map((message) => message.turnId), ['t-old', 't-old']);

  // EditRegenerate replaces the old version too; whether the new turn is rewritable is the
  // server's verdict (Message.rewritable / SessionDetail.rewriteTarget), not a local blacklist.
  const editTarget = { ...target, chatType: 'edit_regenerate' as const };
  const edited = applyTurnEvent({ ...state, pending: editTarget }, { type: 'committed', turnId: 't-rewritten', message: newReply, messages: [newReply], world });
  assert.ok(!edited.detail!.messages.some((message) => message.turnId === 't-new'));
  const refreshed = detail(edited.detail!.messages.map((message) => ({ ...message, rewritable: true })), { rewriteTarget: { turnId: 't-rewritten', available: true } });
  assert.equal(operationTargetsFor(refreshed).canRegenerate, true, 'an edit-regenerate turn is regenerable again according to the server');
});

test('consecutive regenerate requests advance the server-authoritative target from A to B', () => {
  const seedDetail = detail([...oldTurn, { ...latestTurn[0], operation: 'chat' }, { ...latestTurn[1], operation: 'chat', rewritable: true }], { rewriteTarget: { turnId: 't-new', available: true } });
  const firstTarget = operationTargetsFor(seedDetail).turnId!;
  assert.equal(firstTarget, 't-new');
  const firstAttempt = operationAttempt('regenerate', firstTarget);
  assert.deepEqual(turnRequestBody(firstAttempt), { clientTurnId: firstAttempt.clientTurnId, chatType: 'regenerate', targetTurnId: 't-new' });

  const state: ConversationState = { ...initialConversation, loading: false, detail: seedDetail, pending: firstAttempt };
  const replyB = msg({ id: 'a-b', turnId: 't-b', role: 'assistant', content: 'B 版本的回复。', rewritable: true, operation: 'regenerate' });
  const afterFirst = applyTurnEvent(state, { type: 'committed', turnId: 't-b', message: replyB, messages: [replyB], world: { ...world, revision: 3 } });
  const secondTarget = operationTargetsFor(afterFirst.detail).turnId!;
  assert.equal(secondTarget, 't-b', 'the newest committed turn is B');
  const secondAttempt = operationAttempt('regenerate', secondTarget);
  const secondBody = turnRequestBody(secondAttempt);
  assert.equal(secondBody.targetTurnId, 't-b', 'the second regenerate targets B');
  assert.notEqual(secondBody.targetTurnId, firstTarget, 'the second regenerate must not still target A');
  assert.notEqual(secondBody.clientTurnId, firstBodyId(firstAttempt), 'each regenerate keeps its own idempotency key');
  assert.equal(afterFirst.detail!.messages.filter((message) => message.role === 'user' && message.content === '最新一句').length, 0, 'the superseded player message is archived rather than shown twice');
  assert.equal(operationLabel({ kind: 'dialogue', content: '最新一句' }), null, 'the question is never rendered as an operation line');
  function firstBodyId(attempt: Attempt) { return attempt.clientTurnId; }
});

test('after EditRegenerate a refresh still offers Regenerate from the server verdict', () => {
  const editedUser = msg({ id: 'u-edited', turnId: 't-edit', role: 'user', content: '编辑后的新问题。', kind: 'dialogue', operation: 'edit_regenerate' });
  const editedReply = msg({ id: 'a-edit', turnId: 't-edit', role: 'assistant', content: '编辑后重写的回复。', operation: 'edit_regenerate', rewritable: true });
  const refreshed = detail([...oldTurn, editedUser, editedReply], { rewriteTarget: { turnId: 't-edit', available: true } });
  const targets = operationTargetsFor(refreshed);
  assert.equal(targets.turnId, 't-edit');
  assert.equal(targets.canContinue, true);
  assert.equal(targets.canRegenerate, true, 'the server says the edit-regenerate turn is rewritable again');
  assert.equal(targets.userMessageId, 'u-edited');
  // Without the server verdict, a rewrite turn is not silently offered as rewritable.
  const legacy = detail([...oldTurn, editedUser, { ...editedReply, rewritable: undefined }]);
  assert.equal(operationTargetsFor(legacy).canRegenerate, false);
});

test('a stale or unavailable server rewriteTarget is never trusted over the latest committed turn', () => {
  const stale = detail([...oldTurn, { ...latestTurn[0], operation: 'chat' }, { ...latestTurn[1], operation: 'chat' }], { rewriteTarget: { turnId: 't-old', available: true } });
  const staleTargets = operationTargetsFor(stale);
  assert.equal(staleTargets.turnId, 't-new', 'a stale rewriteTarget cannot point the buttons at an older turn');
  assert.equal(staleTargets.canContinue, true);
  assert.equal(staleTargets.canRegenerate, true, 'the latest committed ordinary turn is still rewritable by inference');

  const unavailable = detail([...oldTurn, { ...latestTurn[0], operation: 'chat' }, { ...latestTurn[1], operation: 'chat', rewritable: false }], { rewriteTarget: { turnId: 't-new', available: false } });
  const hidden = operationTargetsFor(unavailable);
  assert.equal(hidden.canRegenerate, false, 'available=false hides regeneration');
  assert.equal(hidden.canContinue, true, 'continue remains available');
  assert.equal(hidden.turnId, 't-new');

  // An operation turn cannot be regenerated even when the server sends no verdict.
  const operationTurn = detail([...oldTurn, msg({ id: 'op', turnId: 't-op', role: 'user', kind: 'operation', content: '（继续）', operation: 'continue' }), msg({ id: 'a-op', turnId: 't-op', role: 'assistant', content: '继续后的回复。', operation: 'continue' })]);
  assert.equal(operationTargetsFor(operationTurn).canRegenerate, false);
  assert.equal(operationTargetsFor(operationTurn).canContinue, true);
});

test('a failed operation keeps its identity for a same-signal retry and leaves the old story untouched', () => {
  const pending: Attempt = { clientTurnId: 'ctid-continue', content: '', turnId: null, chatType: 'continue' };
  const state: ConversationState = { ...initialConversation, loading: false, detail: detail([...oldTurn, ...latestTurn]), pending };
  const failed = applyTurnEvent(state, { type: 'failed', turnId: 't-fail', code: 'ACTOR_FAILED', message: '回复未完成。' });
  assert.equal(failed.pending, null);
  assert.equal(failed.failed?.chatType, 'continue');
  assert.equal(failed.failed?.clientTurnId, 'ctid-continue');
  assert.equal(failed.failed?.targetTurnId, undefined);
  assert.deepEqual(failed.detail?.messages.map((message) => message.id), [...oldTurn, ...latestTurn].map((message) => message.id), 'the old reply must be preserved');

  const failedRegen = applyTurnEvent({ ...state, pending: { ...pending, chatType: 'regenerate', targetTurnId: 't-new' } }, { type: 'cancelled', turnId: 't-fail', code: 'TURN_CANCELLED', message: '已停止。' });
  assert.equal(failedRegen.failed?.chatType, 'regenerate');
  assert.equal(failedRegen.failed?.targetTurnId, 't-new');
  assert.equal(failedRegen.failed?.cancelled, true);
  assert.deepEqual(failedRegen.detail?.messages.map((message) => message.id), [...oldTurn, ...latestTurn].map((message) => message.id));
});

test('persistedOperationAttempt restores in-flight operations after a reload without any network call', () => {
  const pendingContinue = detail([
    ...oldTurn,
    msg({ id: 'op', turnId: 't-continue', role: 'user', kind: 'operation', content: '（继续）', status: 'pending' }),
  ]);
  const restored = persistedOperationAttempt(pendingContinue);
  assert.equal(restored?.chatType, 'continue');
  assert.equal(restored?.turnId, 't-continue');
  assert.equal(restored?.content, '');

  const pendingRegen = detail([
    ...oldTurn, ...latestTurn,
    msg({ id: 'op', turnId: 't-regen', role: 'user', kind: 'operation', content: '（重新生成）', status: 'pending', operation: 'regenerate' }),
  ], { rewriteTarget: { turnId: 't-new', available: true } });
  const regenRestored = persistedOperationAttempt(pendingRegen);
  assert.equal(regenRestored?.chatType, 'regenerate');
  assert.equal(regenRestored?.targetTurnId, 't-new');

  // A normal chat whose player message is still pending recovers as a chat retry.
  const pendingChat = detail([...oldTurn, msg({ id: 'u-pending', turnId: 't-pending', role: 'user', content: '没发完', status: 'pending' })]);
  const chatRestored = persistedOperationAttempt(pendingChat);
  assert.equal(chatRestored?.turnId, 't-pending');
  assert.equal(chatRestored?.content, '没发完');
  assert.equal(chatRestored?.chatType, undefined);

  // A completed reply is not an in-flight operation.
  assert.equal(persistedOperationAttempt(detail([...oldTurn, ...latestTurn])), null);

  // Openings keep their existing recovery path and fixed idempotency key.
  const pendingOpening = detail([msg({ id: 'op', turnId: 't-opening', role: 'user', kind: 'operation', content: '开场', status: 'pending' })], {
    session: { id: 's1', characterId: 'lin-wan', worldId: 'w1', title: '对话', createdAt: at, updatedAt: at, dynamicOpening: true },
  });
  const opening = persistedOperationAttempt(pendingOpening);
  assert.equal(opening?.operation, 'opening');
  assert.equal(opening?.clientTurnId, 'opening:s1');
});

test('recovery dedupes persisted messages and adopts the server-reported operation', () => {
  const pending: Attempt = { clientTurnId: 'ctid-continue', content: '', turnId: null, chatType: 'continue' };
  const state: ConversationState = { ...initialConversation, loading: false, detail: detail([...oldTurn, ...latestTurn]), pending };
  const userMessage = msg({ id: 'op', turnId: 't-continue', role: 'user', kind: 'operation', content: '（继续）' });
  const reply = msg({ id: 'a-continue', turnId: 't-continue', role: 'assistant', content: '继续后的回复' });
  const turn: TurnView = { id: 't-continue', worldId: 'w1', sessionId: 's1', status: 'running', phase: 'responding', userMessage, operation: 'continue' };
  const running = recoverTurn(state, turn);
  assert.equal(running.pending?.chatType, 'continue');
  assert.equal(running.phase, 'recovering');
  const committed = recoverTurn(state, { ...turn, status: 'committed', phase: 'settling', assistantMessage: reply, assistantMessages: [reply] });
  assert.equal(committed.pending, null);
  assert.equal(committed.phase, null);
  assert.deepEqual(committed.detail!.messages.map((message) => message.id), ['u-old', 'a-old', 'u-new', 'a-new', 'op', 'a-continue']);
  // Applying recovery twice still keeps one copy of each persisted message.
  const twice: ConversationState = { ...committed, pending: { ...pending, turnId: 't-continue' } };
  assert.equal(recoverTurn(twice, { ...turn, status: 'committed', phase: 'settling', assistantMessage: reply, assistantMessages: [reply] }).detail!.messages.length, 6);
  assert.equal(turnChatType(turn), 'continue');
  assert.equal(turnChatType({ operation: 'opening' }), null);
});

