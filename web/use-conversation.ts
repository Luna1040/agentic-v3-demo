import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ConversationController } from './conversation-controller';
import { ApiError, type ApiClient } from './api';
import type { Message, SessionDetail, TurnEvent } from '../shared/contracts';
import { attemptForSend, editRegenerateAttempt, initialConversation, isPlayerVisibleAttempt, markAttemptStatus, mergeMessages, needsOpening, openingAttempt, operationAttempt, persistedOperationAttempt, recoverTurn, replaceRewriteTarget, type Attempt } from './conversation-state';
import { isRewriteChatType, operationTargetsFor, turnRequestBody } from './chat-operations.ts';
import { readPersistedTurn } from './turn-recovery';
import { worldBackgroundStatus } from './world-model';

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const description = (error: unknown) => error instanceof Error ? error.message : '连接暂时不可用，请稍后重试。';
// A rejected signal shape or rewrite target can never succeed by resending the same request;
// those show the server's explanation without an immediate retry button.
const REJECTED_OPERATION_CODES = new Set(['CHAT_TYPE_INVALID', 'CHAT_TYPE_CONFLICT', 'TARGET_INVALID', 'REWRITE_UNAVAILABLE', 'NO_CONTINUATION_TARGET', 'CLIENT_TURN_CONFLICT']);
export function useConversation(client: ApiClient, sessionId: string | null, onChanged: () => void) {
  const [stateRef] = useState(() => new ConversationController());
  const state = useSyncExternalStore(stateRef.subscribe, stateRef.snapshot, stateRef.snapshot);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const stopRequested = useRef(false);
  const openingStarted = useRef<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryingSettlement, setRetryingSettlement] = useState(false);
  const [settlementError, setSettlementError] = useState('');
  const update = stateRef.update;
  // Buttons follow the server verdict (`SessionDetail.rewriteTarget` / `Message.rewritable`); the
  // local state only ever disables them while a request is in flight (busy).
  const targets = operationTargetsFor(state.detail);

  useEffect(() => {
    const currentEpoch = ++epoch.current;
    controller.current?.abort();
    const load = new AbortController();
    controller.current = load;
    setLoadingMore(false);
    setRetryingSettlement(false);
    setSettlementError('');
    openingStarted.current = null;
    update(() => ({ ...initialConversation, loading: Boolean(sessionId) }));
    if (sessionId) void client.session(sessionId, { signal: load.signal }).then(async detail => {
      if (epoch.current !== currentEpoch || load.signal.aborted) return;
      // Opening and Continue/Regenerate share one recovery path: both are persisted turns whose
      // operation message is still pending after a reload or a dropped stream.
      const existing = persistedOperationAttempt(detail);
      update(current => ({ ...current, detail, loading: false, ...(existing ? { pending: existing, phase: 'recovering' } : {}) }));
      if (!existing?.turnId) return;
      if (existing.operation === 'opening') openingStarted.current = detail.session.id;
      const valid = () => epoch.current === currentEpoch && controller.current === load && !load.signal.aborted;
      try {
        const turn = await readPersistedTurn(client, existing.turnId, load.signal, value => { if (valid()) update(current => recoverTurn(current, value)); });
        if (!valid()) return;
        if (turn?.status === 'committed') {
          const fresh = await client.session(detail.session.id, { signal: load.signal });
          if (valid()) { update(current => ({ ...current, detail: fresh })); changed.current(); }
        } else if (stateRef.current.pending) {
          // A resumed plain chat cannot reuse the server's idempotency key (the browser only has
          // the persisted turn id), so it is shown without an automatic retry that would duplicate
          // the player's message. Operations keep their signal identity and stay retryable.
          const retryable = existing.operation === 'opening' || Boolean(existing.chatType);
          update(current => ({ ...current, pending: null, phase: null, failed: { ...existing, notRetryable: !retryable, message: existing.operation === 'opening' ? '开场结果仍未确认。没有重新生成；请稍后重新打开会话核对状态，或点击重试。' : existing.chatType ? '本次操作的结果仍未确认。旧内容保持不变；请稍后重新打开会话核对，或点击重试。' : '上一轮回复仍未确认。没有重复发送；请稍后重新打开会话核对，或手动重新发送。' } }));
        }
      } catch (error) {
        if (valid() && !isAbort(error)) update(current => current.pending ? { ...current, pending: null, phase: null, failed: { ...existing, notRetryable: existing.operation !== 'opening' && !existing.chatType, message: existing.operation === 'opening' ? '暂时无法读取上次开场结果，没有重新生成。请重新打开会话核对，或点击重试。' : existing.chatType ? '暂时无法读取上次操作结果，没有重新生成。请重新打开会话核对，或点击重试。' : '暂时无法读取上一轮结果，没有重复发送。请重新打开会话核对。' } } : { ...current, error: existing.operation === 'opening' ? '开场已完成，但最新世界档案暂时无法读取，请重新打开会话。' : '操作已完成，但最新世界档案暂时无法读取，请重新打开会话。' });
      }
    }).catch(error => {
      if (epoch.current === currentEpoch && !isAbort(error)) update(current => ({ ...current, loading: false, error: description(error) }));
    });
    return () => { ++epoch.current; load.abort(); controller.current?.abort(); };
  }, [client, sessionId, update]);
  useEffect(() => {
    const detail = state.detail;
    if (!state.loading && detail && !state.pending && !state.failed && needsOpening(detail) && openingStarted.current !== detail.session.id) {
      openingStarted.current = detail.session.id;
      void send('', openingAttempt(detail.session.id));
    }
  }, [state.loading, state.detail?.session.id]);

  const hasBackgroundWork = worldBackgroundStatus(state.detail?.world).polling;
  useEffect(() => {
    if (!sessionId || !hasBackgroundWork) return;
    const currentEpoch = epoch.current;
    const poll = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const fresh = await client.session(sessionId!, { signal: poll.signal });
        if (poll.signal.aborted || epoch.current !== currentEpoch) return;
        // Poll only the world projection: an in-flight stream and paginated history belong
        // to the foreground conversation and must never be replaced by this response.
        stateRef.refreshWorld(fresh.world);
        if (!worldBackgroundStatus(stateRef.current.detail?.world).polling) {
          changed.current();
          return;
        }
      } catch {
        // A temporary background refresh failure must not fail or clear the dialogue.
      }
      if (!poll.signal.aborted) timer = setTimeout(() => void read(), 2000);
    }
    timer = setTimeout(() => void read(), 2000);
    return () => { poll.abort(); clearTimeout(timer); };
  }, [client, sessionId, hasBackgroundWork, update, retryingSettlement]);

  async function retrySettlements() {
    const world = stateRef.current.detail?.world;
    if (!world || retryingSettlement) return;
    const currentEpoch = epoch.current;
    setRetryingSettlement(true); setSettlementError('');
    try {
      await client.retrySettlements(world.id);
      if (epoch.current !== currentEpoch) return;
      const detail = stateRef.current.detail;
      if (!detail) return;
      const fresh = (await client.session(detail.session.id)).world;
      if (epoch.current !== currentEpoch) return;
      update(current => !current.detail || fresh.revision < current.detail.world.revision ? current : {
        ...current, detail: { ...current.detail, world: fresh },
      });
    } catch (error) {
      if (epoch.current === currentEpoch) setSettlementError('整理重试未启动：' + description(error));
    } finally {
      if (epoch.current === currentEpoch) setRetryingSettlement(false);
    }
  }

  async function reload() {
    if (!sessionId || activeSessionId.current !== sessionId) return null;
    const currentEpoch = epoch.current;
    update(current => ({ ...current, loading: true, error: null }));
    try {
      const detail = await client.session(sessionId);
      if (currentEpoch === epoch.current) { update(current => ({ ...current, loading: false, detail })); return detail; }
    } catch (error) { if (currentEpoch === epoch.current) update(current => ({ ...current, loading: false, error: description(error) })); }
    return null;
  }
  async function loadMore() {
    const detail = stateRef.current.detail;
    if (!detail?.nextBefore || loadingMore) return;
    const currentEpoch = epoch.current;
    setLoadingMore(true);
    try {
      const page = await client.messages(detail.session.id, detail.nextBefore);
      if (currentEpoch === epoch.current) update(current => ({ ...current, error: null, detail: current.detail ? { ...current.detail, messages: mergeMessages(page.messages, current.detail.messages), hasMore: page.hasMore, nextBefore: page.nextBefore } : null }));
    } catch (error) { if (currentEpoch === epoch.current) update(current => ({ ...current, error: description(error) })); }
    finally { if (currentEpoch === epoch.current) setLoadingMore(false); }
  }

  /** One transport path for chat, opening and every operation signal (SSE stays unchanged). */
  async function start(attempt: Attempt, retry = false) {
    const detail = stateRef.current.detail;
    const opening = attempt.operation === 'opening';
    const chatType = attempt.chatType;
    const hasContent = Boolean(attempt.content.trim());
    if (!detail || stateRef.current.pending || stateRef.current.loading) return;
    // Continue/Regenerate carry no player text; EditRegenerate must carry the edited text.
    if (!opening && !hasContent && chatType !== 'continue' && chatType !== 'regenerate') return;
    if (isRewriteChatType(chatType) && !attempt.targetTurnId) return;
    const currentEpoch = epoch.current;
    controller.current?.abort();
    const stream = new AbortController();
    controller.current = stream;
    stopRequested.current = false;
    const valid = () => currentEpoch === epoch.current && controller.current === stream && !stream.signal.aborted;
    // Operations are status lines, not player dialogue: only Chat/EditRegenerate may add a bubble.
    const playerVisible = isPlayerVisibleAttempt(attempt);
    const optimistic: Message = { id: 'local-' + attempt.clientTurnId, turnId: null, sessionId: detail.session.id, role: 'user', content: attempt.content, createdAt: new Date().toISOString(), status: 'pending' };
    update(current => ({ ...current, error: null, pending: attempt, failed: null, draft: '', draftMessages: [], phase: 'planning', detail: { ...detail, messages: opening || retry ? markAttemptStatus(detail.messages, attempt, 'pending') : playerVisible ? [...detail.messages, optimistic] : detail.messages } }));
    try {
      const onEvent = (event: TurnEvent) => {
        if (!valid()) return;
        attempt.turnId = event.turnId;
        stateRef.accept(event);
        if (event.type === 'accepted' && stopRequested.current) void client.cancel(event.turnId).catch(() => {});
      };
      if (opening) await client.opening(detail.session.id, { clientTurnId: attempt.clientTurnId }, onEvent, { signal: stream.signal });
      else await client.stream(detail.session.id, turnRequestBody({ clientTurnId: attempt.clientTurnId, chatType: attempt.chatType, content: attempt.content, targetTurnId: attempt.targetTurnId }), onEvent, { signal: stream.signal });
    } catch (error) {
      if (!valid() || isAbort(error)) return;
      if (error instanceof ApiError && ['WORLD_CHANGED', 'RUNTIME_CHANGED'].includes(error.code)) {
        const latest = await client.session(detail.session.id, { signal: stream.signal }).catch(() => null);
        if (valid()) update(current => ({ ...current, ...(latest ? { detail: latest } : {}), pending: null, draft: '', draftMessages: [], phase: null, failed: { ...attempt, message: error.message, newTurnRequired: true } }));
        return;
      }
      if (error instanceof ApiError && REJECTED_OPERATION_CODES.has(error.code)) {
        // Wrong shape or an unavailable target: keep the old story untouched and never retry the
        // same rejected request. The unpersisted optimistic message is discarded; the buttons
        // themselves keep following the server verdict (no local ban list).
        update(current => ({
          ...current, pending: null, draft: '', draftMessages: [], phase: null,
          detail: current.detail ? { ...current.detail, messages: markAttemptStatus(current.detail.messages, attempt, 'failed').filter(message => message.id !== 'local-' + attempt.clientTurnId) } : null,
          failed: { ...attempt, message: error.message, notRetryable: true },
        }));
        // Adopt the server's authoritative verdict so an unavailable target stops offering 重写.
        void client.session(detail.session.id, { signal: stream.signal }).then((fresh: SessionDetail) => {
          if (!valid()) return;
          update(current => current.detail ? {
            ...current,
            detail: {
              ...current.detail,
              ...(fresh.world.revision >= current.detail.world.revision ? { world: fresh.world, session: fresh.session } : {}),
              messages: mergeMessages(current.detail.messages.filter(message => !message.id.startsWith('local-')), fresh.messages),
              rewriteTarget: fresh.rewriteTarget,
            },
          } : { ...current, detail: fresh });
        }).catch(() => {});
        return;
      }
      if (attempt.turnId) {
        update(current => ({ ...current, phase: 'recovering' }));
        try {
          await readPersistedTurn(client, attempt.turnId, stream.signal, turn => {
            if (valid()) stateRef.recover(turn);
          });
        } catch (recoveryError) {
          if (!valid() || isAbort(recoveryError)) return;
          update(current => ({ ...current, pending: null, draft: '', draftMessages: [], phase: null, detail: current.detail ? { ...current.detail, messages: markAttemptStatus(current.detail.messages, attempt, 'failed') } : null, failed: { ...attempt, message: '暂时无法确认结果。重试会核对同一轮消息，不会重复发送。' } }));
        }
      } else update(current => ({ ...current, pending: null, draft: '', draftMessages: [], phase: null, detail: current.detail ? { ...current.detail, messages: markAttemptStatus(current.detail.messages, attempt, 'failed') } : null, failed: { ...attempt, message: description(error) } }));
    } finally {
      if (valid()) {
        if (stateRef.current.pending) update(current => ({ ...current, pending: null, draft: '', draftMessages: [], phase: null, detail: current.detail ? { ...current.detail, messages: markAttemptStatus(current.detail.messages, attempt, 'failed') } : null, failed: { ...attempt, message: '本轮仍未确认完成。请稍后重试同一轮。' } }));
        if (!stateRef.current.failed) {
          // Recovery gives us messages; refresh the authoritative story snapshot too. The server's
          // fresh rewrite verdict must be adopted as well, otherwise consecutive Regenerate clicks
          // would keep pointing at the pre-commit target.
          const rewrite = isRewriteChatType(attempt.chatType);
          void client.session(detail.session.id, { signal: stream.signal }).then((fresh: SessionDetail) => {
            if (valid()) update(current => ({ ...current, detail: current.detail ? {
              ...current.detail,
              ...(fresh.world.revision >= current.detail.world.revision ? { world: fresh.world, session: fresh.session } : {}),
              // A committed rewrite is authoritative: its old version must disappear.
              ...(rewrite ? { messages: mergeMessages(replaceRewriteTarget(current.detail.messages, attempt.targetTurnId), fresh.messages), hasMore: fresh.hasMore, nextBefore: fresh.nextBefore } : {}),
              rewriteTarget: fresh.rewriteTarget,
            } : fresh }));
          }).catch(() => {});
        }
        changed.current();
      }
    }
  }
  async function send(content: string, retry?: Attempt) {
    await start(attemptForSend(content, retry), Boolean(retry));
  }
  /** Continue from the end of the latest saved reply; available in every scene mode. */
  async function continueTurn() {
    const currentTargets = operationTargetsFor(stateRef.current.detail);
    if (!currentTargets.canContinue) return;
    await start(operationAttempt('continue'));
  }
  /** Regenerate the latest committed rewritable turn on the server's authoritative input. */
  async function regenerateTurn() {
    const currentTargets = operationTargetsFor(stateRef.current.detail);
    if (!currentTargets.canRegenerate || !currentTargets.turnId) return;
    await start(operationAttempt('regenerate', currentTargets.turnId));
  }
  /** Replace the target turn with a reply to the edited player message. */
  async function editRegenerateTurn(targetTurnId: string, content: string) {
    const text = content.trim();
    if (!text || !targetTurnId) return;
    await start(editRegenerateAttempt(targetTurnId, text));
  }
  /** Retry keeps the original idempotency identity; a changed world/runtime mints a new signal. */
  async function retryFailed() {
    const failed = stateRef.current.failed;
    if (!failed || stateRef.current.pending) return;
    const currentTargets = operationTargetsFor(stateRef.current.detail);
    if (failed.chatType && failed.newTurnRequired) {
      if (failed.chatType === 'edit_regenerate' && failed.targetTurnId) await start(editRegenerateAttempt(failed.targetTurnId, failed.content));
      else if (failed.chatType === 'regenerate' && failed.targetTurnId) await start(operationAttempt('regenerate', failed.targetTurnId));
      else if (failed.chatType === 'continue') await start(operationAttempt('continue'));
      return;
    }
    // A recovered operation may not have persisted its target (only the turn id survived the
    // reload); the server verdict supplies it again without a local ban list. Its synthetic
    // idempotency key was never sent, so a fresh signal is the honest retry identity.
    if (!failed.targetTurnId && (failed.chatType === 'regenerate' || failed.chatType === 'edit_regenerate')) {
      const targetTurnId = currentTargets.canRegenerate ? currentTargets.turnId : null;
      if (!targetTurnId) return;
      if (failed.chatType === 'edit_regenerate') await start(editRegenerateAttempt(targetTurnId, failed.content));
      else await start(operationAttempt('regenerate', targetTurnId));
      return;
    }
    await start(attemptForSend(failed.content, failed), true);
  }
  async function stop() {
    const pending = stateRef.current.pending;
    if (!pending) return;
    stopRequested.current = true;
    if (pending.turnId) {
      const currentEpoch = epoch.current;
      const activeController = controller.current;
      try {
        const turn = await client.cancel(pending.turnId);
        if (epoch.current === currentEpoch && controller.current === activeController && turn?.id) update(current => recoverTurn(current, turn));
      } catch (error) { if (currentEpoch === epoch.current && controller.current === activeController) update(current => ({ ...current, error: '停止请求未送达：' + description(error) })); }
    }
  }
  return { state, targets, send, stop, reload, loadMore, loadingMore, retrySettlements, retryingSettlement, settlementError, continueTurn, regenerateTurn, editRegenerateTurn, retryFailed };
}
