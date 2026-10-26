import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ConversationController } from './conversation-controller';
import { ApiError, type ApiClient } from './api';
import type { SessionDetail, TurnEvent } from '../shared/contracts';
import { initialConversation, markAttemptStatus, mergeMessages, needsOpening, openingAttempt, persistedOpening, recoverTurn, type Attempt } from './conversation-state';
import { readPersistedTurn } from './turn-recovery';
import { worldBackgroundStatus } from './world-model';

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const description = (error: unknown) => error instanceof Error ? error.message : '连接暂时不可用，请稍后重试。';
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
      const existing = persistedOpening(detail);
      update(current => ({ ...current, detail, loading: false, ...(existing ? { pending: existing, phase: 'recovering' } : {}) }));
      if (!existing?.turnId) return;
      openingStarted.current = detail.session.id;
      const valid = () => epoch.current === currentEpoch && controller.current === load && !load.signal.aborted;
      try {
        const turn = await readPersistedTurn(client, existing.turnId, load.signal, value => { if (valid()) update(current => recoverTurn(current, value)); });
        if (!valid()) return;
        if (turn?.status === 'committed') {
          const fresh = await client.session(detail.session.id, { signal: load.signal });
          if (valid()) { update(current => ({ ...current, detail: fresh })); changed.current(); }
        } else if (stateRef.current.pending) {
          update(current => ({ ...current, pending: null, phase: null, failed: { ...existing, message: '开场结果仍未确认。没有重新生成；请稍后重新打开会话核对状态，或点击重试。' } }));
        }
      } catch (error) {
        if (valid() && !isAbort(error)) update(current => current.pending ? { ...current, pending: null, phase: null, failed: { ...existing, message: '暂时无法读取上次开场结果，没有重新生成。请重新打开会话核对，或点击重试。' } } : { ...current, error: '开场已完成，但最新世界档案暂时无法读取，请重新打开会话。' });
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

  async function send(content: string, retry?: Attempt) {
    const detail = stateRef.current.detail;
    const opening = retry?.operation === 'opening';
    if (!detail || (!content.trim() && !opening) || stateRef.current.pending) return;
    const currentEpoch = epoch.current;
    const attempt: Attempt = retry ? { ...retry } : { clientTurnId: crypto.randomUUID(), content: content.trim(), turnId: null };
    controller.current?.abort();
    const stream = new AbortController();
    controller.current = stream;
    stopRequested.current = false;
    const valid = () => currentEpoch === epoch.current && controller.current === stream && !stream.signal.aborted;
    update(current => ({ ...current, error: null, pending: attempt, failed: null, draft: '', draftMessages: [], phase: 'planning', detail: { ...detail, messages: opening || retry ? markAttemptStatus(detail.messages, attempt, 'pending') : [...detail.messages, { id: 'local-' + attempt.clientTurnId, turnId: null, sessionId: detail.session.id, role: 'user', content: attempt.content, createdAt: new Date().toISOString(), status: 'pending' }] } }));
    try {
      const onEvent = (event: TurnEvent) => {
        if (!valid()) return;
        attempt.turnId = event.turnId;
        stateRef.accept(event);
        if (event.type === 'accepted' && stopRequested.current) void client.cancel(event.turnId).catch(() => {});
      };
      if (opening) await client.opening(detail.session.id, { clientTurnId: attempt.clientTurnId }, onEvent, { signal: stream.signal });
      else await client.stream(detail.session.id, { clientTurnId: attempt.clientTurnId, content: attempt.content }, onEvent, { signal: stream.signal });
    } catch (error) {
      if (!valid() || isAbort(error)) return;
      if (error instanceof ApiError && ['WORLD_CHANGED', 'RUNTIME_CHANGED'].includes(error.code)) {
        const latest = await client.session(detail.session.id, { signal: stream.signal }).catch(() => null);
        if (valid()) update(current => ({ ...current, ...(latest ? { detail: latest } : {}), pending: null, draft: '', draftMessages: [], phase: null, failed: { ...attempt, message: error.message, newTurnRequired: true } }));
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
          // Recovery gives us messages; refresh the authoritative story snapshot too.
          void client.session(detail.session.id, { signal: stream.signal }).then((fresh: SessionDetail) => {
            if (valid()) update(current => ({ ...current, detail: current.detail ? { ...current.detail, ...(fresh.world.revision >= current.detail.world.revision ? { world: fresh.world, session: fresh.session } : {}) } : fresh }));
          }).catch(() => {});
        }
        changed.current();
      }
    }
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
  return { state, send, stop, reload, loadMore, loadingMore, retrySettlements, retryingSettlement, settlementError };
}
