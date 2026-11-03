/**
 * Chat operation signals are intents, not player dialogue: they must never be rendered or
 * serialized as if the player typed them. This module is the single pure-logic owner of the
 * client-side shapes (request body, operation message labels, button targets), so it stays
 * dependency-free and can run inside the browser bundle and in plain Node tests.
 *
 * `ChatType`/`TurnOperation` come from the frozen shared contract; the guards below still
 * validate untrusted wire payloads at runtime.
 */
import type { ChatType, Message, TurnOperation } from '../shared/contracts';

export type { ChatType, TurnOperation };
export const CHAT_TYPES: readonly ChatType[] = ['chat', 'continue', 'regenerate', 'edit_regenerate'];
const CHAT_TYPE_SET = new Set<string>(CHAT_TYPES);
const REWRITE_CHAT_TYPES: readonly ChatType[] = ['regenerate', 'edit_regenerate'];
const TURN_OPERATION_SET = new Set<string>(['chat', 'opening', ...CHAT_TYPES]);

export function isChatType(value: unknown): value is ChatType {
  return typeof value === 'string' && CHAT_TYPE_SET.has(value);
}

export function isTurnOperation(value: unknown): value is TurnOperation {
  return typeof value === 'string' && TURN_OPERATION_SET.has(value);
}

/** Regenerate/EditRegenerate replace a previous reply instead of appending a new scene. */
export function isRewriteChatType(chatType: ChatType | null | undefined): boolean {
  return chatType !== null && chatType !== undefined && REWRITE_CHAT_TYPES.includes(chatType);
}

/** True for Continue, Regenerate and EditRegenerate (everything except a normal Chat turn). */
export function isOperationChatType(chatType: ChatType | null | undefined): boolean {
  return chatType !== null && chatType !== undefined && chatType !== 'chat';
}

export interface TurnRequestInput { clientTurnId: string; chatType?: ChatType; content?: string; targetTurnId?: string }

/**
 * The only place that builds the `POST /api/sessions/:id/turns` body. It copies an explicit
 * allowlist, so forged `question` / `previousResponse` / owner fields (or any other caller data)
 * can never be serialized. A plain Chat request omits `chatType`, keeping the legacy body
 * byte-identical; operations omit `content` where the server extracts authority itself.
 */
export function turnRequestBody(input: TurnRequestInput): TurnRequestInput {
  // An unknown signal is a client bug, not a new protocol: downgrade to a normal chat request
  // whose shape the server still validates strictly.
  const chatType: ChatType = isChatType(input.chatType) ? input.chatType : 'chat';
  const body: TurnRequestInput = { clientTurnId: input.clientTurnId };
  if (isOperationChatType(chatType)) body.chatType = chatType;
  if ((chatType === 'chat' || chatType === 'edit_regenerate') && typeof input.content === 'string') body.content = input.content;
  if (isRewriteChatType(chatType) && typeof input.targetTurnId === 'string' && input.targetTurnId) body.targetTurnId = input.targetTurnId;
  return body;
}

export const OPERATION_LABELS: Record<ChatType, string> = {
  chat: '发送消息',
  continue: '继续演出',
  regenerate: '重新生成',
  edit_regenerate: '编辑并重写',
};

/** Server-side internal markers on `kind:'operation'` messages, matched for display only. */
export function operationMarkerChatType(content: string): ChatType | null {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return null;
  if (text.includes('编辑')) return 'edit_regenerate';
  if (text.includes('重新生成') || text.includes('重写')) return 'regenerate';
  if (text.includes('继续')) return 'continue';
  return null;
}

/**
 * Label for an operation status line, or null when the message is not a renderable operation
 * (for example the internal opening marker, which the chat layout keeps hidden).
 */
export function operationLabel(message: Pick<Message, 'kind' | 'content'> & { operation?: TurnOperation }): string | null {
  if (message.kind !== 'operation') return null;
  // The server-reported operation is authoritative; the content marker is the legacy fallback.
  const operation = message.operation;
  if (operation && operation !== 'chat' && operation !== 'opening') return OPERATION_LABELS[operation];
  const chatType = operationMarkerChatType(message.content);
  return chatType ? OPERATION_LABELS[chatType] : null;
}

/** Machine-readable operation kind for the status line (display only). */
export function operationKindOf(message: Pick<Message, 'kind' | 'content'> & { operation?: TurnOperation }): TurnOperation | 'unknown' {
  if (isTurnOperation(message.operation)) return message.operation;
  return message.kind === 'operation' ? operationMarkerChatType(message.content) ?? 'unknown' : 'unknown';
}

export function operationStatusText(status: Message['status']): string {
  switch (status) {
    case 'pending': return '进行中';
    case 'failed': return '未完成';
    case 'cancelled': return '已停止';
    default: return '已完成';
  }
}

/** In-flight copy for the thinking indicator and composer footer. */
export function operationPendingText(chatType?: ChatType): string {
  switch (chatType) {
    case 'continue': return '正在继续演出';
    case 'regenerate': return '正在重新生成';
    case 'edit_regenerate': return '正在按修改重写';
    default: return '正在准备回应';
  }
}

export function operationRetryLabel(chatType?: ChatType): string {
  switch (chatType) {
    case 'continue': return '重试继续';
    case 'regenerate': return '重试重写';
    case 'edit_regenerate': return '重试编辑重写';
    default: return '重试这一轮';
  }
}

/**
 * Reads the authoritative turn operation from a turn or message. Accepts `object` so legacy
 * fixtures (and older persisted payloads without the field) still type-check and degrade to the
 * `kind:'operation'` marker inference instead of guessing.
 */
export function turnOperationOf(value: object): TurnOperation | null {
  const candidate = value as { operation?: unknown; turnOperation?: unknown };
  for (const raw of [candidate.operation, candidate.turnOperation]) if (isTurnOperation(raw)) return raw;
  return null;
}

/** The ChatType that ran this turn, or null for openings (and for unknown/legacy snapshots). */
export function turnChatType(turn: object): ChatType | null {
  const operation = turnOperationOf(turn);
  return operation && CHAT_TYPE_SET.has(operation) ? operation as ChatType : null;
}

/** Late-bound per-message operation; used to decide whether a turn is a rewritable normal chat. */
export function messageTurnOperation(message: object): TurnOperation | null {
  return turnOperationOf(message);
}

/** Server-computed "is this user message on the latest rewritable turn" (falls back to null). */
export function messageRewritable(message: object): boolean | null {
  const value = (message as { rewritable?: unknown }).rewritable;
  return typeof value === 'boolean' ? value : null;
}

export interface RewriteTarget { turnId: string; available: boolean }

/** Server-computed rewrite eligibility for the current session detail. */
export function rewriteTargetOf(detail: object | null): RewriteTarget | null {
  if (!detail) return null;
  const value = (detail as { rewriteTarget?: unknown }).rewriteTarget;
  if (!value || typeof value !== 'object') return null;
  const target = value as { turnId?: unknown; available?: unknown };
  return typeof target.turnId === 'string' && typeof target.available === 'boolean' ? { turnId: target.turnId, available: target.available } : null;
}

export interface OperationTargets {
  /** Latest committed turn; those buttons belong to it and nothing older. */
  turnId: string | null;
  assistantMessageId: string | null;
  userMessageId: string | null;
  canContinue: boolean;
  /** Regeneration only applies to a normal chat turn with real player input. */
  canRegenerate: boolean;
}

const SETTLED: readonly (Message['status'])[] = [undefined, 'committed'];
const settled = (message: Message) => SETTLED.includes(message.status);

/**
 * Buttons follow the authoritative persisted messages, so a reload restores exactly the same
 * available actions as a live stream: only the latest committed turn owns 继续/重写. Pending/
 * failed/local messages never own a target. `blockedTurnIds` is a pure display helper used by
 * tests; the app itself relies on the in-flight busy state and on the server verdict instead of a
 * local ban list.
 */
export function operationTargets(messages: readonly Message[], options: { blockedTurnIds?: Iterable<string> } = {}): OperationTargets {
  const empty: OperationTargets = { turnId: null, assistantMessageId: null, userMessageId: null, canContinue: false, canRegenerate: false };
  const committed = messages.filter(message => typeof message.turnId === 'string' && message.turnId.length > 0 && settled(message));
  if (!committed.length) return empty;
  const turnId = committed[committed.length - 1].turnId!;
  const group = committed.filter(message => message.turnId === turnId);
  const assistant = [...group].reverse().find(message => message.role === 'assistant' && message.kind !== 'operation');
  const user = [...group].reverse().find(message => message.role === 'user' && message.kind !== 'operation');
  const operationTurn = group.some(message => message.role === 'user' && message.kind === 'operation');
  // Prefer the server-reported turn operation and per-message rewrite verdict; the
  // operation-message marker is only the legacy fallback.
  const operation = group.map(messageTurnOperation).find((value): value is TurnOperation => value !== null) ?? null;
  const rewritableHint = group.map(messageRewritable).find((value): value is boolean => value !== null) ?? null;
  const rewritableTurn = rewritableHint !== null ? rewritableHint : operation !== null ? operation === 'chat' : !operationTurn;
  const blocked = new Set(options.blockedTurnIds ?? []);
  const canContinue = Boolean(assistant);
  // A server "rewritable" verdict is enough on its own: a rewrite turn keeps the authoritative
  // question as a normal message, so old kind-based assumptions must not veto it.
  const canRegenerate = canContinue && rewritableTurn && (Boolean(user) || rewritableHint === true) && !blocked.has(turnId);
  return { turnId, assistantMessageId: assistant?.id ?? null, userMessageId: user?.id ?? null, canContinue, canRegenerate };
}

function userMessageIn(messages: readonly Message[], turnId: string): Message | null {
  const group = messages.filter(message => message.turnId === turnId && message.role === 'user');
  return group.find(message => message.kind !== 'operation') ?? group[0] ?? null;
}

/**
 * Session-level targets: the server's `rewriteTarget` / `rewritable` verdicts are authoritative
 * (they already account for archived turns, later world interactions, openings and rewrite turns),
 * so a reload cannot show a stale or missing button. A stale snapshot may still carry a target for
 * an already-superseded turn; the buttons never move back to an older turn, they wait for the
 * refreshed session instead.
 */
export function operationTargetsFor(detail: object | null, options: { blockedTurnIds?: Iterable<string> } = {}): OperationTargets {
  if (!detail) return operationTargets([], options);
  const messages = (detail as { messages?: readonly Message[] }).messages ?? [];
  const inferred = operationTargets(messages, options);
  const blocked = new Set(options.blockedTurnIds ?? []);
  const rewriteTarget = rewriteTargetOf(detail);
  // Only the latest committed turn may own the buttons: an older target belongs to a superseded
  // snapshot (for example the pre-commit detail) and must not be clicked.
  if (rewriteTarget && (!inferred.turnId || rewriteTarget.turnId === inferred.turnId)) {
    const user = userMessageIn(messages, rewriteTarget.turnId);
    return {
      ...inferred,
      turnId: rewriteTarget.turnId,
      userMessageId: user?.id ?? null,
      canRegenerate: rewriteTarget.available && !blocked.has(rewriteTarget.turnId),
    };
  }
  // Compatibility while an older payload lacks rewriteTarget: a server-marked message carries
  // the rewritable turn itself.
  if (inferred.turnId) {
    const marked = [...messages].reverse().find(message => message.turnId === inferred.turnId && messageRewritable(message) === true);
    if (marked) {
      const user = userMessageIn(messages, inferred.turnId);
      return { ...inferred, userMessageId: user?.id ?? null, canRegenerate: !blocked.has(inferred.turnId) };
    }
  }
  return { ...inferred, canRegenerate: inferred.canRegenerate && !blocked.has(inferred.turnId ?? '') };
}
