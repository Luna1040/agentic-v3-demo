import type { Message, SessionDetail, TurnEvent, TurnView } from '../shared/contracts';
import { createClientTurnId } from './client-turn-id.ts';
import { isRewriteChatType, messageTurnOperation, operationMarkerChatType, operationTargetsFor, turnChatType, type ChatType } from './chat-operations.ts';

export interface Attempt {
  clientTurnId: string;
  content: string;
  turnId: string | null;
  operation?: 'chat' | 'opening';
  /** Operation signal carried to the server; a retry must keep this exact value. */
  chatType?: ChatType;
  /** Server-validated rewrite target; a retry must keep this exact value. */
  targetTurnId?: string;
}
export interface ConversationState {
  detail: SessionDetail | null;
  loading: boolean;
  error: string | null;
  pending: Attempt | null;
  failed: (Attempt & { message: string; cancelled?: boolean; newTurnRequired?: boolean; notRetryable?: boolean }) | null;
  draft: string;
  draftMessages: Message[];
  phase: 'planning' | 'responding' | 'settling' | 'recovering' | null;
}
export const initialConversation: ConversationState = { detail: null, loading: true, error: null, pending: null, failed: null, draft: '', draftMessages: [], phase: null };
export function needsOpening(detail: SessionDetail): boolean {
  // Only a never-attempted session may start a paid request without another click.
  // Failed/cancelled operation messages survive remounts even when hook state does not.
  return Boolean(detail.session.dynamicOpening && !detail.hasMore && detail.messages.length === 0);
}
export function openingAttempt(sessionId: string): Attempt { return { clientTurnId: `opening:${sessionId}`, content: '', turnId: null, operation: 'opening' }; }
export function attemptForSend(content: string, retry?: Attempt): Attempt {
  // A retry (chat or opening) must keep its original idempotency key so the server can
  // replay the same turn instead of accepting another one. Only a fresh send mints an id.
  return retry ? { ...retry } : { clientTurnId: createClientTurnId(), content: content.trim(), turnId: null };
}
/** A fresh Continue/Regenerate signal: no player content, the server extracts authority. */
export function operationAttempt(chatType: ChatType, targetTurnId?: string): Attempt {
  return { clientTurnId: createClientTurnId(), content: '', turnId: null, chatType, ...(targetTurnId ? { targetTurnId } : {}) };
}
/** A fresh EditRegenerate signal: the edited text is the authoritative user message. */
export function editRegenerateAttempt(targetTurnId: string, content: string): Attempt {
  return { clientTurnId: createClientTurnId(), content: content.trim(), turnId: null, chatType: 'edit_regenerate', targetTurnId };
}
/** Only normal Chat and EditRegenerate carry visible player text; operations are status lines. */
export function isPlayerVisibleAttempt(attempt: Attempt): boolean {
  return attempt.operation !== 'opening' && (attempt.chatType === undefined || attempt.chatType === 'chat' || attempt.chatType === 'edit_regenerate');
}
/** A successful rewrite replaces the old version instead of appending a second story. */
export function replaceRewriteTarget(messages: Message[], targetTurnId: string | null | undefined): Message[] {
  return targetTurnId ? messages.filter(message => message.turnId !== targetTurnId) : messages;
}
export function persistedOpening(detail: SessionDetail): Attempt | null {
  if (!detail.session.dynamicOpening || detail.messages.some(message => message.role === 'assistant' && message.kind !== 'operation' && (!message.status || message.status === 'committed'))) return null;
  const operation = detail.messages.find(message => message.kind === 'operation' && message.role === 'user' && message.turnId);
  return operation ? { ...openingAttempt(detail.session.id), turnId: operation.turnId } : null;
}
/**
 * Restores an in-flight operation after a reload or a dropped connection without any network
 * call: the persisted message status is the only evidence the browser has. Chat and opening keep
 * their existing recovery; Continue/Regenerate restore the same chatType/targetTurnId so a retry
 * preserves the server-side idempotency identity.
 */
export function persistedOperationAttempt(detail: SessionDetail): Attempt | null {
  const opening = persistedOpening(detail);
  if (opening) return opening;
  const messages = detail.messages;
  const pendingOperation = [...messages].reverse().find(message => message.kind === 'operation' && message.role === 'user' && Boolean(message.turnId) && message.status === 'pending');
  if (pendingOperation?.turnId) {
    // The server-reported turn operation wins; the internal marker is only a fallback.
    const turnOperation = messageTurnOperation(pendingOperation);
    const reported = turnOperation && turnOperation !== 'chat' && turnOperation !== 'opening' ? turnOperation : null;
    const chatType = reported ?? operationMarkerChatType(pendingOperation.content) ?? 'continue';
    // The server's rewrite verdict decides the target turn; no local ban list is involved.
    const targets = operationTargetsFor(detail);
    const targetTurnId = chatType === 'regenerate' && targets.canRegenerate ? targets.turnId : null;
    return {
      clientTurnId: `operation:${pendingOperation.turnId}`,
      content: '',
      turnId: pendingOperation.turnId,
      chatType,
      ...(targetTurnId ? { targetTurnId } : {}),
    };
  }
  // A plain chat, an EditRegenerate or a Regenerate turn keeps a normal player message while it
  // runs (a rewrite turn's message is the authoritative question), so the server-reported turn
  // operation decides how the same signal is retried.
  const pendingUser = [...messages].reverse().find(message => message.role === 'user' && message.kind !== 'operation' && message.status === 'pending' && Boolean(message.turnId));
  if (!pendingUser?.turnId) return null;
  const turnId = pendingUser.turnId;
  const answered = messages.some(message => message.turnId === turnId && message.role === 'assistant' && message.kind !== 'operation');
  if (answered) return null;
  const operation = messageTurnOperation(pendingUser);
  const chatType = operation && operation !== 'chat' && operation !== 'opening' ? operation : null;
  const targets = chatType && isRewriteChatType(chatType) ? operationTargetsFor(detail) : null;
  const targetTurnId = targets?.canRegenerate ? targets.turnId : null;
  return {
    clientTurnId: `resume:${turnId}`,
    content: pendingUser.content,
    turnId,
    ...(chatType ? { chatType } : {}),
    ...(targetTurnId ? { targetTurnId } : {}),
  };
}
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const map = new Map(current.map(message => [message.id, message]));
  incoming.forEach(message => map.set(message.id, message));
  return [...map.values()];
}
export function acceptUser(messages: Message[], attempt: Attempt, message: Message): Message[] {
  return mergeMessages(messages.filter(item => item.id !== 'local-' + attempt.clientTurnId), [message]);
}
export function markAttemptStatus(messages: Message[], attempt: Attempt, status: Message['status']): Message[] {
  return messages.map(message => message.role === 'user' && (
    message.id === 'local-' + attempt.clientTurnId || (attempt.turnId !== null && message.turnId === attempt.turnId)
  ) ? { ...message, status } : message);
}
function committedMessages(state: ConversationState, pending: Attempt, incoming: Message[]): Message[] {
  // A rewrite replaces its old version: drop the target turn before merging the new reply.
  const base = isRewriteChatType(pending.chatType) ? replaceRewriteTarget(state.detail!.messages, pending.targetTurnId) : state.detail!.messages;
  return mergeMessages(markAttemptStatus(base, pending, 'committed'), incoming.map(message => ({ ...message, status: 'committed' as const })));
}
export function applyTurnEvent(state: ConversationState, event: TurnEvent): ConversationState {
  if (!state.detail || !state.pending) return state;
  if (state.pending.turnId && state.pending.turnId !== event.turnId) return state;
  const pending = { ...state.pending, turnId: event.turnId };
  switch (event.type) {
    case 'accepted': return { ...state, pending, detail: { ...state.detail, messages: acceptUser(state.detail.messages, pending, event.userMessage) } };
    case 'delta': {
      const id = event.messageId || `stream-${event.characterId || state.detail.session.characterId}`;
      const previous = state.draftMessages.find(message => message.id === id);
      const message: Message = { ...previous, id, sessionId: state.detail.session.id, turnId: event.turnId, role: 'assistant', playerName: state.detail.world.playerProfile?.name, content: (previous?.content || '') + event.text, createdAt: previous?.createdAt || new Date().toISOString(), characterId: event.characterId, characterName: event.characterName, kind: 'dialogue' };
      return { ...state, pending, draft: state.draft + event.text, draftMessages: mergeMessages(state.draftMessages, [message]) };
    }
    case 'phase': return { ...state, pending, phase: event.phase };
    case 'committed': return { ...state, pending: null, draft: '', draftMessages: [], phase: null, failed: null, detail: { ...state.detail, world: event.world.revision >= state.detail.world.revision ? event.world : state.detail.world, messages: committedMessages(state, pending, event.messages?.length ? event.messages : [event.message]) } };
    case 'failed': case 'cancelled': return { ...state, pending: null, draft: '', draftMessages: [], phase: null, detail: { ...state.detail, messages: markAttemptStatus(state.detail.messages, pending, event.type) }, failed: { ...pending, message: event.message, cancelled: event.type === 'cancelled' } };
  }
}
export function recoverTurn(state: ConversationState, turn: TurnView): ConversationState {
  if (!state.detail || !state.pending || turn.sessionId !== state.detail.session.id) return state;
  if (state.pending.turnId && state.pending.turnId !== turn.id) return state;
  // The persisted turn is authoritative about which operation actually ran. A rewrite signal
  // restores its target from the server verdict so a retry keeps the same authoritative question.
  const persistedChatType = turnChatType(turn);
  const rewriteTargets = isRewriteChatType(persistedChatType) ? operationTargetsFor(state.detail) : null;
  const pending: Attempt = {
    ...state.pending,
    turnId: turn.id,
    ...(persistedChatType ? { chatType: persistedChatType } : {}),
    ...(rewriteTargets?.canRegenerate && rewriteTargets.turnId ? { targetTurnId: rewriteTargets.turnId } : {}),
  };
  const next = { ...state, detail: { ...state.detail, messages: acceptUser(state.detail.messages, pending, { ...turn.userMessage, status: turn.status === 'running' ? 'pending' : turn.status }) }, pending };
  if (turn.status === 'running') return { ...next, phase: 'recovering' };
  const replies = turn.assistantMessages?.length ? turn.assistantMessages : turn.assistantMessage ? [turn.assistantMessage] : [];
  if (turn.status === 'committed' && replies.length) return { ...next, pending: null, phase: null, draft: '', draftMessages: [], failed: null, detail: { ...next.detail, messages: committedMessages(next, pending, replies) } };
  return { ...next, pending: null, phase: null, draft: '', draftMessages: [], failed: { ...pending, message: turn.status === 'cancelled' ? '已停止生成。' : turn.error?.message || '本次回复没有完成，可以重试。', cancelled: turn.status === 'cancelled' } };
}
export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
