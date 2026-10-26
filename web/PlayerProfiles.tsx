import { useEffect, useRef, useState } from 'react';
import type { PlayerProfile, WorldView } from '../shared/contracts';
import { ApiError, type ApiClient } from './api';
import { profileDraft, profileDrafts, profileDirty, type ProfileDraft } from './player-profile-drafts';

export function PlayerProfiles(props: { client: ApiClient; world?: WorldView; busy: boolean; onApplied: () => Promise<void> }) {
  return <ProfileEditor key={profileDrafts(props.client, props.world?.id).key} {...props} />;
}
function ProfileEditor({ client, world, busy, onApplied }: { client: ApiClient; world?: WorldView; busy: boolean; onApplied: () => Promise<void> }) {
  const memory = profileDrafts(client, world?.id);
  const [draft, setDraft] = useState(memory.current);
  const { selected, name, persona } = draft;
  const [items, setItems] = useState<PlayerProfile[]>([]);
  const [working, setWorking] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<'delete' | 'discard' | null>(null);
  const lock = useRef(false), mounted = useRef(true);
  const dirty = profileDirty(draft);
  function update(next: ProfileDraft) { setDraft(memory.write(next)); setConfirm(null); }
  async function readProfiles() { const result = await client.playerProfiles(); if (mounted.current) setItems(result.profiles); return result.profiles; }
  useEffect(() => {
    mounted.current = true;
    void readProfiles().catch(e => { if (mounted.current) setError(e.message); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [client]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setWorking(true); setError(''); setNote('');
    try { await work(); }
    catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '操作失败，请重试。');
      if (failure instanceof ApiError && ['PROFILE_CHANGED', 'PROFILE_NOT_FOUND'].includes(failure.code)) {
        await readProfiles().catch(() => {});
        if (mounted.current) setNote('草稿已保留。可载入库中最新版本，或将草稿另存为新身份。');
      }
    } finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  async function apply(profileId: string | null) {
    if (!world || busy) return;
    try { await client.setPlayerProfile(world.id, { profileId, expectedRevision: world.revision }); }
    catch (failure) {
      if (failure instanceof ApiError && ['WORLD_CHANGED', 'REVISION_CONFLICT'].includes(failure.code)) {
        await onApplied();
        throw new Error('世界已有变化，已请求刷新。请核对当前设定后重试。');
      }
      throw failure;
    }
    await onApplied();
    if (mounted.current) setNote(profileId ? '已应用到当前世界，原开场姓名已更新，下一轮模型也会使用此姓名与设定。' : '已停用额外设定，已有剧情保留。');
  }
  function select(profile: PlayerProfile | null) { setDraft(memory.select(profile)); setConfirm(null); setError(''); setNote(''); }
  return <section className="av-player-profiles"><h3>玩家身份</h3><p>保存多套姓名与 persona，按故事选择使用。设定供创作参考，NPC 不会自动知道未公开的背景。</p>
    {world && <div className="av-profile-current"><small>当前世界：{world.title}</small><strong>正在使用：{world.playerProfile?.name || '未设置'}</strong>{world.playerProfile && <details><summary>查看正在使用的设定</summary><p>{world.playerProfile.persona || '未填写 persona'}</p></details>}<small>应用后原开场立即更新，后续模型使用此姓名与设定。已发生的对话、物品和经历保留；换成另一个人物开始独立人生时，请新开世界。</small></div>}
    <fieldset disabled={working || loading}>
      <label className="av-field">已保存的身份<select value={selected?.id || ''} onChange={e => select(items.find(p => p.id === e.target.value) || null)}><option value="">＋ 新建身份</option>{selected && !items.some(p => p.id === selected.id) && <option value={selected.id}>{selected.name}（草稿）</option>}{items.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <form onSubmit={e => { e.preventDefault(); const applyNow = !!world && (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'library'; if(applyNow && busy)return; void run(async () => {
        const p = await client.savePlayerProfile(selected?.id || null, { name, persona, ...(selected ? { expectedVersion: selected.version } : {}) });
        const saved = memory.saved(p, selected?.id || '');
        if (mounted.current) { setItems(current => [...current.filter(x => x.id !== p.id), p]); setDraft(saved); setConfirm(null); setNote('已保存到身份库。应用到世界后才影响后续聊天。'); }
        if(applyNow) await apply(p.id);
      }); }}>
        <label className="av-field">玩家姓名<input required maxLength={80} value={name} onChange={e => update({ ...draft, name: e.target.value })} placeholder="在故事中使用的姓名" /></label>
        <label className="av-field">Persona<textarea maxLength={3000} rows={7} value={persona} onChange={e => update({ ...draft, persona: e.target.value })} placeholder="身份、外貌、性格、背景，以及你希望扮演的人物。请区分公开信息和秘密。" /><small>{persona.length} / 3000</small></label>
        <div className="av-profile-buttons"><button className="av-button" type="submit" value="apply" disabled={!name.trim() || (world ? busy : !dirty && !!selected)}>{world ? '保存并应用到当前世界' : '保存身份'}</button>{world && <button className="av-button" type="submit" value="library" disabled={!name.trim() || (!dirty && !!selected)}>仅保存到身份库</button>}{selected && <button className="av-button" type="button" onClick={() => select(null)}>新建另一套</button>}</div>
      </form>
      {dirty && <p className="av-dev-note">未保存草稿会在本次页面内保留，刷新页面前请保存。可直接保存并应用到当前世界，或仅保存到身份库。</p>}
      {world && <div className="av-profile-buttons"><button className="av-button av-button-primary" disabled={!selected || dirty || busy || !items.some(p => p.id === selected.id && p.version === selected.version)} onClick={() => void run(() => apply(selected!.id))}>应用到当前世界</button>{world.playerProfile && <button className="av-button" disabled={busy} onClick={() => void run(() => apply(null))}>停用当前设定</button>}</div>}
      {world && busy && <p className="av-dev-note">故事正在运行或载入，完成后可切换身份。</p>}
      <div className="av-profile-buttons"><button className="av-button" onClick={() => void run(async () => { await readProfiles(); setNote('身份列表已刷新，未保存草稿保留。'); })}>刷新身份列表</button>
        <button className="av-button" disabled={!dirty && !selected} onClick={() => {
          if (dirty && confirm !== 'discard') { setConfirm('discard'); return; }
          void run(async () => { const latest = await readProfiles(); update(profileDraft(latest.find(p => p.id === selected?.id) || null)); });
        }}>{confirm === 'discard' ? '确认放弃草稿并重新载入' : '放弃草稿 / 载入最新版本'}</button>
        {selected && <button className="av-button" disabled={!name.trim()} onClick={() => void run(async () => {
          const p = await client.savePlayerProfile(null, { name, persona });
          const saved = memory.saved(p, selected?.id || '');
          if (mounted.current) { setItems(current => [...current, p]); setDraft(saved); setNote('已另存为新身份，当前世界未改变。'); }
        })}>另存为新身份</button>}
      </div>
      {selected && <button className="av-button" onClick={() => {
        if (confirm !== 'delete') { setConfirm('delete'); return; }
        void run(async () => { await client.deletePlayerProfile(selected.id, selected.version); const next = memory.remove(selected.id); if (mounted.current) { setItems(current => current.filter(p => p.id !== selected.id)); setDraft(next); setConfirm(null); setNote('已从身份库删除，已有世界使用的设定保留。'); } });
      }}>{confirm === 'delete' ? '确认删除这套身份（已有世界不受影响）' : '删除这套身份'}</button>}
    </fieldset>{loading && <p>正在读取身份…</p>}{working && <p role="status">正在处理…</p>}{note && <p role="status">{note}</p>}{error && <p role="alert" className="av-form-error">{error}</p>}
  </section>;
}
