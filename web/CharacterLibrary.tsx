import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, ChevronRight, LoaderCircle, MessageCircle, Search } from 'lucide-react';
import type { Character } from '../shared/contracts';
import { CharacterImage } from './Avatar';
import { filterCharacters } from './catalog';

export function CharacterLibrary({ characters, fresh, hasWorld, creating, onChoose, onBack }: { characters: Character[]; fresh: boolean; hasWorld: boolean; creating: string | null; onChoose: (character: Character) => void; onBack: () => void }) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('');
  const [includeSamples, setIncludeSamples] = useState(false);
  const [limit, setLimit] = useState(24);
  const filtered = useMemo(() => filterCharacters(characters, query, language, includeSamples), [characters, query, language, includeSamples]);
  const languages = [...new Set(characters.filter(item => includeSamples || item.source !== 'sample').map(item => item.language).filter((item): item is string => Boolean(item)))].sort();
  useEffect(() => { setLimit(24); }, [query, language, includeSamples]);
  return <>
    <header className="av-page-header"><div><span className="av-eyebrow">MEET YOUR NEXT CHAPTER</span><h2>{fresh ? '每个故事，都从相遇开始。' : '下一句话，想和谁说？'}</h2><p>{fresh ? '选择一张根角色卡。场景中的新 NPC 将从这个故事生成，并成为它的世界档案。' : hasWorld ? '与另一位角色延续当前故事，保留各自的视角。' : '选择一位角色，写下属于你们的第一章。'}</p></div><button className="av-icon-button" aria-label="返回聊天" onClick={onBack}><ArrowLeft size={19} /></button></header>
    <div className="av-catalog-tools"><label className="av-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索角色名称或简介" aria-label="搜索角色" /></label><select aria-label="角色语言" value={language} onChange={event => setLanguage(event.target.value)}><option value="">所有语言</option>{languages.map(value => <option key={value} value={value}>{value}</option>)}</select><label className="av-check-label"><input type="checkbox" checked={includeSamples} onChange={event => { setIncludeSamples(event.target.checked); setLanguage(''); }} />显示示例角色</label><span>{filtered.length} 位角色</span></div>
    <div className="av-gallery">{filtered.slice(0, limit).map(character => <article className="av-character-card" key={character.id}><div className={'av-character-cover ' + character.color}><CharacterImage character={character} cover /><span>{character.source === 'sample' ? '示例角色' : character.language || '角色卡'}</span></div><div className="av-character-card-body"><span className="av-eyebrow">{character.subtitle || character.language || '等你写下下一章'}</span><h3>{character.name}</h3><p>{character.description || '在一次交谈中，慢慢认识彼此。'}</p><button className="av-button av-button-primary" disabled={Boolean(creating)} onClick={() => onChoose(character)}>{creating === character.id ? <LoaderCircle size={15} className="av-spin" /> : <MessageCircle size={15} />}{fresh ? '开始新故事' : hasWorld ? '在这个故事里交谈' : '开始交谈'}<ChevronRight size={14} /></button></div></article>)}{!filtered.length && <div className="av-catalog-empty"><Search size={26} /><p>没有找到符合条件的角色。</p><button className="av-button" onClick={() => { setQuery(''); setLanguage(''); }}>清除搜索</button></div>}{limit < filtered.length && <button className="av-button av-catalog-more" onClick={() => setLimit(value => value + 24)}>加载更多 · {Math.min(limit, filtered.length)} / {filtered.length}</button>}</div>
    <p className="av-gallery-note"><BookOpen size={15} />{fresh ? '每张根卡开启独立世界；同一世界的新场景，请从“世界”里的已知人物和地点开始。' : '角色卡属于角色库；当前在场名单由故事场景单独记录。'}</p>
  </>;
}
