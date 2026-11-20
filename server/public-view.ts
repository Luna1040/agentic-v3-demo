import type { Bootstrap, Character, Message, PlayerProfile, SceneState, Session, SessionDetail, StoryEvent, TurnEvent, TurnView, WorldEntity, WorldView } from '../shared/contracts.ts';
import type { StoryTime } from '../shared/living-world.ts';

// Explicit projections are shared by JSON and SSE. New internal fields stay private by default.
export function publicCharacter(value: Character): Character {
  return { id: value.id, name: value.name, subtitle: value.subtitle, description: value.description,
    initial: value.initial, color: value.color, greeting: value.greeting,
    thumbnailUrl: value.thumbnailUrl, coverUrl: value.coverUrl, language: value.language, source: value.source };
}
export function publicProfile(value: PlayerProfile): PlayerProfile {
  return { id: value.id, name: value.name, persona: value.persona, version: value.version };
}
function publicScene(value: SceneState): SceneState {
  return { location: value.location, presentCharacterIds: value.presentCharacterIds.filter(id => typeof id === 'string'),
    updatedAt: value.updatedAt, mode: value.mode, situation: value.situation, playerPresent: value.playerPresent };
}
function publicTime(value: StoryTime): StoryTime {
  return { day: value.day, minute: value.minute, precision: value.precision, period: value.period,
    source: { kind: value.source.kind } };
}
function publicEntity(value: WorldEntity): WorldEntity {
  const state: Record<string, unknown> = {};
  for (const key of ['initial', 'color', 'narrativeName', 'locationId', 'parentLocationId', 'holderCharacterId', 'ownerCharacterId']) {
    if (typeof value.state[key] === 'string') state[key] = value.state[key];
  }
  if (['proposed', 'active', 'completed', 'failed', 'cancelled'].includes(String(value.state.status))) state.status = value.state.status;
  return { id: value.id, kind: value.kind, name: value.name, description: value.description, state,
    knownByCharacterIds: value.knownByCharacterIds.filter((id: string) => typeof id === 'string'), sourceTurnId: value.sourceTurnId,
    createdAt: value.createdAt, updatedAt: value.updatedAt, version: value.version };
}
function publicMemory(value: StoryEvent): StoryEvent {
  return { id: value.id, kind: value.kind, text: value.text, visibility: value.visibility, characterId: value.characterId,
    sourceTurnId: value.sourceTurnId, createdAt: value.createdAt, recordedAt: value.recordedAt, status: value.status,
    evidence: value.evidence ? { source: value.evidence.source, turnId: value.evidence.turnId } : null,
    ...(value.storyTime ? { storyTime: publicTime(value.storyTime) } : {}) };
}
export function publicWorld(value: WorldView): WorldView {
  return { id: value.id, title: value.title, revision: value.revision, createdAt: value.createdAt,
    events: value.events.map(publicMemory), entities: value.entities?.map(publicEntity),
    ...(value.scene ? { scene: publicScene(value.scene) } : {}),
    playerProfile: value.playerProfile ? publicProfile(value.playerProfile) : null,
    ...(value.storyTime ? { storyTime: publicTime(value.storyTime) } : {}),
    ...(value.clock ? { clock: { mode: value.clock.mode, rate: value.clock.rate, asOf: value.clock.asOf,
      fromRealAt: value.clock.fromRealAt, elapsedRealMs: value.clock.elapsedRealMs,
      fromWorldMs: value.clock.fromWorldMs, toWorldMs: value.clock.toWorldMs } } : {}),
    ...(value.settlementBacklog ? { settlementBacklog: {
      pendingTurns: value.settlementBacklog.pendingTurns, failedTurns: value.settlementBacklog.failedTurns,
      oldestPendingAt: value.settlementBacklog.oldestPendingAt } } : {}) };
}
function publicSession(value: Session): Session {
  return { id: value.id, worldId: value.worldId, characterId: value.characterId, title: value.title,
    createdAt: value.createdAt, updatedAt: value.updatedAt, dynamicOpening: value.dynamicOpening,
    ...(value.scene ? { scene: publicScene(value.scene) } : {}) };
}
export function publicMessage(value: Message): Message {
  return { id: value.id, turnId: value.turnId, sessionId: value.sessionId, role: value.role,
    content: value.kind === 'operation' ? '开始故事' : value.content, createdAt: value.createdAt,
    status: value.status, kind: value.kind, characterId: value.characterId, characterName: value.characterName, playerName: value.playerName };
}
export function publicMessages(value: { messages: Message[]; hasMore: boolean; nextBefore: string | null }) {
  return { messages: value.messages.map(publicMessage), hasMore: value.hasMore, nextBefore: value.nextBefore };
}
export function publicSessionDetail(value: SessionDetail): SessionDetail {
  return { session: publicSession(value.session), ...publicMessages(value), world: publicWorld(value.world) };
}
export function publicBootstrap(value: Bootstrap): Bootstrap {
  return { characters: value.characters.map(publicCharacter), sessions: value.sessions.map(publicSession),
    worlds: value.worlds.map(publicWorld), status: { provider: value.status.provider } };
}
const errors: Record<string, string> = {
  AUTH_REQUIRED: '请先登录。', DEVELOPER_REQUIRED: '你没有访问此功能的权限。',
  INPUT_INVALID: '请求内容无效，请检查后重试。', NOT_FOUND: '内容不存在或无法访问。',
  WORLD_CHANGED: '故事已更新，请刷新后重试。', RUNTIME_CHANGED: '会话配置已更新，请刷新后重新发送。',
  REVISION_CONFLICT: '内容已有更新，请刷新后重试。',
  PROFILE_CHANGED: '玩家身份已更新，请载入最新版本后重试。', PROFILE_NOT_FOUND: '玩家身份已不存在，请重新选择。',
  WORLD_BUSY: '这个故事正在处理中，请稍后重试。', TURN_RUNNING: '这轮回复仍在生成，请稍后查看。',
  TURN_CANCELLED: '已停止本轮，可以重试。', PROVIDER_TIMEOUT: '回复超时，请稍后重试。',
};
export function publicError(code?: string, status?: number) {
  return code && Object.hasOwn(errors, code) ? { code, message: errors[code] }
    : status === 404 ? { code: 'NOT_FOUND', message: errors.NOT_FOUND }
      : { code: 'REQUEST_FAILED', message: '本次请求未完成，请稍后重试。' };
}
export function publicTurn(value: TurnView): TurnView {
  return { id: value.id, worldId: value.worldId, sessionId: value.sessionId, status: value.status,
    phase: 'responding', userMessage: publicMessage(value.userMessage),
    ...(value.assistantMessage ? { assistantMessage: publicMessage(value.assistantMessage) } : {}),
    ...(value.assistantMessages ? { assistantMessages: value.assistantMessages.map(publicMessage) } : {}),
    ...(value.error ? { error: publicError(value.error.code) } : {}) };
}
export function publicTurnEvent(value: TurnEvent): TurnEvent {
  switch (value.type) {
    case 'accepted': return { type: value.type, turnId: value.turnId, userMessage: publicMessage(value.userMessage), replayed: value.replayed };
    case 'delta': return { type: value.type, turnId: value.turnId, text: value.text, characterId: value.characterId, characterName: value.characterName, messageId: value.messageId };
    case 'phase': return { type: value.type, turnId: value.turnId, phase: 'responding' };
    case 'committed': return { type: value.type, turnId: value.turnId, message: publicMessage(value.message),
      ...(value.messages ? { messages: value.messages.map(publicMessage) } : {}), world: publicWorld(value.world) };
    case 'failed': case 'cancelled': return { type: value.type, turnId: value.turnId, ...publicError(value.code) };
  }
}
