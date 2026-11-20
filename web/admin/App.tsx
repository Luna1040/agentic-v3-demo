import { useEffect, useState } from 'react';
import type { Bootstrap, SessionDetail } from '../../shared/contracts';
import { createAdminApiClient, type AdminApiClient } from './api';
import { PromptStudio } from './PromptStudio';
import { TracePanel, TracePanelHandle } from './TracePanel';
import { TraceDrawer } from './TraceDrawer';
import { RuntimeAudit } from './RuntimeAudit';
import { inspectionTabs, WorldInspection, type InspectionTab } from './WorldInspector';
import { sessionPresentation } from '../session-presentation';
import { mergeMessages } from '../conversation-state';
import { clientScopeKey } from '../client-scope';

const defaultClient = createAdminApiClient();
export function AdminApp({ client = defaultClient }: { client?: AdminApiClient }) {
  return <ScopedAdminApp key={clientScopeKey(client, client.storageNamespace ?? '')} client={client} />;
}
function ScopedAdminApp({ client }: { client: AdminApiClient }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [view, setView] = useState<'inspect' | 'prompts' | 'audit'>('inspect');
  const [tab, setTab] = useState<InspectionTab>('overview');
  const [traceOpen, setTraceOpen] = useState(true);
  const [traceDrawer, setTraceDrawer] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setBootstrap(null); setError(''); setDetail(null);
    void client.bootstrap({ signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setBootstrap(value);
      setSessionId(current => value.sessions.some(session => session.id === current) ? current : value.sessions[0]?.id || '');
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '管理服务无法读取。'); });
    return () => controller.abort();
  }, [client, refresh]);
  useEffect(() => {
    if (!bootstrap?.status.developerTools || !sessionId) { setDetail(null); return; }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    setDetail(null); setError(''); setTraceDrawer(false); setLoadingMore(false);
    async function read() {
      try {
        const next = await client.session(sessionId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetail(current => current?.session.id === next.session.id ? { ...next, messages: mergeMessages(current.messages, next.messages), hasMore: current.hasMore, nextBefore: current.nextBefore } : next);
        timer = setTimeout(() => void read(), 2000);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '会话读取失败。'); }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, sessionId, bootstrap]);
  async function older() {
    if (!detail?.nextBefore || loadingMore) return;
    const requested = detail.session.id; setLoadingMore(true);
    try {
      const page = await client.messages(requested, detail.nextBefore);
      setDetail(current => current?.session.id === requested ? { ...current, messages: mergeMessages(page.messages, current.messages), hasMore: page.hasMore, nextBefore: page.nextBefore } : current);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '历史读取失败。'); }
    finally { setLoadingMore(false); }
  }
  return <div className="agentic-app av-admin-app"><main className="av-main">
    <header className="av-page-header"><div><span className="av-eyebrow">ADMINISTRATION</span><h1>续章管理台</h1><p>Prompt、模型调用和世界归档检查</p></div><button className="av-button" onClick={() => setRefresh(value => value + 1)}>刷新管理数据</button></header>
    {error && <p className="av-form-error" role="alert">{error}</p>}
    {!bootstrap ? !error && <p role="status">正在验证管理访问并读取数据…</p> : !bootstrap.status.developerTools ? <p role="alert">此入口需要管理权限。</p> : <>
      <div className="av-admin-toolbar"><label className="av-field">会话<select value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">选择会话</option>{bootstrap.sessions.map(session => <option key={session.id} value={session.id}>{sessionPresentation(session, bootstrap.worlds).option}</option>)}</select></label><nav className="av-world-tabs" aria-label="管理工具"><button onClick={() => setView('inspect')} aria-pressed={view === 'inspect'}>世界状态</button><button onClick={() => setView('prompts')} aria-pressed={view === 'prompts'}>Prompt 开发台</button><button onClick={() => setView('audit')} aria-pressed={view === 'audit'}>队列与入库</button><button disabled={!detail} onClick={() => setTraceDrawer(true)}>调用记录</button></nav><p>模型：{bootstrap.status.model || '未提供'} · Harness：{bootstrap.status.harness?.version || '未提供'}</p></div>
      {view === 'prompts' ? <PromptStudio key={client.storageNamespace} draftNamespace={client.storageNamespace} client={client} sessions={bootstrap.sessions} worlds={bootstrap.worlds} initialSessionId={sessionId || null} onBack={() => setView('inspect')} /> : !detail ? <p>选择会话后读取世界记录。</p> : view === 'audit' ? <div className="av-admin-content"><RuntimeAudit key={detail.world.id} worldId={detail.world.id} client={client} /></div> : <div className="av-admin-content"><nav className="av-world-tabs" aria-label="世界检查类别">{inspectionTabs.map(([key, label]) => <button key={key} onClick={() => setTab(key)} aria-pressed={tab === key}>{label}</button>)}</nav><WorldInspection world={detail.world} tab={tab} /></div>}
      {detail?.hasMore && <button className="av-button" disabled={loadingMore} onClick={() => void older()}>{loadingMore ? '读取中…' : '读取更早的对话与调用'}</button>}
    </>}
  </main>{bootstrap?.status.developerTools && detail && (traceOpen ? <TracePanel key={sessionId} client={client} messages={detail.messages} settlements={detail.world.settlements} director={detail.world.director} onCollapse={() => setTraceOpen(false)} onDrawer={() => setTraceDrawer(true)} /> : <TracePanelHandle onExpand={() => setTraceOpen(true)} />)}
    {bootstrap?.status.developerTools && detail && traceDrawer && <TraceDrawer key={sessionId} client={client} messages={detail.messages} settlements={detail.world.settlements} director={detail.world.director} onClose={() => setTraceDrawer(false)} />}
  </div>;
}
