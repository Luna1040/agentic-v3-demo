import type { RuntimeStatus } from '../shared/contracts.ts';
import type * as Harness from '../shared/harness.ts';
export type { ActorInput, ContextPack, DialogueReadRequest, DialogueReadResult, ActorResult, DialogueReadRecord } from '../shared/harness.ts';
export type ModelUsage = Harness.RuntimeUsage;
export type DialogueReader = (request: Harness.DialogueReadRequest) => Promise<Harness.DialogueReadResult>;
export type WorldChange = Harness.WorldChange;
export const MEMORY_POLICY = 'episode-observation-v5';
export type ActorCheckpoint = Harness.TurnCheckpoint;
export type PromptSet = Pick<Harness.RuntimePrompts, 'main'|'actor'|'updater'> & Partial<Pick<Harness.RuntimePrompts, 'opening'|'pulse'|'arbiter'>>;
// Only legacy test/adapter results may omit discardedChanges. Production keeps
// the full canonical result, including future fields such as evidence and reads.
export type TurnResult = Omit<Harness.TurnResult,'discardedChanges'|'changes'> & Partial<Pick<Harness.TurnResult,'discardedChanges'>> & {changes:WorldChange[]};
export type WorldTurnResult = Omit<Harness.WorldTurnResult,'discardedChanges'> & Partial<Pick<Harness.WorldTurnResult,'discardedChanges'>>;
export type RunTurnOptions = Harness.TurnCallOptions & Required<Pick<Harness.TurnCallOptions,'signal'|'onTextDelta'>>;
export interface StoryRuntime {
  actor(input:Harness.ActorInput,options:Harness.ActorCallOptions & Required<Pick<Harness.ActorCallOptions,'signal'|'onTextDelta'>>):Promise<Harness.ActorResult>;
  streamDialogue?(input: Harness.ActorInput, options: RunTurnOptions): Promise<WorldTurnResult>;
  planNextScene?: Harness.StoryRuntime['planNextScene'];
  settleOfflineTurn?: Harness.StoryRuntime['settleOfflineTurn'];
  settleWorldBatch?(entries: Array<{input:Harness.ActorInput;dialogue:WorldTurnResult}>, options:RunTurnOptions):Promise<WorldTurnResult[]>;
  settleWorldTurn?(input:Harness.ActorInput, dialogue:WorldTurnResult,options:RunTurnOptions):Promise<WorldTurnResult>;
  runTurn?(input:Harness.ActorInput,options:RunTurnOptions):Promise<TurnResult>;
  runWorldTurn?(input:Harness.ActorInput,options:RunTurnOptions):Promise<WorldTurnResult>;
  updateWorld(input:Harness.UpdaterInput,options:{signal:AbortSignal}):Promise<{changes:WorldChange[];scene?:Harness.SceneState;usage?:ModelUsage}>;
  testAgent?(key:Harness.AgentKey,input:Harness.ActorInput & {assistantText?:string},options:Harness.TestAgentOptions & {signal:AbortSignal}):ReturnType<Harness.StoryRuntime['testAgent']>;
  readonly prompts?:Readonly<PromptSet>;
  status:RuntimeStatus;
  readonly metadata?:Record<string,unknown>;
}
import type { ActorInput } from '../shared/harness.ts';

export class ServiceError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

/** Legacy user-evidence compatibility only. Modern scene memory, including NPC
 * actions and shared experiences, is committed through WorldOps v3 separately. */
export function validateChanges(value: unknown, input: Pick<ActorInput, 'turnId' | 'character' | 'userText'>): WorldChange[] {
  if (!Array.isArray(value) || value.length > 3 || typeof input.userText !== 'string' || !input.userText.trim() || input.userText.length > 8000) return [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const change = item as Record<string, unknown>;
    const evidence = change.evidence as Record<string, unknown> | undefined;
    if (Object.keys(change).sort().join(',') !== 'characterId,evidence,kind,text,visibility'
      || typeof change.kind !== 'string' || !['event', 'fact', 'relationship'].includes(change.kind)
      || typeof change.visibility !== 'string' || !['public', 'private'].includes(change.visibility)
      || typeof change.text !== 'string' || change.characterId !== input.character.id
      || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).sort().join(',') !== 'source,turnId'
      || evidence.source !== 'user' || evidence.turnId !== input.turnId) continue;
    return [{ kind: change.kind as WorldChange['kind'], text: input.userText,
      visibility: 'private', characterId: input.character.id,
      evidence: { source: 'user', turnId: input.turnId } }];
  }
  return [];
}
