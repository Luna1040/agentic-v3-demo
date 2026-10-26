import { useEffect, useReducer, useRef, useState } from 'react';
import { LoaderCircle, MapPin, Pencil, Search, Users, X } from 'lucide-react';
import type { Character, SceneState, WorldView } from '../shared/contracts';
import { ApiError, type ApiClient } from './api';
import { Avatar } from './Avatar';
import { Drawer } from './Drawer';
import { sceneDraft, sceneDraftReducer, scenePatch } from './scene-state';
import { storyTimeLabel } from './time-model';

export function SceneStrip({ world, characters, busy, onEdit }: { world?: WorldView; characters: Character[]; busy: boolean; onEdit: () => void }) {
  const scene = world?.scene;
  return <div className="av-scene-strip"><div className="av-scene-location"><MapPin size={14} /><span><small>当前地点</small><strong>{scene?.location || '尚未确定'}</strong></span></div><span className="av-scene-time">{storyTimeLabel(world?.storyTime)}</span><span className="av-scene-mode">{scene?.playerPresent === false ? '你已离场 · 角色继续行动' : scene?.mode === 'direct' ? '私聊 · 仅关注角色听见' : scene?.mode === 'observe' ? '旁观模式' : '共同场景'}</span><div className="av-present"><Users size={14} /><small>在场</small>{scene?.presentCharacterIds.length ? scene.presentCharacterIds.map(id => { const character = characters.find(item => item.id === id); return <span className="av-presence-chip" key={id}><Avatar character={character} />{character?.name || id}</span>; }) : <span className="av-scene-muted">{scene ? '暂无在场角色' : '尚未确认'}</span>}</div><button className="av-icon-button" aria-label="编辑当前场景" title={busy ? '本轮结束后可编辑场景' : '编辑当前场景'} disabled={!world || busy} onClick={onEdit}><Pencil size={14} /></button></div>;
}
export function SceneEditor({ world, characters, activeCharacterId, sessionId, busy, client, onSaved, onClose }: { world: WorldView; characters: Character[]; activeCharacterId?: string; sessionId: string; busy: boolean; client: ApiClient; onSaved: () => Promise<WorldView | null>; onClose: () => void }) {
  const [draft, dispatch] = useReducer(sceneDraftReducer, world, sceneDraft);
  const { location, present } = draft;
  const setLocation = (value: string) => dispatch({ type: 'location', value });
  const setPresent = (update: (current: string[]) => string[]) => dispatch({ type: 'present', value: update(present) });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflictBlocked, setConflictBlocked] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const activeCharacter = characters.find(character => character.id === activeCharacterId);
  useEffect(() => () => controller.current?.abort(), []);
  const candidates = characters.filter(character => !present.includes(character.id) && (!query.trim() ? character.source !== 'sample' : `${character.name} ${character.subtitle}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).slice(0, 16);
  async function save() {
    if (saving || busy || conflictBlocked) return;
    const request = new AbortController(); controller.current = request;
    setSaving(true); setError('');
    try {
      await client.updateScene(world.id, { ...scenePatch(draft, activeCharacterId), sessionId }, { signal: request.signal });
      if (request.signal.aborted) return;
      await onSaved();
      if (!request.signal.aborted) onClose();
    } catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof ApiError && ['WORLD_CHANGED', 'REVISION_CONFLICT'].includes(failure.code)) {
        setError('场景已有新的变化，正在重新载入。');
        const latest = await onSaved();
        if (request.signal.aborted) return;
        if (latest?.id === world.id) {
          dispatch({ type: 'reload', world: latest });
          setError('场景已被其他操作更新。未保存的场景草稿已替换为服务器最新内容，请核对后重新编辑。');
        } else {
          setConflictBlocked(true);
          setError('最新场景读取失败，本次草稿不能继续保存。请关闭并重新打开场景后再试。');
        }
      } else setError(failure instanceof Error ? failure.message : '场景未能保存。');
    } finally { if (!request.signal.aborted) setSaving(false); }
  }
  return <Drawer title="当前场景" eyebrow="WHERE THE STORY HAPPENS" onClose={onClose}><form className="av-scene-editor" onSubmit={event => { event.preventDefault(); void save(); }}><p>记录此刻的位置和实际在场的人。保存后会用于后续对话。</p><fieldset disabled={busy || saving || conflictBlocked}><label className="av-field">参与方式<select value={draft.mode || 'ensemble'} onChange={event => dispatch({ type: 'mode', value: event.target.value as NonNullable<SceneState['mode']>, focusId: activeCharacterId })}><option value="ensemble">共同场景 · 在场角色可以听见</option><option value="direct" disabled={!activeCharacter}>私聊 · 仅当前角色听见</option><option value="observe">旁观 · 手动继续演出</option></select></label>{draft.mode === 'direct' && <p className="av-dev-note">保存私聊时只保留{activeCharacter?.name || '当前角色'}。切回共同场景后，可手动加入本世界的其他角色。</p>}<label className="av-field">当前地点<input value={location} maxLength={120} onChange={event => setLocation(event.target.value)} placeholder="例如：旧书店二楼" /></label>{activeCharacter && !present.includes(activeCharacter.id) && <div className="av-scene-return"><p>当前聊天角色 {activeCharacter.name} 需要在场，才能继续对话或试跑。</p><button className="av-button" type="button" disabled={present.length >= 6} onClick={() => setPresent(value => value.length < 6 ? [...new Set([...value, activeCharacter.id])] : value)}>将{activeCharacter.name}加入场景</button>{present.length >= 6 && <small>在场已满六人，请先移出一位角色。</small>}</div>}<div className="av-form-label">在场角色 <span>{present.length} / 6</span></div><div className="av-selected-people">{present.map(id => { const character = characters.find(item => item.id === id); return <button type="button" key={id} disabled={draft.mode === 'direct'} onClick={() => setPresent(value => value.filter(item => item !== id))} aria-label={'移出场景：' + (character?.name || id)}><Avatar character={character} /><span>{character?.name || id}</span><X size={12} /></button>; })}{!present.length && <small>尚未添加在场角色。</small>}</div>{draft.mode !== 'direct' && <><label className="av-search"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="寻找要加入场景的人" aria-label="搜索在场角色" /></label><div className="av-scene-candidates">{candidates.map(character => <button type="button" disabled={present.length >= 6} key={character.id} onClick={() => setPresent(value => value.length < 6 && !value.includes(character.id) ? [...value, character.id] : value)}><Avatar character={character} /><span>{character.name}</span><small>加入</small></button>)}{!candidates.length && <p>没有找到可添加的角色。</p>}</div></>}<button className="av-button av-button-primary" type="submit">{saving && <LoaderCircle size={14} className="av-spin" />}保存场景</button></fieldset>{busy && <p role="status">本轮进行中，结束后即可编辑场景。</p>}{error && <p className="av-form-error" role="alert">{error}</p>}</form></Drawer>;
}
