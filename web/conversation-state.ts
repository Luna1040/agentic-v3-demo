import type { Message, SessionDetail, TurnEvent, TurnView } from '../shared/contracts';

export interface Attempt { clientTurnId: string; content: string; turnId: string | null; operation?: 'chat' | 'opening' }
export interface ConversationState {
  detail: SessionDetail | null;
  loading: boolean;
  error: string | null;
  pending: Attempt | null;
  failed: (Attempt & { message: string; cancelled?: boolean; newTurnRequired?: boolean }) | null;
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
export function persistedOpening(detail: SessionDetail): Attempt | null {
  if (!detail.session.dynamicOpening || detail.messages.some(message => message.role === 'assistant' && message.kind !== 'operation' && (!message.status || message.status === 'committed'))) return null;
  const operation = detail.messages.find(message => message.kind === 'operation' && message.role === 'user' && message.turnId);
  return operation ? { ...openingAttempt(detail.session.id), turnId: operation.turnId } : null;
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
    case 'committed': return { ...state, pending: null, draft: '', draftMessages: [], phase: null, failed: null, detail: { ...state.detail, world: event.world.revision >= state.detail.world.revision ? event.world : state.detail.world, messages: mergeMessages(markAttemptStatus(state.detail.messages, pending, 'committed'), (event.messages?.length ? event.messages : [event.message]).map(message => ({ ...message, status: 'committed' }))) } };
    case 'failed': case 'cancelled': return { ...state, pending: null, draft: '', draftMessages: [], phase: null, detail: { ...state.detail, messages: markAttemptStatus(state.detail.messages, pending, event.type) }, failed: { ...pending, message: event.message, cancelled: event.type === 'cancelled' } };
  }
}
export function recoverTurn(state: ConversationState, turn: TurnView): ConversationState {
  if (!state.detail || !state.pending || turn.sessionId !== state.detail.session.id) return state;
  if (state.pending.turnId && state.pending.turnId !== turn.id) return state;
  const next = { ...state, detail: { ...state.detail, messages: acceptUser(state.detail.messages, state.pending, { ...turn.userMessage, status: turn.status === 'running' ? 'pending' : turn.status }) }, pending: { ...state.pending, turnId: turn.id } };
  if (turn.status === 'running') return { ...next, phase: 'recovering' };
  const replies = turn.assistantMessages?.length ? turn.assistantMessages : turn.assistantMessage ? [turn.assistantMessage] : [];
  if (turn.status === 'committed' && replies.length) return { ...next, pending: null, phase: null, draft: '', draftMessages: [], failed: null, detail: { ...next.detail, messages: mergeMessages(next.detail.messages, replies.map(message => ({ ...message, status: 'committed' }))) } };
  return { ...next, pending: null, phase: null, draft: '', draftMessages: [], failed: { ...next.pending, message: turn.status === 'cancelled' ? '已停止生成。' : turn.error?.message || '本次回复没有完成，可以重试。', cancelled: turn.status === 'cancelled' } };
}
export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
