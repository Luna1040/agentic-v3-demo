import type { WorldEntity, WorldClock, EpisodeMemory, WorldActivity, StoryTime } from './living-world.ts';
export type { WorldEntity, WorldClock, EpisodeMemory, SpeakerReply, EntityChange, WorldActivity, CreateSessionOptions } from './living-world.ts';
export interface Character {
  id: string; name: string; subtitle: string; description: string;
  initial: string; color: 'sage' | 'blue' | 'peach'; greeting: string;
  thumbnailUrl?: string | null; coverUrl?: string | null; language?: string;
  source?: 'sample' | 'legacy' | 'generated';
}
export interface PlayerProfile { id: string; name: string; persona: string; version: number }
export interface SceneState { location: string | null; presentCharacterIds: string[]; updatedAt?: string; mode?: 'direct' | 'ensemble' | 'observe'; situation?: string; playerPresent?: boolean }
export type AgentKey = 'main' | 'actor' | 'updater' | 'opening' | 'pulse' | 'arbiter';
export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface AgentCallRecord {
  id: string; parentId: string | null; attemptId: string; agent: AgentKey;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'reused';
  model: string; startedAt: string; completedAt?: string;
  input: unknown; output?: unknown; usage?: ModelUsage;
  error?: { code: string; message: string }; sourceCallId?: string;
}
export interface TurnTrace { turnId: string; status: TurnStatus; calls: AgentCallRecord[]; metadata?: Record<string, unknown> }
export interface PromptVersion { key: AgentKey; version: number; content: string; createdAt: string }
export interface AgentPromptConfig extends PromptVersion { label: string; defaultContent: string; model: string; history: PromptVersion[] }
export interface AgentTestResult { agent: AgentKey; calls: AgentCallRecord[]; output: unknown; usage?: ModelUsage; durationMs: number; committed: false }
export interface Session {
  id: string; worldId: string; characterId: string; title: string;
  createdAt: string; updatedAt: string;
  scene?: SceneState; dynamicOpening?: boolean;
}
export interface Message {
  playerName?: string;
  id: string; turnId: string | null; sessionId: string;
  role: 'user' | 'assistant'; content: string; createdAt: string;
  status?: 'committed' | 'pending' | 'failed' | 'cancelled';
  characterId?: string; characterName?: string; kind?: 'dialogue' | 'operation';
}
export interface MemoryEvidence { source: 'user'; turnId: string }
export type MemoryStatus = 'active' | 'unverified' | 'retracted';
export interface StoryEvent {
  id: string; kind: 'event' | 'fact' | 'relationship'; text: string;
  visibility: 'public' | 'private'; characterId: string;
  sourceTurnId: string; createdAt: string;
  status: MemoryStatus; evidence: MemoryEvidence | null;
  recordedAt?: string; storyTime?: StoryTime;
}
export interface WorldView {
  mainlinePlan?: import('../.harness-contract/mainline.js').MainlinePlan;
  eventLedger?: import('../.harness-contract/event-contract.js').EventRecord[];
  eventLedgerOverflow?: {openEvents:number;omittedOpenEvents:number};
  deferredCommands?: Array<{id:string;reason:string;evidenceIds:string[];sourceTurnId?:string}>;
  director?: { status: 'pending' | 'running' | 'completed' | 'failed'; turnId: string; errorCode?: string };
  settlementBacklog?: { pendingTurns: number; failedTurns: number; oldestPendingAt: string | null; unresolvedCommands?:number; unresolvedTurns?:number };
  settlements?: Array<{ turnId: string; status: 'pending' | 'running' | 'failed' | 'completed'; error?: { code: string; message: string }; attempts: number; unresolvedCommands?:number }>;
  playerProfile?: PlayerProfile | null;
  id: string; title: string; revision: number; createdAt: string;
  events: StoryEvent[];
  scene?: SceneState;
  memoryScopeCharacterId?: string;
  entities?: WorldEntity[]; episodes?: EpisodeMemory[]; clock?: WorldClock;
  activities?: WorldActivity[];
  storyTime?: StoryTime;
}
export interface RuntimeStatus {
  provider: 'demo' | 'live'; model: string; harness: { loaded: boolean; version: string };
  offlineSimulation: boolean;
  database?: 'postgresql';
  modelRouter?: 'kaonrouter' | 'fixture';
  developerTools?: boolean;
}
export interface RuntimeAuditView {
  capture:{id:string;startedAt:string;afterSeq:number;expectedTurns:number}|null;
  turns:Array<{id:string;seq:number;userText:string;status:TurnStatus;createdAt:string;updatedAt:string;settlementStatus?:'pending'|'running'|'failed'|'completed';attempts?:number;batchId?:string;callIds?:string[]}>;
  events:Array<{id:string;kind:string;at:string;turnId?:string;batchId?:string;attemptId?:string;data:Record<string,unknown>}>;
  backlog:{pendingTurns:number;failedTurns:number;unresolvedCommands?:number};
  worldRevision:number;
  world:{id:string;title:string;revision:number;capturedAt:string;scene?:SceneState;entities?:WorldEntity[];eventLedger?:WorldView['eventLedger']};
  calls?:Array<{turnId:string;record:AgentCallRecord}>;
  callsTruncated?:boolean;
  truncated:boolean;
}
export interface Bootstrap {
  characters: Character[]; sessions: Session[]; worlds: WorldView[]; status: RuntimeStatus;
}
export interface SessionDetail { session: Session; messages: Message[]; world: WorldView; hasMore: boolean; nextBefore: string | null }
export type TurnStatus = 'running' | 'committed' | 'failed' | 'cancelled';
export interface TurnView {
  id: string; worldId: string; sessionId: string; status: TurnStatus;
  phase: 'planning' | 'responding' | 'settling'; userMessage: Message;
  assistantMessage?: Message; assistantMessages?: Message[]; error?: { code: string; message: string };
}
export type TurnEvent =
  | { type: 'accepted'; turnId: string; userMessage: Message; replayed?: boolean }
  | { type: 'delta'; turnId: string; text: string; characterId?: string; characterName?: string; messageId?: string }
  | { type: 'phase'; turnId: string; phase: 'planning' | 'responding' | 'settling' }
  | { type: 'committed'; turnId: string; message: Message; messages?: Message[]; world: WorldView }
  | { type: 'failed' | 'cancelled'; turnId: string; code: string; message: string };
