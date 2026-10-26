import type { TurnEvent, TurnView } from '../shared/contracts.ts';
import { ServiceError, validateChanges, type ActorCheckpoint, type StoryRuntime, type WorldTurnResult } from './runtime.ts';
import { StoryStore, type StoredTurn } from './store.ts';
import { observationText } from './observations.ts';
import { SettlementWorker } from './settlement-worker.ts';
import { DirectorWorker } from './director.ts';
import { dialogueExecution } from './execution-mode.ts';

export class TurnService {
  private active = new Map<string, { turn: StoredTurn; controller: AbortController; done: Promise<void> }>();
  readonly settlement: SettlementWorker;
  readonly director: DirectorWorker;
  constructor(readonly store: StoryStore, readonly runtime: StoryRuntime, resolveRuntime: () => Promise<StoryRuntime> = async () => runtime) {
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
      const execution = dialogueExecution(runtime, turn.input);
      phase = execution.phase;
      await renew();
      controller.signal.throwIfAborted();
      const {living,deferred,run,actorFirst} = execution;
      if (run) {
        emit({ type: 'phase', turnId: turn.id, phase });
        const result = await this.abortable(run(turn.input, {
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
        const committed = runtime.streamDialogue && worldResult
          ? await this.store.commitDialogue(turn, worldResult)
          : await this.store.commit(turn, result.text, changes, { scene: result.scene, usage: result.usage,
          ...(worldResult ? { replies: worldResult.replies, entityChanges: worldResult.entityChanges, activities: worldResult.activities, observations: worldResult.observations ?? {}, actorLocations: worldResult.actorLocations, storyTime: worldResult.storyTime, settledCharacterIds: worldResult.settledCharacterIds,
            ...(deferred ? { settlement: worldResult, actorFirst } : {}) } : {}) });
        emit({ type: 'committed', turnId: turn.id, ...committed });
        if (deferred) this.settlement.wake();
        return;
      }
      let text = turn.draft;
      if (text === null) {
        emit({ type: 'phase', turnId: turn.id, phase });
        const generated = await this.abortable(runtime.actor(turn.input, {
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
      const result = await this.abortable(runtime.updateWorld({ ...turn.input, assistantText: text }, { signal: controller.signal }), controller.signal);
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
