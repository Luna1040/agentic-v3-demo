import { useState } from 'react';
import type { Character } from '../shared/contracts';
import { imageUrl } from './catalog';

export function CharacterImage({ character, cover = false }: { character: Character; cover?: boolean }) {
  const sources = (cover ? [character.coverUrl, character.thumbnailUrl] : [character.thumbnailUrl, character.coverUrl]).map(imageUrl).filter((url): url is string => Boolean(url));
  const [failed, setFailed] = useState<string[]>([]);
  const url = sources.find(source => !failed.includes(source));
  return url ? <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(current => [...current, url])} /> : <b>{character.initial || character.name.slice(0, 1)}</b>;
}
export function Avatar({ character, user = false, large = false }: { character?: Character; user?: boolean; large?: boolean }) {
  return <span className={`av-avatar ${user ? 'av-user-avatar' : character?.color || 'sage'} ${large ? 'av-avatar-large' : ''}`} aria-hidden="true">{user ? '我' : character ? <CharacterImage character={character} /> : '续'}</span>;
}
