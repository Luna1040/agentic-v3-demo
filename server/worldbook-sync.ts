// Deterministic projection from the host's world state into worldbook entries.
// The point: most entries do not need model generation. Names, aliases, assets and
// current state already exist as structured entities, so the host can rebuild a book
// revision each time world state changes. Only author-side lore that never appears in
// state (hidden backgrounds, rules) should ever be model-authored.
import type { WorldEntity } from '../shared/living-world.ts';
import type { WorldbookBookCreate, WorldbookEntry } from './worldbook.ts';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Keys must include every plausible name the player or an Actor may use. */
export function entityKeys(entity: WorldEntity): string[] {
  const keys = new Set<string>();
  if (entity.name) keys.add(entity.name);
  const state = entity.state as Record<string, unknown> | undefined;
  const aliases = state?.narrativeAliases;
  if (Array.isArray(aliases)) for (const alias of aliases) if (typeof alias === 'string' && alias.trim()) keys.add(alias.trim());
  const narrativeName = text(state?.narrativeName);
  if (narrativeName) keys.add(narrativeName);
  return [...keys];
}

const audience = (entity: WorldEntity): string[] => entity.knownByCharacterIds?.length ? [...entity.knownByCharacterIds] : ['actor'];

function stateLine(entity: WorldEntity): string {
  const state = (entity.state ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (entity.kind === 'item') {
    const status = text(state.status); if (status) parts.push(`状态：${status}`);
    const holder = text(state.holderCharacterId); if (holder) parts.push(`持有者：${holder === '$player' ? '玩家' : holder}`);
    const location = text(state.locationId); if (location) parts.push(`所在地点：${location}`);
  }
  if (entity.kind === 'quest') {
    const status = text(state.status); if (status) parts.push(`状态：${status}`);
    const owner = text(state.ownerCharacterId); if (owner) parts.push(`负责人：${owner === '$player' ? '玩家' : owner}`);
    const next = text((state.progression as Record<string, unknown> | undefined)?.nextStep); if (next) parts.push(`下一步：${next}`);
    const due = text(state.dueAt); if (due) parts.push(`期限：${due}`);
  }
  if (entity.kind === 'location') {
    const connected = state.connectedTo;
    if (Array.isArray(connected) && connected.length) parts.push(`连通地点：${connected.filter(v => typeof v === 'string').join('、')}`);
  }
  return parts.join('；');
}

function baseEntry(entity: WorldEntity): WorldbookEntry {
  const stateText = stateLine(entity);
  const body = [entity.description, stateText].filter(Boolean).join('\n');
  return {
    id: `entity:${entity.id}`,
    title: entity.name,
    content: `${entity.name}\n${body}`.trim(),
    keys: entityKeys(entity),
    kind: entity.kind === 'npc' ? 'character' : entity.kind === 'location' ? 'lore' : 'state_update',
    // Dynamic state entries should follow the latest revision rather than persist forever.
    constant: false,
    // Facts that already drive the scene should win ties when several entries match.
    priority: entity.kind === 'location' ? 60 : entity.kind === 'npc' ? 50 : entity.kind === 'quest' ? 40 : 30,
    order: 0,
    position: 'before_character',
    audience: audience(entity),
    source: { kind: 'host-entity', entityId: entity.id, entityKind: entity.kind },
  };
}

/** One deterministic entry per world entity. Deduplicated by id. */
export function worldEntitiesToEntries(entities: WorldEntity[]): WorldbookEntry[] {
  const seen = new Set<string>();
  const entries: WorldbookEntry[] = [];
  for (const entity of entities) {
    if (!entity?.id || seen.has(entity.id)) continue;
    seen.add(entity.id);
    entries.push(baseEntry(entity));
  }
  return entries;
}

/** Whole-book projection used for create/revision. Name carries the world title. */
export function worldToBook(world: { title?: string; entities?: WorldEntity[] }, name: string): WorldbookBookCreate {
  return {
    name,
    description: world.title ? `世界：${world.title}` : '宿主世界状态投影',
    entries: worldEntitiesToEntries((world.entities ?? []) as WorldEntity[]),
    metadata: { kind: 'host-world-projection', version: 1 },
  };
}
