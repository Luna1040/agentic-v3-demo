import { PlayerProfiles } from './PlayerProfiles';
import { Drawer } from './Drawer';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowLeft, ArrowUp, BookOpen, Check, ChevronRight, CircleHelp, Feather, FlaskConical, Flower2, History, LoaderCircle, LockKeyhole, Menu, MessageCircle, MoreHorizontal, Plus, RotateCcw, Search, Settings2, Sparkles, Square, Users } from 'lucide-react';
import type { Bootstrap, Character, WorldView } from '../shared/contracts';
import { ApiError, createApiClient, type ApiClient, type CreateSessionInput } from './api';
import { shouldSendOnEnter } from './conversation-state';
import { useConversation } from './use-conversation';
import { Avatar } from './Avatar';
import { MessageBubble } from './ChatMessage';
import { CharacterLibrary } from './CharacterLibrary';
import { recentCharacters } from './catalog';
import { SceneEditor, SceneStrip } from './ScenePanel';
import { TraceDrawer } from './TraceDrawer';
import { TracePanel, TracePanelHandle } from './TracePanel';
import { PromptStudio } from './PromptStudio';
import { MemoryDrawer } from './MemoryDrawer';
import { SceneBuilder, type SceneSeed } from './SceneBuilder';
import { WorldArchive } from './WorldArchive';
import { messageCharacter, worldCharacters, worldRecordCounts, worldBackgroundStatus } from './world-model';
import { filterSessions, lastSessionKey, resolveInitialSession, sessionPresentation } from './session-presentation';
import './styles.css';

const defaultClient = createApiClient({ storageNamespace: 'agentic-v3:draft:' });
function IconButton({ label, children, onClick, className = '' }: { label: string; children: ReactNode; onClick: () => void; className?: string }) {
  return <button type="button" className={'av-icon-button ' + className} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}
export interface AppProps { client?: ApiClient; initialSessionId?: string; onSessionChange?: (sessionId: string) => void; draftKeyPrefix?: string }
export function App({ client = defaultClient, initialSessionId, onSessionChange, draftKeyPrefix: hostDraftKeyPrefix }: AppProps) {
  const promptNamespace = hostDraftKeyPrefix ?? client.storageNamespace;
  const draftKeyPrefix = promptNamespace ?? 'agentic-v3:draft:';
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId || null);
  const [view, setView] = useState<'chat' | 'characters' | 'world' | 'settings' | 'prompts'>('chat');
  const [drawer, setDrawer] = useState<'story' | 'scene' | 'trace' | 'player' | null>(null);
  // The Agent call panel is part of the chat layout, not a drawer; its collapsed choice survives reloads.
  const [traceOpen, setTraceOpen] = useState(() => { try { return localStorage.getItem('agentic-v3:trace-panel:' + draftKeyPrefix) !== 'closed'; } catch { return true; } });
  const [mobileLibrary, setMobileLibrary] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState<string | null>(null);
  const [sceneBuilder, setSceneBuilder] = useState<{ world?: WorldView; seed?: Character; defaults?: SceneSeed } | null>(null);
  const [notice, setNotice] = useState('');
  const [fontSize, setFontSize] = useState(15);
  const [content, setContent] = useState('');
  const drafts = useRef(new Map<string, string>());
  const history = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const [showScroll, setShowScroll] = useState(false);
  const mounted = useRef(true);
  const refresh = useCallback(() => {
    void client.bootstrap().then(result => { if (mounted.current) { setBootstrap(result); setBootError(''); } }).catch(error => { if (mounted.current) setBootError(error.message || '无法连接故事服务。'); });
  }, [client]);
  const { state, send, stop, reload, loadMore, loadingMore, retrySettlements, retryingSettlement, settlementError } = useConversation(client, selectedId, refresh);
  const activeWorld = state.detail?.world;
  const { failedTurns, pendingTurns, directorPending } = worldBackgroundStatus(activeWorld);
  const unresolvedCommands = activeWorld?.settlementBacklog?.unresolvedCommands ?? 0;
  const recordCounts = worldRecordCounts(activeWorld);
  const characters = bootstrap?.characters || [];
  const cast = worldCharacters(activeWorld, characters, state.detail?.session.characterId);
  const activeCharacter = cast.find(character => character.id === state.detail?.session.characterId) || characters.find(character => character.id === state.detail?.session.characterId);
  const activeWorldId = activeWorld?.id;
  const pending = Boolean(state.pending);
  const characterPresent = !activeWorld?.scene || !activeCharacter || activeWorld.scene.presentCharacterIds.includes(activeCharacter.id);

  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, [refresh]);
  useEffect(() => {
    if (selectedId || !bootstrap) return;
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(lastSessionKey(draftKeyPrefix)); } catch { /* Storage can be disabled by the host. */ }
    setSelectedId(resolveInitialSession(bootstrap.sessions, initialSessionId, remembered));
  }, [bootstrap, selectedId, initialSessionId, draftKeyPrefix]);
  useEffect(() => {
    // A click or a stale response is not a successful open; only persist the loaded selection.
    if (!selectedId || state.loading || state.detail?.session.id !== selectedId) return;
    try { localStorage.setItem(lastSessionKey(draftKeyPrefix), selectedId); } catch { /* Navigation must work without browser storage. */ }
  }, [selectedId, state.loading, state.detail?.session.id, draftKeyPrefix]);
  useEffect(() => {
    if (!selectedId) { setContent(''); return; }
    let saved = drafts.current.get(selectedId);
    if (saved === undefined) { try { saved = localStorage.getItem(draftKeyPrefix + selectedId) || ''; } catch { saved = ''; } }
    setContent(saved); atBottom.current = true; setShowScroll(false);
  }, [selectedId, draftKeyPrefix]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = Math.min(textarea.current.scrollHeight, 160) + 'px';
  }, [content, view]);
  useEffect(() => {
    if (atBottom.current && history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [state.detail?.messages, state.draft, state.loading, view]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    function close(event: KeyboardEvent) { if (event.key === 'Escape') { setDrawer(null); setMobileLibrary(false); } }
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  function toggleTracePanel(open: boolean) {
    setTraceOpen(open);
    try { localStorage.setItem('agentic-v3:trace-panel:' + draftKeyPrefix, open ? 'open' : 'closed'); } catch { /* A blocked browser store must not hide the panel state for this session. */ }
  }
  function updateDraft(text: string) {
    setContent(text);
    if (!selectedId) return;
    drafts.current.set(selectedId, text);
    try { if (text) localStorage.setItem(draftKeyPrefix + selectedId, text); else localStorage.removeItem(draftKeyPrefix + selectedId); } catch { /* A blocked browser store must not prevent conversation. */ }
  }
  function openSession(id: string) { setSelectedId(id); setView('chat'); setMobileLibrary(false); setDrawer(null); onSessionChange?.(id); }
  async function refreshPlayerWorld() {
    const latest = await reload(); refresh();
    if (!latest) throw new Error('设定操作已提交，但最新世界暂时无法读取。请重新打开会话核对。');
  }
  async function chooseCharacter(character: Character, fresh = false) {
    if (creating) return;
    const matches = bootstrap?.sessions.filter(session => session.characterId === character.id) || [];
    const sameWorldSession = !fresh && (matches.find(session => session.worldId === activeWorldId) || matches[0]);
    if (sameWorldSession) { openSession(sameWorldSession.id); return; }
    setDrawer(null);
    setSceneBuilder(!fresh && cast.some(item => item.id === character.id) ? { world: activeWorld, defaults: { characterId: character.id } } : { seed: character });
  }
  async function createScene(input: CreateSessionInput) {
    if (creating) return;
    setCreating(input.characterId);
    try {
      const result = await client.createSession(input);
      if (!mounted.current) return;
      setSceneBuilder(null); openSession(result.session.id); refresh();
    } catch (failure) {
      if (input.worldId && failure instanceof ApiError && ['WORLD_CHANGED', 'REVISION_CONFLICT'].includes(failure.code)) {
        const latest = await client.world(input.worldId).catch(() => null);
        if (latest && mounted.current) setSceneBuilder(current => current?.world?.id === latest.id ? { ...current, world: latest } : current);
        await reload(); refresh();
        throw new Error(latest ? '世界已有新的变化，已读取最新档案。请核对出场角色和地点，再创建场景。' : '世界已有新的变化，最新档案暂时无法读取。请关闭后重新打开场景。');
      }
      if (!(failure instanceof ApiError)) {
        refresh();
        throw new Error('创建结果暂未确认，已请求刷新会话列表。请先关闭面板，查看是否已有新场景，再决定是否重试；不会自动重复创建。');
      }
      throw failure;
    }
    finally { setCreating(null); }
  }
  function startNextConversation() {
    if (!activeCharacter || !activeWorldId || creating || pending) return;
    setDrawer(null); setSceneBuilder({ world: activeWorld, defaults: { ...activeWorld?.scene, characterId: activeCharacter.id } });
  }
  function submit() {
    if (!content.trim() || pending || !characterPresent || !state.detail || state.loading) return;
    const text = content.trim(); updateDraft(''); atBottom.current = true; void send(text);
  }
  async function older() {
    const element = history.current;
    const previousHeight = element?.scrollHeight || 0;
    atBottom.current = false;
    await loadMore();
    requestAnimationFrame(() => { if (element && history.current === element) element.scrollTop += element.scrollHeight - previousHeight; });
  }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); setNotice('已复制消息'); } catch { setNotice('浏览器未允许复制，可直接选择消息文本。'); } }
  const sessions = useMemo(() => filterSessions(bootstrap?.sessions || [], bootstrap?.characters || [], bootstrap?.worlds || [], search), [bootstrap, search]);
  const allKnownCharacters = [...new Map([...characters, ...(bootstrap?.worlds || []).flatMap(world => worldCharacters(world, characters)), ...cast].map(character => [character.id, character])).values()];
  const recent = recentCharacters(allKnownCharacters, bootstrap?.sessions || [], activeCharacter?.id);
  const isDemo = bootstrap?.status.provider === 'demo';

  return <div className="agentic-app" style={{ '--av-reading-size': fontSize + 'px' } as CSSProperties}>
    <aside className="av-rail" aria-label="主导航">
      <button className="av-brand-mark" onClick={() => setView('chat')} title="续章"><Feather size={29} strokeWidth={1.35} /></button>
      <nav>
        <button className={view === 'chat' ? 'is-active' : ''} onClick={() => setView('chat')}><MessageCircle /><span>对话</span></button>
        <button className={view === 'world' ? 'is-active' : ''} onClick={() => { setDrawer(null); setView('world'); }}><BookOpen /><span>世界</span></button><button className={view === 'characters' ? 'is-active' : ''} onClick={() => { setView('characters'); }}><Users /><span>角色</span></button>
        {bootstrap?.status.developerTools && <button className={view === 'prompts' ? 'is-active' : ''} onClick={() => { setDrawer(null); setView('prompts'); }} title="Agent Prompt 开发台"><FlaskConical /><span>开发</span></button>}
      </nav>
      <div className="av-rail-bottom"><button className={view === 'settings' ? 'is-active' : ''} onClick={() => { setDrawer(null); setView('settings'); }} aria-label="偏好与说明"><Settings2 /></button><span className="av-rail-rule" /><span className="av-personal-mark">V3</span></div>
    </aside>

    {mobileLibrary && <button className="av-library-backdrop" aria-label="关闭会话列表" onClick={() => setMobileLibrary(false)} />}
    <aside className={'av-library ' + (mobileLibrary ? 'is-open' : '')} aria-label="角色与会话">
      <div className="av-library-brand"><div><h1>续章 <span>Next chapter</span></h1><p>让故事，继续发生。</p></div><span className="av-brand-star">✧</span></div>
      <button className="av-new-story" onClick={() => { setView('characters'); setMobileLibrary(false); }}><Plus size={16} /><span>开启一段新故事</span><ChevronRight size={15} /></button>
      <label className="av-search"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="寻找一段对话" aria-label="搜索会话" /></label>
      <div className="av-section-label"><span>最近交谈</span><button className="av-all-characters" onClick={() => { setView('characters'); setMobileLibrary(false); }}>根角色卡 {characters.filter(character => character.source !== 'sample').length}<ChevronRight size={11} /></button></div>
      <div className="av-character-list">{recent.map(character => <button key={character.id} disabled={Boolean(creating)} className={'av-character-row ' + (activeCharacter?.id === character.id && view === 'chat' ? 'is-active' : '')} onClick={() => void chooseCharacter(character)}><Avatar character={character} /><span><strong>{character.name}</strong><small>{character.subtitle || character.language || '继续你们的故事'}</small></span>{creating === character.id ? <LoaderCircle size={13} className="av-spin" /> : activeCharacter?.id === character.id && <i className="av-tiny-dot" />}</button>)}</div>
      <div className="av-section-label av-recent-label"><span>最近的对话</span><History size={12} /></div>
      <div className="av-sessions">{sessions.map(session => { const label = sessionPresentation(session, bootstrap?.worlds); return <button key={session.id} title={label.option} className={selectedId === session.id ? 'is-active' : ''} onClick={() => openSession(session.id)}><MessageCircle size={13} /><span className="av-session-caption"><strong>{session.title}</strong><small>{label.worldLabel}</small><small>{label.stamp}</small></span><ChevronRight size={11} /></button>; })}{!sessions.length && <p className="av-list-empty">{search ? '没有找到这段对话' : '你的第一章，从这里开始。'}</p>}</div>
      <div className="av-library-footer"><span className={'av-connection-dot ' + (bootError ? 'is-error' : '')} /><div><strong>{bootError ? '连接暂时不可用' : '每一章，都有迹可循'}</strong><span>Agentic V3 · 持久故事 Demo</span></div><Flower2 size={19} /></div>
    </aside>

    <main className="av-main">
      {!bootstrap ? <div className="av-center-state">{bootError ? <><CircleHelp /><h2>故事服务暂未连接</h2><p>{bootError}</p><button className="av-button" onClick={refresh}><RotateCcw size={14} />重新连接</button></> : <><LoaderCircle className="av-spin" /><p>正在翻开故事…</p></>}</div> : view === 'characters' ? <CharacterLibrary characters={characters.filter(character => character.source !== 'generated')} fresh={true} hasWorld={false} creating={creating} onChoose={character => void chooseCharacter(character, true)} onBack={() => setView('chat')} /> : view === 'world' ? <WorldArchive world={activeWorld} templates={characters} focusId={activeCharacter?.id} client={client} busy={pending || state.loading} onBack={() => setView('chat')} onScene={(world, defaults) => setSceneBuilder({ world, defaults })} onSession={openSession} onUpdated={async () => { await reload(); refresh(); }} /> : view === 'prompts' && bootstrap.status.developerTools ? <PromptStudio key={promptNamespace} draftNamespace={promptNamespace} client={client} sessions={bootstrap.sessions} worlds={bootstrap.worlds} initialSessionId={selectedId} onBack={() => setView('chat')} /> : view === 'settings' ? <>
        <header className="av-page-header"><div><span className="av-eyebrow">MAKE YOURSELF COMFORTABLE</span><h2>给对话，留一点自己的空间。</h2><p>只保留真正需要的偏好。</p></div><IconButton label="返回聊天" onClick={() => setView('chat')}><ArrowLeft size={19} /></IconButton></header>
        <div className="av-settings"><PlayerProfiles client={client} world={state.detail?.session.id === selectedId ? activeWorld : undefined} busy={pending||state.loading||state.detail?.session.id !== selectedId} onApplied={refreshPlayerWorld} /><section><span className="av-setting-icon"><Settings2 size={20} /></span><h3>阅读偏好</h3><p>调整消息文字的大小，让长一点的故事也轻松好读。</p><label className="av-setting-row"><span>文字大小 <small>{fontSize}px</small></span><input type="range" min="13" max="19" value={fontSize} onChange={event => setFontSize(Number(event.target.value))} /></label><div className="av-reading-preview" style={{ fontSize }}>风翻过书页，而我们的故事，才刚刚开始。</div></section><section><span className="av-setting-icon"><Sparkles size={20} /></span><h3>关于这个 Demo</h3><p>一个围绕角色、对话与持续记忆的轻量实验。</p><dl><div><dt>当前运行</dt><dd>{isDemo ? '演示模式 · 固定回复生成器' : '真实模型'}</dd></div><div><dt>模型</dt><dd>{bootstrap.status.model}</dd></div><div><dt>Harness</dt><dd>{bootstrap.status.harness.loaded ? bootstrap.status.harness.version : '未加载'}</dd></div><div><dt>消息和故事</dt><dd>服务端持久保存</dd></div></dl><p className="av-settings-note">{isDemo ? '演示模式不调用真实语言模型。你看到的角色回复用于验证交互与持久化流程。' : '回复由当前配置的模型生成；故事变化以服务端确认的状态为准。'}</p></section></div>
      </> : <>
        <header className="av-chat-header"><IconButton label="打开会话列表" className="av-mobile-menu" onClick={() => setMobileLibrary(true)}><Menu size={19} /></IconButton><button className="av-character-heading" onClick={() => setView('world')}><Avatar character={activeCharacter} /><span><strong>{activeCharacter?.name || '续写你的故事'}</strong><small>{activeCharacter?.subtitle || '让每一次相遇，都有下一章'}</small></span><ChevronRight size={13} /></button><div className="av-chat-actions"><button className="av-button av-player-switch" onClick={()=>setDrawer('player')}><Users size={14}/>{activeWorld?.playerProfile?.name||'玩家身份'}</button><span className="av-runtime-badge"><span />{isDemo ? '演示模式' : '实时模型'}</span><IconButton label="开发调用记录" onClick={() => setDrawer('trace')}><Activity size={18} /></IconButton><IconButton label="查看故事状态" onClick={() => setDrawer('story')}><BookOpen size={19} /></IconButton><IconButton label="阅读设置" onClick={() => { setDrawer(null); setView('settings'); }}><MoreHorizontal size={20} /></IconButton></div></header>
        <div className="av-context-strip"><button onClick={() => setDrawer('story')}><BookOpen size={13} /><strong>{activeWorld?.title || '故事尚未开始'}</strong><ChevronRight size={11} /></button><span className="av-context-divider" /><span title="原话记录仅统计启用且有玩家证据的记忆；互动统计当前档案中的已提交开场与对话，不包含角色声称或离线活动。">{activeWorld ? `${recordCounts.quotations} 条原话记录 · ${recordCounts.interactions} 段已保存互动` : '等待第一段对话'}</span><span className="av-context-end">{pending ? state.phase === 'planning' ? '正在准备回应…' : state.phase === 'settling' ? '正在记下这一章…' : state.phase === 'recovering' ? '正在恢复连接…' : '故事正在继续…' : '完整互动可在世界档案查看'}</span></div>
        <SceneStrip world={activeWorld} characters={cast} busy={pending || state.loading} onEdit={() => setDrawer('scene')} />
        {!characterPresent && <div className="av-presence-notice"><span>{activeCharacter?.name}当前不在场，加入场景后即可继续交谈。</span><button onClick={() => setDrawer('scene')}>编辑场景</button></div>}
        {state.loading ? <div className="av-center-state"><LoaderCircle className="av-spin" /><p>正在找回这一章…</p></div> : !state.detail ? <div className="av-center-state"><Feather size={36} /><h2>{state.error ? '这一章暂时无法打开' : '你好，故事的另一位主角。'}</h2><p>{state.error || '选一位角色，让第一次相遇发生。'}</p><button className="av-button av-button-primary" onClick={state.error ? () => void reload() : () => { setView('characters'); }}>{state.error ? '重新加载' : '开始新的故事'}<ArrowUp size={15} /></button></div> : <>
          <div className="av-messages" ref={history} onScroll={() => { const el = history.current; if (el) { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setShowScroll(!atBottom.current); } }}>
            <div className="av-day-line"><span>故事仍在继续</span></div>
            {state.detail.hasMore && <button className="av-load-more" disabled={loadingMore} onClick={() => void older()}>{loadingMore ? <LoaderCircle size={12} className="av-spin" /> : <History size={12} />}更早的对话</button>}
            {state.detail.messages.map(message => <MessageBubble key={message.id} message={message} currentPlayerName={activeWorld?.playerProfile?.name ?? null} character={messageCharacter(message, cast, activeCharacter)} onCopy={text => void copy(text)} />)}
            {state.draftMessages.map(message => <MessageBubble key={message.id} message={message} currentPlayerName={activeWorld?.playerProfile?.name ?? null} character={messageCharacter(message, cast, activeCharacter)} streaming onCopy={() => {}} />)}
            {pending && !state.draft && <div className="av-thinking" role="status"><Avatar character={activeCharacter} /><span><i /><i /><i /></span><small>{state.phase === 'planning' ? state.pending?.operation === 'opening' ? '开场导演正在编排这一幕' : '正在准备回应' : state.phase === 'settling' ? '正在保存故事变化' : state.phase === 'recovering' ? '正在确认这轮结果' : activeCharacter?.name + ' 正在回应'}</small></div>}
          </div>
          {showScroll && <button className="av-jump-bottom" onClick={() => { if (history.current) history.current.scrollTo({ top: history.current.scrollHeight, behavior: 'smooth' }); atBottom.current = true; setShowScroll(false); }}><ArrowDown size={14} />回到最新</button>}
          {state.error && <div className="av-inline-error" role="alert">{state.error}</div>}
          {(failedTurns > 0 || pendingTurns > 0 || directorPending || unresolvedCommands > 0) && <div className="av-settlement-notice" role="status"><span>{failedTurns > 0 ? `此前已完成的回复和原始互动已保存，${failedTurns} 轮世界整理待重试。可以继续聊。` : pendingTurns > 0 ? `此前已完成的回复已保存，后台正在整理 ${pendingTurns} 轮世界记录。可以继续聊。` : directorPending ? '此前已完成的回复已保存，后台正在准备后续剧情建议；与本轮回复状态无关。' : '回复已保存。'}{unresolvedCommands>0&&<small>仍有 {unresolvedCommands} 条未应用候选，原文已保留，可在世界状态中核查。候选不当作已发生事实。</small>}{settlementError && <small>{settlementError}</small>}</span>{failedTurns > 0 && <button type="button" disabled={retryingSettlement} onClick={() => void retrySettlements()}><RotateCcw size={12} className={retryingSettlement ? 'av-spin' : ''} />{retryingSettlement ? '正在重试' : '重试整理'}</button>}</div>}
          {state.failed && <div className={'av-turn-notice ' + (state.failed.cancelled ? 'is-cancelled' : '')} role="status"><span>{state.failed.cancelled ? '已停止。本轮没有提交新的故事变化。' : state.failed.message}</span><button disabled={pending} onClick={() => state.failed!.operation === 'opening' && state.failed!.newTurnRequired ? startNextConversation() : void send(state.failed!.content, state.failed!.operation === 'opening' ? state.failed! : state.failed!.newTurnRequired ? undefined : state.failed!)}><RotateCcw size={12} />{state.failed.operation === 'opening' ? state.failed.newTurnRequired ? '重新搭建场景' : '重试开场' : state.failed.newTurnRequired ? '作为新消息发送' : '重试这一轮'}</button></div>}
          <div className="av-composer-wrap">{activeWorld?.scene?.mode === 'observe' && <div className="av-observe-control"><span>旁观模式 · 每次只继续一幕，你也可以随时输入加入。</span><button className="av-button" disabled={pending || state.loading || !characterPresent} onClick={() => void send('继续演出。')}><Sparkles size={13} />继续演出</button></div>}<div className="av-composer-top"><span><Feather size={13} />写下故事的下一句</span><span>{content ? '草稿已保留' : '留一点空间，给想象'}</span></div><form className="av-composer" onSubmit={event => { event.preventDefault(); submit(); }}><textarea ref={textarea} value={content} onChange={event => updateDraft(event.target.value)} maxLength={8000} placeholder={`想对${activeCharacter?.name || '角色'}说些什么？`} aria-label="输入消息" disabled={pending} onKeyDown={event => { if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); submit(); } }} /><div className="av-composer-footer"><span><LockKeyhole size={12} />{pending ? state.phase === 'settling' ? '正在保存本轮结果' : '等一等，回应就快到了' : '你的故事，独立保存'}</span><div><small>Enter 发送 <b>·</b> Shift + Enter 换行</small>{pending ? <button className="av-send av-stop" type="button" aria-label="停止生成" title="停止生成" onClick={() => void stop()}><Square size={15} fill="currentColor" /></button> : <button className="av-send" type="submit" disabled={!content.trim() || !characterPresent} aria-label="发送消息" title="发送消息"><ArrowUp size={20} /></button>}</div></div></form><div className="av-composer-caption"><span>{isDemo ? '演示模式：回复由固定生成器提供' : 'AI 生成的内容可能存在偏差'}</span><span>CONTINUE YOUR STORY</span></div></div>
        </>}
      </>}
    </main>
    {view === 'chat' && state.detail && (traceOpen
      ? <TracePanel key={selectedId} client={client} messages={state.detail.messages} pendingTurnId={state.pending?.turnId} settlements={activeWorld?.settlements} director={activeWorld?.director} onCollapse={() => toggleTracePanel(false)} onDrawer={() => setDrawer('trace')} />
      : <TracePanelHandle onExpand={() => toggleTracePanel(true)} />)}
    {drawer === 'story' && <MemoryDrawer key={activeWorld?.id} world={activeWorld} character={activeCharacter} creating={Boolean(creating)} busy={pending || state.loading} client={client} developerTools={bootstrap?.status.developerTools} onWorld={() => refresh()} onRefresh={reload} onContinue={() => void startNextConversation()} onClose={() => setDrawer(null)} onArchive={() => { setDrawer(null); setView('world'); }} onTrace={() => setDrawer('trace')} />}
    {drawer === 'scene' && activeWorld && <SceneEditor key={activeWorld.id} world={activeWorld} characters={cast} sessionId={state.detail!.session.id} activeCharacterId={activeCharacter?.id} busy={pending || state.loading} client={client} onSaved={async () => { const latest = await reload(); refresh(); return latest?.world || null; }} onClose={() => setDrawer(null)} />}
    {drawer === 'trace' && <TraceDrawer key={selectedId} client={client} messages={state.detail?.messages || []} pendingTurnId={state.pending?.turnId} settlements={activeWorld?.settlements} director={activeWorld?.director} onClose={() => setDrawer(null)} />}
    {drawer==='player'&&<Drawer title="玩家身份" eyebrow="YOUR PERSONA" onClose={()=>setDrawer(null)}><PlayerProfiles client={client} world={state.detail?.session.id === selectedId ? activeWorld : undefined} busy={pending||state.loading||state.detail?.session.id !== selectedId} onApplied={refreshPlayerWorld} /></Drawer>}
    {sceneBuilder && <SceneBuilder client={client} world={sceneBuilder.world} seedCharacter={sceneBuilder.seed} characters={worldCharacters(sceneBuilder.world, characters, sceneBuilder.defaults?.characterId || activeCharacter?.id)} defaults={sceneBuilder.defaults} busy={Boolean(creating)} onCreate={createScene} onClose={() => setSceneBuilder(null)} />}
    {notice && <div className="av-toast" role="status"><Check size={14} />{notice}</div>}
  </div>;
}
