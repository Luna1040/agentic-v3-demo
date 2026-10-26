import { StoryProgress } from './StoryProgress';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Clock3, Compass, Flag, LoaderCircle, MapPin, MessageCircle, Package, Plus, RotateCcw, Sparkles, Users } from 'lucide-react';
import type { Character, WorldActivity, WorldEntity, WorldView } from '../shared/contracts';
import { ApiError, type ApiClient } from './api';
import { Avatar } from './Avatar';
import { ReadingText } from './ChatMessage';
import type { SceneSeed } from './SceneBuilder';
import { entityCharacter, entityKinds, questStatus, worldCharacters, worldRecordCounts } from './world-model';
import { characterView } from '../shared/character-view';
import { storyTimeLabel, recordedTimeLabel, localTimeZone } from './time-model';

const date = (value?: string) => recordedTimeLabel(value);
const tabs = [{key:'story',name:'剧情进度',icon:BookOpen}, { key: 'npc', name: '人物', icon: Users }, { key: 'location', name: '地点', icon: MapPin }, { key: 'item', name: '物品', icon: Package }, { key: 'quest', name: '任务', icon: Flag }, { key: 'faction', name: '组织', icon: Compass }, { key: 'episodes', name: '完整互动', icon: MessageCircle }, { key: 'activity', name: '世界动态', icon: Sparkles }] as const;
type Tab = typeof tabs[number]['key'];
type Activity = WorldActivity & { occurredAt?: string; sourceTurnId?: string };
export function WorldArchive({ world, templates, focusId, client, busy, onBack, onScene, onSession, onUpdated }: { world?: WorldView; templates: Character[]; focusId?: string; client: ApiClient; busy: boolean; onBack: () => void; onScene: (world: WorldView, defaults?: SceneSeed) => void; onSession: (id: string) => void; onUpdated: () => Promise<unknown> }) {
  const [current, setCurrent] = useState(world);
  const [tab, setTab] = useState<Tab>('npc');
  const [loading, setLoading] = useState(Boolean(world));
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'paused' | 'quiet' | 'active'>(world?.clock?.mode || 'quiet');
  const [rate, setRate] = useState(world?.clock?.rate || 1);
  const incoming = useRef(world); incoming.current = world;
  // Planning can change without a world revision. Adopt the fresh snapshot,
  // while keeping independently edited clock controls out of this refresh.
  useEffect(() => { setCurrent(previous => !world ? undefined : !previous || previous.id !== world.id || world.revision >= previous.revision ? world : previous); }, [world]);
  useEffect(() => { setMode(world?.clock?.mode || 'quiet'); setRate(world?.clock?.rate || 1); }, [world?.id, world?.clock?.mode, world?.clock?.rate]);
  useEffect(() => {
    if (!world) { setCurrent(undefined); setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError('');
    const requestedFrom = incoming.current;
    void client.world(world.id, { signal: controller.signal }).then(value => { if (!controller.signal.aborted && incoming.current === requestedFrom) setCurrent(previous => !previous || previous.id !== value.id || value.revision >= previous.revision ? value : previous); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '世界档案无法读取。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, world?.id, refresh]);
  const cast = worldCharacters(current, templates, focusId);
  const entities = current?.entities || [];
  const episodes = (current?.episodes || []).filter(episode => episode.kind === 'chat' || episode.kind === 'opening');
  const activities: Activity[] = (current as (WorldView & { activities?: Activity[] }) | undefined)?.activities || [];
  async function saveClock() {
    if (!current || busy || saving || !Number.isFinite(rate) || rate < .1 || rate > 60) return;
    setSaving(true); setError('');
    try { const value = await client.updateClock(current.id, { expectedRevision: current.revision, mode, rate }); setCurrent(value); await onUpdated(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '节奏没有保存。'); if (failure instanceof ApiError && ['WORLD_CHANGED', 'REVISION_CONFLICT'].includes(failure.code)) setRefresh(value => value + 1); }
    finally { setSaving(false); }
  }
  function scene(defaults?: SceneSeed) { if (current && !busy && !saving) onScene(current, defaults); }
  return <><header className="av-page-header"><div><span className="av-eyebrow">A WORLD THAT REMEMBERS</span><h2>{current?.title || '你的世界档案'}</h2><p>人物、地点与经历从故事中长出。这里是你的观察视角，角色仍各自拥有知识边界。</p></div><button className="av-icon-button" aria-label="返回聊天" onClick={onBack}><ArrowLeft size={19} /></button></header>
    <div className="av-world-workspace">{!current ? <div className="av-catalog-empty"><BookOpen size={30} /><p>先选一张根角色卡，开启属于它的世界。</p></div> : <>
      <div className="av-world-overview"><div><span><Clock3 size={14} />{storyTimeLabel(current.storyTime)}</span><p>{cast.length} 位世界角色 · {entities.filter(entity => entity.kind === 'location').length} 处地点 · {worldRecordCounts(current).interactions} 段已提交互动</p></div><button className="av-button av-button-primary" disabled={busy || saving || loading} onClick={() => scene({ characterId: focusId })}><Plus size={14} />开启新场景</button></div>
      <p className="av-dev-note">现实记录按本地时区 {localTimeZone()} 显示；剧情时间随故事推进。</p><details className="av-clock-settings"><summary>世界节奏 <span>{({ paused: '暂停', quiet: '安静', active: '活跃' } as const)[current.clock?.mode || 'quiet']}</span></summary><div><label className="av-field">行动节奏<select value={mode} disabled={busy || saving} onChange={event => setMode(event.target.value as typeof mode)}><option value="paused">暂停</option><option value="quiet">安静</option><option value="active">活跃</option></select></label><label className="av-field">离场结算倍率<input type="number" min="0.1" max="60" step="0.1" value={Number.isNaN(rate) ? '' : rate} disabled={busy || saving} onChange={event => setRate(event.target.valueAsNumber)} /></label><button className="av-button" disabled={busy || saving || !Number.isFinite(rate) || rate < .1 || rate > 60} onClick={() => void saveClock()}>{saving && <LoaderCircle size={13} className="av-spin" />}保存节奏</button></div><p>当前场景中的等待不会自动推进剧情。明确的剧情时间跨度，或离场后符合条件的真实间隔，会在继续交谈时结算有限行动。暂停时停止自动结算；打开或刷新档案不会调用模型。</p></details>
      <nav className="av-world-tabs" aria-label="世界档案类别">{tabs.map(({ key, name, icon: Icon }) => <button key={key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}><Icon size={14} />{name}</button>)}</nav>
      {error && <div className="av-form-error" role="alert">{error}<button className="av-button" onClick={() => setRefresh(value => value + 1)}><RotateCcw size={13} />重新读取</button></div>}{loading && <p className="av-loading-line"><LoaderCircle size={13} className="av-spin" />读取世界档案…</p>}
      {tab === 'story' ? <StoryProgress world={current} /> : tab === 'episodes' ? <div className="av-episode-list">{[...episodes].reverse().map(episode => <details className="av-episode" key={`${episode.turnId}:${episode.kind}:${episode.participantIds.join(',')}`}><summary><div><strong>{episode.kind === 'opening' ? '场景开场' : '一段交谈'}</strong><span>{entities.find(entity => entity.kind === 'location' && entity.id === episode.scene.location)?.name || episode.scene.location || '地点未确定'} · {storyTimeLabel(episode.storyTime)} · 记录于 {date(episode.recordedAt ?? episode.occurredAt)}</span></div><small>{episode.replies.length} 段角色回应</small></summary><div className="av-episode-body"><p className="av-dev-note">参与者：{episode.participantIds.map(id => cast.find(character => character.id === id)?.name || id).join('、')}</p>{episode.userText && <div className="av-episode-message"><strong>你</strong><ReadingText content={episode.userText} /></div>}{episode.replies.map((reply, index) => <div className="av-episode-message" key={`${reply.characterId}-${index}`}><strong>{reply.characterName}</strong><ReadingText content={reply.text} /></div>)}<button className="av-button" onClick={() => onSession(episode.sessionId)}>返回这段会话</button></div></details>)}{!episodes.length && <Empty text="还没有已提交的完整互动。动态开场和交谈成功后会保存在这里。" />}</div> : tab === 'activity' ? <div className="av-activity-list"><p className="av-dev-note">只展示已经完成的行动与可介入邀约。未完成的后台尝试不会被当作故事事实。</p>{[...activities].reverse().map((activity, index) => <article className="av-activity" key={`${activity.sourceTurnId || activity.characterId}-${index}`}><span className="av-activity-icon"><Sparkles size={17} /></span><div><div className="av-activity-meta"><strong>{cast.find(character => character.id === activity.characterId)?.name || '世界动态'}</strong><small>{activity.storyTime && <>结算至 {storyTimeLabel(activity.storyTime)} · </>}记录于 {date(activity.occurredAt)} · {activity.kind === 'invitation' ? '等待你的选择' : '已完成'}</small></div><p>{activity.text}</p>{activity.kind === 'invitation' && <button className="av-button" disabled={busy || saving} onClick={() => scene({ characterId: activity.characterId, location: entities.find(entity => entity.id === activity.locationId)?.name, situation: activity.text })}>进入可介入的场景</button>}</div></article>)}{!activities.length && <Empty text="暂时没有世界动态。故事出现可结算的时间跨度后，这里会记录角色完成的活动和待参与邀约。" />}</div> : <div className="av-entity-grid">{entities.filter(entity => entity.kind === tab).map(entity => <EntityCard key={entity.id} entity={entity} entities={entities} templates={templates} busy={busy || saving} onScene={scene} />)}{!entities.some(entity => entity.kind === tab) && <Empty text={`这个世界还没有发现${entityKinds[tab]}。让角色在场景中遇见、探索与行动，档案会随提交建立。`} />}</div>}
    </>}</div></>;
}
function Empty({ text }: { text: string }) { return <div className="av-world-empty"><BookOpen size={27} strokeWidth={1.3} /><p>{text}</p></div>; }
export function EntityCard({ entity, entities, templates, busy, onScene }: { entity: WorldEntity; entities: WorldEntity[]; templates: Character[]; busy: boolean; onScene: (seed?: SceneSeed) => void }) {
  const character = entity.kind === 'npc' ? entityCharacter(entity, templates) : undefined;
  const perspective = entity.kind === 'npc' ? characterView(entity.state) : undefined;
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const referenceName = (id: unknown, kind: WorldEntity['kind']) => typeof id === 'string' ? text(entities.find(candidate => candidate.id === id && candidate.kind === kind)?.name) : '';
  const details: { label: string; value: string }[] = [];
  const add = (label: string, value: string) => { if (value) details.push({ label, value }); };
  if (entity.kind === 'item') {
    add('状态', text(entity.state.status));
    add('所在地点', referenceName(entity.state.locationId, 'location'));
    add('持有者', entity.state.holderCharacterId === '$player' ? '你（玩家）' : entity.state.holderCharacterId === null ? '当前无人持有' : referenceName(entity.state.holderCharacterId, 'npc'));
  } else if (entity.kind === 'npc') {
    add('最近确认地点', entity.state.locationId === null ? '已离开，尚未确认到达地点' : referenceName(entity.state.locationId, 'location'));
  } else if (entity.kind === 'quest') {
    if (text(entity.state.status)) add('状态', questStatus(entity.state.status));
    add('负责人', referenceName(entity.state.ownerCharacterId, 'npc'));
    const dueAt = text(entity.state.dueAt);
    if (dueAt && Number.isFinite(new Date(dueAt).getTime())) add('约定时间', date(dueAt));
    if (entity.state.storyDue) add('剧情约定时间', storyTimeLabel(entity.state.storyDue));
    const progression = entity.state.progression && typeof entity.state.progression === 'object' ? entity.state.progression as Record<string, unknown> : {};
    add('当前阶段', text(progression.phase));
    if (Array.isArray(progression.completedMilestones)) add('已完成阶段', progression.completedMilestones.map(text).filter(Boolean).join('；'));
    add('下一步意向', text(progression.nextStep));
    if (entity.state.recurrence === 'daily') add('安排', '每日重复；各次结果分别保留');
    add('结果', text(entity.state.result));
  }
  return <article className={'av-entity-card is-' + entity.kind}><header>{character ? <Avatar character={character} large /> : <span className="av-entity-symbol">{entity.kind === 'location' ? <MapPin /> : entity.kind === 'quest' ? <Flag /> : entity.kind === 'item' ? <Package /> : <Compass />}</span>}<div><span>{entityKinds[entity.kind]}{character?.source === 'generated' ? ' · 故事中生成' : ''}</span><h3>{entity.name}</h3></div></header><p>{entity.description || '尚无进一步记述。'}</p>{details.length > 0 && <dl className="av-entity-details">{details.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}{perspective ? <section className="av-entity-arc"><strong>角色视角摘要</strong><p>{perspective.summary}</p><small>这是角色对经历的理解，可能包含主观判断。</small><details><summary>{perspective.provenance.status === 'source_verified' ? '查看本次摘要的来源片段' : '旧摘要 · 来源未核验'}</summary>{perspective.provenance.status === 'source_verified' ? <><p>{perspective.provenance.quote}</p><small>来源可追溯，不代表整段摘要已经核实。</small></> : <p>保留原有记述；不能据此确认玩家的动机或过去。</p>}</details></section> : entity.kind !== 'npc' && text(entity.state.arc) ? <p className="av-entity-arc">{text(entity.state.arc)}</p> : null}<footer><small title={entity.sourceTurnId}>{entity.sourceTurnId === 'seed' ? '原角色卡' : entity.sourceTurnId === 'user-scene' ? '用户设置场景' : `来源 #${entity.sourceTurnId.slice(-8)}`} · 登记于 {date(entity.createdAt)}</small>{(entity.kind === 'npc' || entity.kind === 'location') && <button className="av-button" disabled={busy} onClick={() => onScene(entity.kind === 'npc' ? { characterId: entity.id } : { location: entity.name })}>{entity.kind === 'npc' ? '与 TA 开启场景' : '在此开启场景'}</button>}</footer></article>;
}
