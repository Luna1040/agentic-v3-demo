import { useEffect, useRef, useState } from 'react';
import { BookOpen, CircleHelp, Flower2, LoaderCircle, LockKeyhole, Plus, RotateCcw, Sparkles, Users } from 'lucide-react';
import type { Character, StoryEvent, WorldView } from '../shared/contracts';
import { ApiError, type ApiClient } from './api';
import { Drawer } from './Drawer';
import { memoryAction, memoryLabel } from './memory-state';
import { recordedTimeLabel, storyTimeLabel } from './time-model';
import { inspectionTabs, WorldInspection, type InspectionTab } from './WorldInspector';

export function MemoryEntry({ event, character, disabled, saving, onChange }: { event: StoryEvent; character?: Character; disabled: boolean; saving: boolean; onChange: (event: StoryEvent) => void }) {
  const action = memoryAction(event);
  const evidenceTurn = event.evidence?.source === 'user' ? event.evidence.turnId : null;
  const source = evidenceTurn || event.sourceTurnId;
  return <article className={'av-memory-record is-' + (event.status || 'unverified')} data-memory-id={event.id}>
    <span className="av-timeline-dot" />
    <div className="av-story-event-meta"><span>{memoryLabel(event)}</span><time dateTime={event.createdAt}>{`记录于 ${recordedTimeLabel(event.createdAt)}`}</time></div>
    <small>原话说出时：{storyTimeLabel(event.storyTime)}</small>
    <p>{event.text}</p>
    <small>{event.visibility === 'private' ? <><LockKeyhole size={10} />角色私有 · {event.characterId === character?.id ? character.name : '当事角色'}</> : <><Users size={10} />公开范围</>}</small>
    {source && <div className="av-memory-source" title={source}>{evidenceTurn ? '玩家原话出处' : '旧记录来源'} · 轮次 #{source.slice(-8)}</div>}
    <div className="av-memory-controls">{action ? <button className="av-button" disabled={disabled || saving} onClick={() => onChange(event)}>{saving ? <LoaderCircle size={12} className="av-spin" /> : action === 'active' ? <RotateCcw size={12} /> : null}{action === 'retracted' ? '停用记忆' : '恢复使用'}</button> : <span>{event.status === 'retracted' ? '缺少玩家原话证据，无法恢复。' : '仅保留查阅，不作为角色记忆。'}</span>}</div>
  </article>;
}

export function MemoryDrawer({ world, character, creating, busy, client, onWorld, onRefresh, onContinue, onClose, onArchive }: {
  world?: WorldView; character?: Character; creating: boolean; busy: boolean; client: ApiClient;
  onWorld: (world: WorldView) => void; onRefresh: () => Promise<unknown>; onContinue: () => void; onClose: () => void;
  onArchive?: () => void;
}) {
  const [tab,setTab] = useState<InspectionTab>('overview');
  const [refreshing,setRefreshing] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function change(event: StoryEvent) {
    const status = memoryAction(event);
    if (!world || !status || busy || inFlight.current) return;
    inFlight.current = true; setMutating(event.id); setError(''); setNotice('');
    try {
      const saved = await client.updateMemory(world.id, event.id, { expectedRevision: world.revision, status });
      // Mutation responses are world overviews; re-read the current session's character-scoped memory.
      onWorld(saved);
      await onRefresh();
      if (mounted.current) setNotice(status === 'retracted' ? '已停用，后续对话不再使用这条记忆。' : '已恢复使用这条玩家原话。');
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && ['WORLD_CHANGED', 'REVISION_CONFLICT'].includes(failure.code)) {
        setError('故事已有新的变化，正在刷新记忆，请核对后再操作。');
        await onRefresh();
      } else setError(failure instanceof Error ? failure.message : '记忆状态未能更新，请重试。');
    } finally { inFlight.current = false; if (mounted.current) setMutating(null); }
  }
  const events = world?.events || [];
  const activeCount = events.filter(event => event.status === 'active').length;
  return <Drawer title="世界状态与剧情" eyebrow="STORY & WORLD INSPECTOR" onClose={onClose} wide>
    <div className="av-inspector-heading"><h3>{world?.title || '等待一个故事'}</h3><p>查看你所在的场景、人物、物品和已保存的记忆。</p><div className="av-inspector-actions"><button className="av-button" disabled={busy||refreshing} onClick={async()=>{setRefreshing(true);setError('');try{await onRefresh();}catch{setError('读取失败，请重新刷新。');}finally{if(mounted.current)setRefreshing(false);}}}><RotateCcw size={13} className={refreshing?'av-spin':''}/>刷新记录</button>{onArchive&&<button className="av-button" onClick={onArchive}>完整世界档案</button>}</div><small>故事记录会自动更新。</small></div>
    <nav className="av-world-tabs" aria-label="剧情核查类别">{inspectionTabs.map(([key,label])=><button key={key} aria-pressed={tab===key} className={tab===key?'is-active':''} onClick={()=>setTab(key)}>{label}{world&&['npc','location','item','quest'].includes(key)?` · ${world.entities?.filter(e=>e.kind===key).length??0}`:''}</button>)}</nav>
    {error && <p className="av-form-error" role="alert">{error}</p>}
    {world?<WorldInspection world={world} tab={tab}/>:<p>选择一个会话后即可查看此世界记录。</p>}
    {tab==='memory'&&<>
    <div className="av-section-label"><span>玩家原话与旧记录 · {events.length} 条／{activeCount} 条启用</span><BookOpen size={13}/></div>
    {world && character && <div className="av-continue-session"><button className="av-button" disabled={creating || busy || Boolean(mutating)} onClick={onContinue}>{creating ? <LoaderCircle size={14} className="av-spin" /> : <Plus size={14} />}与{character.name}开启新会话</button><p>{busy ? '本轮结束后即可继续。' : '延续这个世界，保留已有故事与角色记忆。'}</p></div>}
    <div className="av-section-label"><span>这段故事的记忆</span><Sparkles size={13} /></div>
    {busy && <p className="av-memory-note" role="status">对话进行中或正在刷新，记忆操作暂不可用。</p>}
    {notice && <p className="av-memory-note" role="status">{notice}</p>}
    {events.length ? <div className="av-story-timeline">{[...events].reverse().map(event => <MemoryEntry key={event.id} event={event} character={character} disabled={busy || Boolean(mutating)} saving={mutating === event.id} onChange={item => void change(item)} />)}</div> : <div className="av-memory-empty"><Flower2 size={32} strokeWidth={1} /><p>暂无玩家原话记录。</p><span>已有的聊天仍然保留。</span></div>}
    <div className="av-story-footnote"><CircleHelp size={14} /><p>记忆用于延续后续故事。停用某条记忆不会删除已经保存的聊天。</p></div>
    </>}
  </Drawer>;
}
