import { ServiceError, type StoryRuntime } from './runtime.ts';
import type { StoryStore, SettlementJob } from './store.ts';

/** Durable queue owns ordering and fencing; this worker never owns dialogue replies. */
export class SettlementWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private busy?: Promise<void>;
  private controller?: AbortController;
  constructor(private store: StoryStore, private resolveRuntime: () => Promise<StoryRuntime>) {}

  start(): void { this.schedule(0); }
  wake(): void { if (!this.busy) this.schedule(0); }
  private schedule(delay = 1000): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.busy = this.drain().catch(error => {
        // Deliberately exclude provider payloads, credentials and dialogue text.
        console.error('Settlement worker unavailable:', error instanceof ServiceError ? error.code : 'STORE_OR_RUNTIME_UNAVAILABLE');
      }).finally(() => { this.busy = undefined; this.schedule(); });
    }, delay);
    this.timer.unref();
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const runtime = await this.resolveRuntime();
      if (this.stopped || !runtime.settleWorldTurn) return;
      const jobs = await this.store.claimSettlementBatch(runtime.metadata, runtime.settleWorldBatch ? 3 : 1);
      if (!jobs.length) return;
      if (this.stopped) { for (const job of jobs) await this.store.failSettlement(job, new ServiceError('SETTLEMENT_INTERRUPTED', '服务已停止，整理任务会在重启后恢复。')); return; }
      await this.process(jobs, runtime);
    }
  }
  private async process(jobs: SettlementJob[], runtime: StoryRuntime): Promise<void> {
    const job=jobs[0];
    const controller = new AbortController(); this.controller = controller;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => controller.abort(new ServiceError('SETTLEMENT_TIMEOUT', '整理超时，回复已保存，后台会重试。')), 180000);
    deadline.unref();
    let ended = false;
    const renew = async () => {
      try {
        for (const member of jobs) if (!await this.store.renewSettlement(member)) throw new ServiceError('SETTLEMENT_LEASE_LOST', '整理任务已交由新的执行处理。');
        if (!ended) { heartbeat = setTimeout(renew, Math.min(2000, Math.max(50, this.store.leaseMs / 3))); heartbeat.unref(); }
      } catch (error) { controller.abort(error); }
    };
    try {
      await renew(); controller.signal.throwIfAborted();
      if (!jobs.every(member=>member.result)) {
        // Offline settlement uses each source's original time window. Earlier
        // entries in this same batch advance only their own reviewed cursors.
        const cursors=new Map<string,{recordedAt:string;storyTime:NonNullable<SettlementJob['offlineResult']>['storyTime']}>();
        for(const member of jobs){
          if(!member.offlineResult && runtime.settleOfflineTurn && member.dialogue.storyTime && !member.dialogue.activities.length && !member.dialogue.settledCharacterIds?.length){
            // Offline actions must use the then-known location and permissions,
            // not the later entity projection used to merge memory updates.
            const offlineInput=structuredClone(member.evidence?.input ?? (await this.store.storedTurn(member.ownerId,member.turnId)).input);
            for(const [id,packet] of Object.entries(offlineInput.worldContext?.actorInputs??{})) {
              const settled=member.input.worldContext?.actorInputs[id]?.worldContext?.temporal?.lastSettled;
              if(settled && packet.worldContext?.temporal) packet.worldContext.temporal.lastSettled=structuredClone(settled);
            }
            const settled=member.input.worldContext?.temporal?.lastSettled;
            if(settled && offlineInput.worldContext?.temporal)offlineInput.worldContext.temporal.lastSettled=structuredClone(settled);
            for(const [id,cursor] of cursors){
              const packet=offlineInput.worldContext?.actorInputs[id];
              if(packet?.worldContext?.temporal && cursor.storyTime) packet.worldContext.temporal.lastSettled={recordedAt:cursor.recordedAt,storyTime:cursor.storyTime};
              if(id===offlineInput.character.id && offlineInput.worldContext?.temporal && cursor.storyTime)offlineInput.worldContext.temporal.lastSettled={recordedAt:cursor.recordedAt,storyTime:cursor.storyTime};
            }
            const offline=await this.abortable(runtime.settleOfflineTurn(offlineInput,{attemptId:member.attempt,signal:controller.signal,
              onResult:async result=>{controller.signal.throwIfAborted();await this.store.saveSettlementOffline(member,result,true);member.offlineResult=result;},
              onCall:async record=>{controller.signal.throwIfAborted();await this.store.saveSettlementCall(member,record);}}),controller.signal);
            if(!member.offlineResult)await this.store.saveSettlementOffline(member,offline); member.offlineResult=offline;
          }
          for(const id of member.offlineResult?.settledCharacterIds??[]) cursors.set(id,{recordedAt:member.input.worldContext!.temporal!.real.now,storyTime:member.offlineResult!.storyTime});
        }
        const entries=jobs.map(member=>{
          const input=structuredClone(member.input),dialogue=structuredClone(member.dialogue);
          if(member.offlineResult) dialogue.activities=[...dialogue.activities,...member.offlineResult.activities];
          // WorldOps sees the time already committed by the foreground. Pulse
          // above alone resolves the original baseline; never advance twice.
          if(dialogue.storyTime && input.worldContext?.temporal){
            input.worldContext.temporal.story=dialogue.storyTime;
            for(const actor of Object.values(input.worldContext.actorInputs))if(actor.worldContext?.temporal)actor.worldContext.temporal.story=dialogue.storyTime;
          }
          return {input,dialogue};
        });
        const options = {
          attemptId: job.attempt, signal: controller.signal, onTextDelta: () => {},
          ...(job.checkpoint ? { resume: job.checkpoint } : {}),
          onCall: async (record: Parameters<StoryStore['saveSettlementCall']>[1]) => { controller.signal.throwIfAborted(); await this.store.saveSettlementCall(job, record); },
          onCheckpoint: async (checkpoint: Parameters<StoryStore['saveSettlementCheckpoint']>[1]) => { controller.signal.throwIfAborted(); await this.store.saveSettlementCheckpoint(job, checkpoint); },
        };
        const results=await this.abortable(jobs.length>1 && runtime.settleWorldBatch
          ? runtime.settleWorldBatch(entries,options)
          : runtime.settleWorldTurn!(entries[0].input,entries[0].dialogue,options).then(result=>[result]),controller.signal);
        controller.signal.throwIfAborted();
        await this.store.saveSettlementBatchResults(jobs, results);
      }
      controller.signal.throwIfAborted();
      // Keep a completed result durable while foreground holds the revision;
      // release this lease so other worlds are not held behind that conversation.
      if (!await this.store.completeSettlementBatch(jobs)) for(const member of jobs) await this.store.yieldSettlement(member);
    } catch (error) {
      const code=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
      if(jobs.length>1 && ['BATCH_REVIEW_REQUIRED','UPDATER_OUTPUT_INVALID','ENTITY_NAME_CONFLICT','ENTITY_VERSION_CONFLICT'].includes(code)) {
        await this.store.splitSettlementBatch(jobs,code).catch(async()=>{for(const member of jobs)await this.store.failSettlement(member,error).catch(()=>{});});
      } else for(const member of jobs)await this.store.failSettlement(member, error).catch(() => {});
    } finally {
      ended = true; clearTimeout(heartbeat); clearTimeout(deadline);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, interrupted]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async shutdown(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer);
    this.controller?.abort(new ServiceError('SETTLEMENT_INTERRUPTED', '服务已停止，整理任务会在重启后恢复。'));
    await Promise.race([this.busy, new Promise(resolve => { const timer = setTimeout(resolve, 2000); timer.unref(); })]);
  }
}
