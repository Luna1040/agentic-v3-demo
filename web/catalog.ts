import type { Character, Session } from '../shared/contracts';

export function filterCharacters(characters: Character[], query: string, language: string, includeSamples: boolean): Character[] {
  const needle = query.trim().toLocaleLowerCase();
  return characters.filter(character => (includeSamples || character.source !== 'sample')
    && (!language || character.language === language)
    && (!needle || `${character.name} ${character.subtitle} ${character.description}`.toLocaleLowerCase().includes(needle)));
}
export function recentCharacters(characters: Character[], sessions: Session[], activeId?: string): Character[] {
  const ids = [...new Set([...(activeId ? [activeId] : []), ...[...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(session => session.characterId)])];
  return ids.flatMap(id => { const character = characters.find(item => item.id === id); return character ? [character] : []; }).slice(0, 6);
}
export function imageUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  // Only ordinary hosted media and same-origin asset paths; no executable schemes.
  if (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)) return value;
  return undefined;
}
