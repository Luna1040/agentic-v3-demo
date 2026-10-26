import { useEffect, useState } from 'react';
import { Clapperboard, LoaderCircle, MapPin, Sparkles } from 'lucide-react';
import type { PlayerProfile, Character, SceneState, WorldView } from '../shared/contracts';
import { ApiError, type ApiClient, type CreateSessionInput } from './api';
import { Avatar } from './Avatar';
import { Drawer } from './Drawer';

export interface SceneSeed extends Partial<SceneState> { characterId?: string }
export function SceneBuilder({ client, world, seedCharacter, characters, defaults, busy, onCreate, onClose }: { client: ApiClient; world?: WorldView; seedCharacter?: Character; characters: Character[]; defaults?: SceneSeed; busy: boolean; onCreate: (input: CreateSessionInput) => Promise<void>; onClose: () => void }) {
  const cast = world ? characters : seedCharacter ? [seedCharacter] : [];
  const initialId = cast.find(character => character.id === defaults?.characterId)?.id || seedCharacter?.id || cast[0]?.id || '';
  const [focus, setFocus] = useState(initialId);
  const [present, setPresent] = useState<string[]>([...new Set([initialId, ...defaults?.presentCharacterIds || []].filter(id => cast.some(character => character.id === id)))].slice(0, 6));
  const locations = world?.entities?.filter(entity => entity.kind === 'location') || [];
  const [location, setLocation] = useState(defaults?.location || world?.scene?.location || locations[0]?.name || '');
  const [situation, setSituation] = useState(defaults?.situation || '');
  const [mode, setMode] = useState<NonNullable<SceneState['mode']>>(defaults?.mode || 'ensemble');
  const [dynamicOpening, setDynamicOpening] = useState(Boolean(world));
  const [error, setError] = useState('');
  const [profiles,setProfiles]=useState<PlayerProfile[]>([]);
  const [profileId,setProfileId]=useState('');
  const [profileLoading,setProfileLoading]=useState(!world),[profileError,setProfileError]=useState(''),[profileRetry,setProfileRetry]=useState(0);
  useEffect(()=>{
    if(world)return;
    let active=true;setProfileLoading(true);setProfileError('');
    client.playerProfiles().then(r=>{if(active){setProfiles(r.profiles);setProfileId(id=>r.profiles.some(p=>p.id===id)?id:'')}}).catch(e=>{if(active)setProfileError(e.message)}).finally(()=>{if(active)setProfileLoading(false)});
    return()=>{active=false};
  },[client,world?.id,profileRetry]);
  async function create() {
    if (!focus || busy || profileLoading) return;
    setError('');
    try { await onCreate({ characterId: focus, ...(!world && profileId ? {playerProfileId:profileId} : {}), ...(world ? { worldId: world.id, expectedRevision: world.revision } : {}), dynamicOpening, scene: dynamicOpening ? { location: location.trim() || null, presentCharacterIds: mode === 'direct' ? [focus] : [...new Set([focus, ...present])].slice(0, 6), mode, situation: situation.trim() } : { location: null, presentCharacterIds: [focus], mode: 'ensemble' } }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '场景尚未创建，请重试。'); if(failure instanceof ApiError && failure.code==='PROFILE_NOT_FOUND')setProfileRetry(value=>value+1); }
  }
  return <Drawer title={world ? '在这个世界开启新场景' : '让故事从这一幕开始'} eyebrow="A NEW SCENE" onClose={onClose} wide><form className="av-scene-builder" onSubmit={event => { event.preventDefault(); void create(); }}>
    <div className="av-scene-intro"><Clapperboard size={24} /><div><h3>{world?.title || seedCharacter?.name || '新的故事'}</h3><p>{world ? '延续已发生的互动；每个角色只使用自己知道的经历。' : '默认从作者写好的原开场开始。新人物、地点和线索会随着后续互动自然发展。'}</p></div></div>
    <fieldset disabled={busy}>{world ? <p className="av-dev-note">玩家身份：{world.playerProfile?.name || '未设置'} · 延续当前世界；可在聊天顶部切换。</p> : <><label className="av-field">玩家身份<select disabled={profileLoading} value={profileId} onChange={e=>setProfileId(e.target.value)}><option value="">{profileLoading?'正在读取身份…':'未设置（使用对话中的自我介绍）'}</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><small>在“偏好与说明 → 玩家身份”中创建和编辑。</small></label>{profileId&&<p className="av-profile-preview">{profiles.find(p=>p.id===profileId)?.persona||'未填写 persona'}</p>}{profileError&&<p className="av-form-error" role="alert">身份列表读取失败：{profileError} <button className="av-button" type="button" onClick={()=>setProfileRetry(value=>value+1)}>重试读取身份</button></p>}</>}<label className="av-field">关注角色<select value={focus} onChange={event => { setFocus(event.target.value); setPresent(value => [...new Set([event.target.value, ...value])].slice(0, 6)); }}>{cast.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select></label>
      {!world && <label className="av-field">开场方式<select value={dynamicOpening ? 'dynamic' : 'authored'} onChange={event => setDynamicOpening(event.target.value === 'dynamic')}><option value="authored">作者原开场（welcomeMessage）</option><option value="dynamic">自定义场景并生成新开场</option></select><small>原开场直接使用角色卡正文，不调用模型改写。</small></label>}
      {dynamicOpening && <><label className="av-field"><span><MapPin size={13} />地点</span>{locations.length ? <select value={location} onChange={event => setLocation(event.target.value)}>{location && !locations.some(item => item.name === location) && <option value={location}>{location}</option>}{locations.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select> : <input maxLength={120} value={location} onChange={event => setLocation(event.target.value)} placeholder="例如：雨夜的旧书店；留空让开场确定" />}</label>
      <label className="av-field">此刻的情境<textarea maxLength={1000} value={situation} onChange={event => setSituation(event.target.value)} placeholder="给这一幕一个可回应的起点，例如：一位送信人带着烧毁一半的信前来。" /></label>
      <div className="av-form-label">参与方式</div><div className="av-mode-options">{([{ key: 'ensemble', label: '参与场景', note: '在场角色可以听见并回应' }, { key: 'direct', label: '单独交谈', note: '只有关注角色听见你的私聊' }, { key: 'observe', label: '先看演出', note: '每次点击后继续一幕' }] as const).map(item => <button type="button" key={item.key} className={mode === item.key ? 'is-active' : ''} onClick={() => setMode(item.key)}><strong>{item.label}</strong><small>{item.note}</small></button>)}</div>
      {mode !== 'direct' && <><div className="av-form-label">这次出场 <span>{present.length} / 6</span></div><div className="av-cast-options">{cast.map(character => <label key={character.id}><input type="checkbox" checked={present.includes(character.id)} disabled={character.id === focus || (!present.includes(character.id) && present.length >= 6)} onChange={event => setPresent(current => event.target.checked ? [...new Set([...current, character.id])] : current.filter(id => id !== character.id))} /><Avatar character={character} /><span>{character.name}</span>{character.source === 'generated' && <small>世界角色</small>}</label>)}</div><p className="av-dev-note">角色名单来自当前世界；场景发展还可以引入有来由的新 NPC。每一轮最多三位角色回应。</p></>}
      </>}
      <button className="av-button av-button-primary av-scene-create" type="submit" disabled={!focus||profileLoading}>{busy ? <LoaderCircle size={15} className="av-spin" /> : <Sparkles size={15} />}{busy ? '正在创建场景…' : dynamicOpening ? '创建场景并生成开场' : '开始故事 · 作者原开场'}</button><p className="av-dev-note">{dynamicOpening ? '创建后会实际调用开场与角色 Agent；可以停止，失败时使用同一个开场重试。' : '创建后立即显示作者原开场，不消耗模型 token。发送第一条消息后才开始 Agent 调用。'}</p>
    </fieldset>{error && <p className="av-form-error" role="alert">{error}</p>}
  </form></Drawer>;
}
