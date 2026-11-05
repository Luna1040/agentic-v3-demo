import type { AgentKey, TurnEvent, TurnView } from '../shared/contracts.ts';
import { ServiceError, validateChanges, type ActorCheckpoint, type OperationRuntimeResolver, type StoryRuntime, type WorldTurnResult } from './runtime.ts';
import { StoryStore, type CommitOptions, type StoredTurn } from './store.ts';
import { observationText } from './observations.ts';
import { SettlementWorker } from './settlement-worker.ts';
import { DirectorWorker } from './director.ts';
import { dialogueExecution } from './execution-mode.ts';
import { attachOperationReference, buildOperationPrompts, normalizeOperationContext, operationPromptBudget, operationRuntimeIdentity, type OperationContext, type OperationTurnFields } from './chat-operations.ts';

const agentKeys: AgentKey[] = ['main', 'actor', 'updater', 'opening', 'pulse', 'arbiter'];

function promptVersionsOf(metadata: Record<string, unknown> | undefined): Partial<Record<AgentKey, number>> | undefined {
  const value = metadata?.promptVersions;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const versions: Partial<Record<AgentKey, number>> = {};
  for (const key of agentKeys) {
    const version = (value as Record<string, unknown>)[key];
    if (Number.isSafeInteger(version) && (version as number) >= 0) versions[key] = version as number;
  }
  return Object.keys(versions).length ? versions : undefined;
}

/** Production factory: one isolated runtime per operation turn, built from the same
 * Harness build identity and provider config (via `fork`). The shared runtime and
 * its prompts are never mutated, and plain chat never calls this. The operation
 * prompt budget is recorded in the runtime identity so audits can prove which
 * reference text reached the model request. */
export function createOperationRuntimeResolver(base: StoryRuntime): OperationRuntimeResolver {
  return async (context) => {
    if (!base.prompts || !base.fork) throw new ServiceError('RUNTIME_UNAVAILABLE', '当前运行时无法为操作回合隔离 Prompt。', 503);
    const prompts = buildOperationPrompts(base.prompts, context);
    const budget = operationPromptBudget(base.prompts, context);
    const versions = promptVersionsOf(base.metadata);
    return base.fork({ prompts, ...(versions ? { promptVersions: versions } : {}),
      identity: { ...operationRuntimeIdentity(context), chatOperationPrompt: {
        version: budget.version, limit: budget.limit, baseLength: budget.baseLength, policyLength: budget.policyLength,
        referenceLength: budget.referenceLength, questionLength: budget.questionLength, finalLength: budget.finalLength } } });
  };
}

export class TurnService {
  private active = new Map<string, { turn: StoredTurn; controller: AbortController; done: Promise<void> }>();
  readonly settlement: SettlementWorker;
  readonly director: DirectorWorker;
  constructor(readonly store: StoryStore, readonly runtime: StoryRuntime,
    resolveRuntime: () => Promise<StoryRuntime> = async () => runtime,
    private readonly operationRuntime?: OperationRuntimeResolver) {
    this.settlement = new SettlementWorker(store, resolveRuntime);
    this.director = new DirectorWorker(store, resolveRuntime);
    if (runtime.settleWorldTurn) this.settlement.start();
    if (runtime.planNextScene) this.director.start();
  }

  run(turn: StoredTurn, emit: (event: TurnEvent) => void, runtime = this.runtime): Promise<void> {
    const controller = new AbortController();
    const done = Promise.resolve().then(() => this.execute(turn, controller, emit, runtime));
    this.active.set(turn.id, { turn, controller, done });
    void done.finally(() => { if (this.active.get(turn.id)?.turn.attempt === turn.attempt) this.active.delete(turn.id); }).catch(() => {});
    return done;
  }

  /** The operation turn's server-authoritative reference. The previous response is
   * re-read from the store for the frozen target, so a Regenerate chain (A→B→C)
   * always carries the current committed reply (B), never a cached first version.
   * The join rule matches the store's frozen reference (one reply per assistant
   * message, joined with a newline). */
  private async authoritativeOperationContext(turn: StoredTurn, context: OperationContext): Promise<OperationContext> {
    if (context.chatType === 'chat' || context.chatType === 'continue') return context;
    const userText = turn.input?.userText;
    if (typeof userText === 'string' && userText.trim()) context.authoritativeUserMessage = userText;
    const targetTurnId = (turn as StoredTurn & OperationTurnFields).targetTurnId ?? context.previousResponse?.turnId;
    if (!targetTurnId) return context;
    try {
      const view = await this.store.getTurn(turn.ownerId, targetTurnId);
      const messages = view.assistantMessages?.length ? view.assistantMessages : (view.assistantMessage ? [view.assistantMessage] : []);
      const text = messages.map(message => message.content).join('\n');
      if (text.trim()) context.previousResponse = { turnId: targetTurnId, text };
    } catch { /* The store rejects an unavailable target before execution; keep the frozen reference. */ }
    return context;
  }

  private async execute(turn: StoredTurn, controller: AbortController, emit: (event: TurnEvent) => void, runtime: StoryRuntime): Promise<void> {
    let phase: 'planning' | 'responding' | 'settling' = 'responding';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const renew = async () => {
      try {
        if (!await this.store.renewAttempt(turn)) throw new ServiceError('TURN_LEASE_LOST', '本轮执行已结束或过期。');
        if (!finished) { timer = setTimeout(renew, Math.min(2000, Math.max(50, Math.floor(this.store.leaseMs / 3)))); timer.unref(); }
      } catch { controller.abort(new ServiceError('TURN_LEASE_LOST', '本轮执行已结束或过期。')); }
    };
    try {
      const operation = normalizeOperationContext(turn as StoredTurn & OperationTurnFields);
      const context = await this.authoritativeOperationContext(turn, operation);
      // Plain chat keeps the shared runtime object untouched; a chat operation gets
      // its own isolated runtime for this attempt only (never cached, never shared).
      const activeRuntime = context.chatType === 'chat' ? runtime
        : await (this.operationRuntime ?? createOperationRuntimeResolver(runtime))(context);
      // The complete reference travels in the isolated Actor prompt; this seam is the
      // single switch point should a legal ActorInput channel be confirmed later.
      const actorInput = attachOperationReference(turn.input, context);
      const execution = dialogueExecution(activeRuntime, actorInput);
      phase = execution.phase;
      await renew();
      controller.signal.throwIfAborted();
      const {living,deferred,run,actorFirst} = execution;
      if (run) {
        emit({ type: 'phase', turnId: turn.id, phase });
        const result = await this.abortable(run(actorInput, {
          attemptId: turn.attempt, signal: controller.signal,
          ...(deferred ? { deferWorldUpdate: true, actorFirst } : {}),
          ...(turn.checkpoint ? { resume: turn.checkpoint as unknown as ActorCheckpoint } : {}),
          onTextDelta: (delta, speaker) => { if (!controller.signal.aborted) emit({ type: 'delta', turnId: turn.id, text: delta, ...speaker }); },
          onCall: async record => {
            controller.signal.throwIfAborted();
            await this.store.saveCall(turn, record);
            if (record.status === 'running') {
              phase = record.agent === 'main' || record.agent === 'opening' || record.agent === 'pulse' ? 'planning' : record.agent === 'actor' ? 'responding' : 'settling';
              emit({ type: 'phase', turnId: turn.id, phase });
            }
          },
          onCheckpoint: async checkpoint => {
            controller.signal.throwIfAborted();
            if ((!checkpoint.living && !checkpoint.text.trim()) || checkpoint.text.length > (living ? 36000 : 12000)) throw new ServiceError('ACTOR_OUTPUT_INVALID', '回复未完成，请重试。', 502);
            await this.store.saveCheckpoint(turn, checkpoint);
          },
        }), controller.signal);
        controller.signal.throwIfAborted();
        if (!result.text.trim() || result.text.length > (living ? 36000 : 12000)) throw new ServiceError('ACTOR_OUTPUT_INVALID', '回复未完成，请重试。', 502);
        const worldResult = living ? result as WorldTurnResult : undefined;
        const changes = validateChanges(result.changes, worldResult ? { ...turn.input, userText: observationText(worldResult.observations?.[turn.input.character.id]) } : turn.input);
        // The store recognizes a rewrite from the frozen DB row (chat_type /
        // target_turn_id / rewrite_reference.snapshotId) and restores + fences +
        // archives inside the successful commit transaction. No extra options needed.
        const commitOptions: CommitOptions = { scene: result.scene, usage: result.usage,
          ...(worldResult ? { replies: worldResult.replies, entityChanges: worldResult.entityChanges, activities: worldResult.activities, observations: worldResult.observations ?? {}, actorLocations: worldResult.actorLocations, storyTime: worldResult.storyTime, settledCharacterIds: worldResult.settledCharacterIds,
            ...(deferred ? { settlement: worldResult, actorFirst } : {}) } : {}) };
        const committed = activeRuntime.streamDialogue && worldResult
          ? await this.store.commitDialogue(turn, worldResult)
          : await this.store.commit(turn, result.text, changes, commitOptions);
        emit({ type: 'committed', turnId: turn.id, ...committed });
        if (deferred) this.settlement.wake();
        return;
      }
      let text = turn.draft;
      if (text === null) {
        emit({ type: 'phase', turnId: turn.id, phase });
        const generated = await this.abortable(activeRuntime.actor(actorInput, {
          signal: controller.signal,
          onTextDelta: (delta) => { if (!controller.signal.aborted) emit({ type: 'delta', turnId: turn.id, text: delta }); },
        }), controller.signal);
        controller.signal.throwIfAborted();
        text = generated.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 12_000) throw new ServiceError('ACTOR_OUTPUT_INVALID', '回复未完成，请重试。', 502);
        await this.store.saveDraft(turn, text, generated.usage);
      } else {
        // A failed settlement resumes the durable actor draft, without another model reply.
        emit({ type: 'delta', turnId: turn.id, text });
      }
      phase = 'settling';
      emit({ type: 'phase', turnId: turn.id, phase });
      // WorldOps always receives the base Actor input (no operation reference data).
      const result = await this.abortable(activeRuntime.updateWorld({ ...turn.input, assistantText: text }, { signal: controller.signal }), controller.signal);
      controller.signal.throwIfAborted();
      const changes = validateChanges(result.changes, turn.input);
      const committed = await this.store.commit(turn, text, changes, result.usage);
      emit({ type: 'committed', turnId: turn.id, ...committed });
    } catch (error) {
      const cancelled = controller.signal.aborted && !(controller.signal.reason instanceof ServiceError);
      const providerTimeout=error instanceof Error && 'code' in error && error.code==='PROVIDER_TIMEOUT';
      const code = cancelled ? 'TURN_CANCELLED' : providerTimeout ? 'PROVIDER_TIMEOUT' : error instanceof ServiceError ? error.code : phase === 'settling' ? 'WORLD_UPDATE_FAILED' : phase === 'planning' ? 'MAIN_AGENT_FAILED' : 'ACTOR_FAILED';
      const message = cancelled ? '已停止本轮，可以重试。' : providerTimeout ? '模型响应超时，本轮未生成完整回复。原消息已保留，可直接重试。' : error instanceof ServiceError ? error.message : phase === 'settling' ? '故事变化未能保存，重试会继续保存这次回复。' : phase === 'planning' ? '主 Agent 未完成调度，请查看调用记录后重试。' : '回复未完成，请重试。';
      try { await this.store.finish(turn, cancelled ? 'cancelled' : 'failed', code, message); } catch { /* The database fences a newer attempt. */ }
      // A cancelled provider may return after a retry started. Its stream must not
      // publish a stale terminal event for the newer attempt of the same turn.
      try {
        const current = await this.store.getTurn(turn.ownerId, turn.id);
        if ((await this.store.storedTurn(turn.ownerId, turn.id)).attempt === turn.attempt && (current.status === 'cancelled' || current.status === 'failed')) {
          emit({ type: current.status, turnId: turn.id, code: current.error?.code ?? code, message: current.error?.message ?? message });
        }
      } catch { /* Store may already be closed during shutdown. */ }
    } finally { finished = true; clearTimeout(timer); }
  }

  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, interrupted]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async cancel(ownerId: string, id: string, attempt?: string): Promise<TurnView> {
    const cancelled = await this.store.cancelTurn(ownerId, id, attempt);
    const { view } = cancelled;
    const active = this.active.get(id);
    if (view.status === 'cancelled' && active?.turn.attempt === cancelled.attempt) active.controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    return view;
  }

  async shutdown(): Promise<void> {
    await this.director.shutdown();
    await this.settlement.shutdown();
    for (const { turn, controller } of this.active.values()) {
      try { await this.store.finish(turn, 'cancelled', 'RUN_INTERRUPTED', '服务已停止，可以重试。'); } catch { /* Lost lease. */ }
      controller.abort(new DOMException('Service stopped', 'AbortError'));
    }
    // Do not wait indefinitely for a provider that fails to honor cancellation.
    await Promise.race([Promise.allSettled([...this.active.values()].map(({ done }) => done)), new Promise((resolve) => { const timer = setTimeout(resolve, 2000); timer.unref(); })]);
  }
}
