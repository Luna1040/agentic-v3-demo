import { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, LoaderCircle, Plus, RotateCcw } from 'lucide-react';
import type { Character, WorldEntity, WorldView } from '../shared/contracts';
import { ApiError, type ApiClient } from './api';
import { Avatar } from './Avatar';
import type { SceneSeed } from './SceneBuilder';
import { entityCharacter, entityKinds, questStatus } from './world-model';
import { storyTimeLabel } from './time-model';

const tabs = ['npc', 'location', 'item', 'quest', 'faction'] as const;
export function WorldArchive({ world, templates, focusId, client, busy, onBack, onScene, onUpdated }: {
  world?: WorldView; templates: Character[]; focusId?: string; client: ApiClient; busy: boolean;
  onBack: () => void; onScene: (world: WorldView, defaults?: SceneSeed) => void; onUpdated: () => Promise<unknown>;
}) {
  const [tab, setTab] = useState<typeof tabs[number]>('npc');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'paused' | 'quiet' | 'active'>(world?.clock?.mode || 'quiet');
  const [rate, setRate] = useState(world?.clock?.rate || 1);
  useEffect(() => { setMode(world?.clock?.mode || 'quiet'); setRate(world?.clock?.rate || 1); }, [world?.id, world?.clock?.mode, world?.clock?.rate]);
  async function saveClock() {
    if (!world || busy || saving || !Number.isFinite(rate) || rate < .1 || rate > 60) return;
    setSaving(true); setError('');
    try { await client.updateClock(world.id, { expectedRevision: world.revision, mode, rate }); await onUpdated(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '节奏没有保存。');
      if (failure instanceof ApiError && ['WORLD_CHANGED', 'REVISION_CONFLICT'].includes(failure.code)) await onUpdated().catch(() => {});
    } finally { setSaving(false); }
  }
  const entities = world?.entities || [];
  return <><header className="av-page-header"><div><span className="av-eyebrow">A WORLD THAT REMEMBERS</span><h2>{world?.title || '你的世界档案'}</h2><p>回顾故事中的人物、地点、物品与约定。</p></div><button className="av-icon-button" aria-label="返回聊天" onClick={onBack}><ArrowLeft size={19} /></button></header>
    <div className="av-world-workspace">{!world ? <div className="av-catalog-empty"><BookOpen size={30} /><p>先选一张角色卡，开启属于它的世界。</p></div> : <>
      <div className="av-world-overview"><p>{storyTimeLabel(world.storyTime)}</p><button className="av-button av-button-primary" disabled={busy || saving} onClick={() => onScene(world, { characterId: focusId })}><Plus size={14} />开启新场景</button></div>
      <details className="av-clock-settings"><summary>故事节奏</summary><div><label className="av-field">行动节奏<select value={mode} disabled={busy || saving} onChange={event => setMode(event.target.value as typeof mode)}><option value="paused">暂停</option><option value="quiet">安静</option><option value="active">活跃</option></select></label><label className="av-field">时间倍率<input type="number" min="0.1" max="60" step="0.1" value={Number.isNaN(rate) ? '' : rate} disabled={busy || saving} onChange={event => setRate(event.target.valueAsNumber)} /></label><button className="av-button" disabled={busy || saving || !Number.isFinite(rate) || rate < .1 || rate > 60} onClick={() => void saveClock()}>{saving && <LoaderCircle size={13} className="av-spin" />}保存节奏</button></div><p>暂停时停止自动推进，已有故事仍会保留。</p></details>
      <nav className="av-world-tabs" aria-label="世界档案类别">{tabs.map(key => <button key={key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>{entityKinds[key]}</button>)}</nav>
      {error && <p className="av-form-error" role="alert">{error}<button className="av-button" onClick={() => void onUpdated()}><RotateCcw size={13} />重新读取</button></p>}
      <div className="av-entity-grid">{entities.filter(entity => entity.kind === tab).map(entity => <EntityCard key={entity.id} entity={entity} entities={entities} templates={templates} busy={busy || saving} onScene={defaults => onScene(world, defaults)} />)}{!entities.some(entity => entity.kind === tab) && <p>故事中还没有记录{entityKinds[tab]}。</p>}</div>
    </>}</div></>;
}

export function EntityCard({ entity, entities, templates, busy = false, onScene }: { entity: WorldEntity; entities: WorldEntity[]; templates: Character[]; busy?: boolean; onScene?: (seed?: SceneSeed) => void }) {
  const kind: keyof typeof entityKinds = entity.kind;
  const character = entity.kind === 'npc' ? entityCharacter(entity, templates) : undefined;
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const name = (id: unknown, kind: WorldEntity['kind']) => typeof id === 'string' ? text(entities.find(candidate => candidate.id === id && candidate.kind === kind)?.name) : '';
  const details: { label: string; value: string }[] = [];
  const add = (label: string, value: string) => { if (value) details.push({ label, value }); };
  if (entity.kind === 'item') {
    add('状态', text(entity.state.status));
    add('所在地点', name(entity.state.locationId, 'location'));
    add('持有者', entity.state.holderCharacterId === '$player' ? '你（玩家）' : entity.state.holderCharacterId === null ? '当前无人持有' : name(entity.state.holderCharacterId, 'npc'));
  } else if (entity.kind === 'npc') add('最近确认地点', entity.state.locationId === null ? '已离开，尚未确认到达地点' : name(entity.state.locationId, 'location'));
  else if (entity.kind === 'quest') {
    if (text(entity.state.status)) add('状态', questStatus(entity.state.status));
    add('负责人', entity.state.ownerCharacterId === '$player' ? '你（玩家）' : name(entity.state.ownerCharacterId, 'npc'));
  }
  return <article className={'av-entity-card is-' + entity.kind}><header>{character && <Avatar character={character} large />}<div><span>{entityKinds[kind]}</span><h3>{entity.name}</h3></div></header><p>{entity.description || '尚无进一步记述。'}</p>{details.length > 0 && <dl className="av-entity-details">{details.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}{onScene && (entity.kind === 'npc' || entity.kind === 'location') && <footer><button className="av-button" disabled={busy} onClick={() => onScene(entity.kind === 'npc' ? { characterId: entity.id } : { location: entity.name })}>{entity.kind === 'npc' ? '与 TA 开启场景' : '在此开启场景'}</button></footer>}</article>;
}
