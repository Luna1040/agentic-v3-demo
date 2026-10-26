import type { ArcProvenance, CharacterView } from './living-world.ts';

/** Source verification does not certify the interpretation in the summary. */
export function characterView(state: Record<string, unknown>): CharacterView | undefined {
  if (typeof state.arc !== 'string' || !state.arc.trim()) return undefined;
  const raw = state.arcProvenance;
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const verified = source.kind === 'character_view' && source.status === 'source_verified'
    && typeof source.turnId === 'string' && typeof source.quote === 'string' && source.quote.trim()
    && ['user', 'actor', 'pulse'].includes(String(source.source))
    && (source.source === 'user' || typeof source.characterId === 'string');
  const provenance: ArcProvenance = verified ? {
    kind: 'character_view', status: 'source_verified', turnId: source.turnId as string,
    source: source.source as 'user' | 'actor' | 'pulse', quote: source.quote as string,
    ...(typeof source.characterId === 'string' ? { characterId: source.characterId } : {}),
  } : { kind: 'character_view', status: 'legacy_unverified', ...(typeof source.turnId === 'string' ? { turnId: source.turnId } : {}) };
  const { kind: _kind, ...detail } = provenance;
  return { kind: 'character_view', summary: state.arc, provenance: detail };
}
