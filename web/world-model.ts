import type { Character, Message, WorldEntity, WorldView } from '../shared/contracts';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
export function worldBackgroundStatus(world?: WorldView) {
  const pendingTurns = world?.settlementBacklog?.pendingTurns ?? 0;
  const failedTurns = world?.settlementBacklog?.failedTurns ?? 0;
  return { pendingTurns, failedTurns, polling: pendingTurns > 0 };
}
export function entityCharacter(entity: WorldEntity, templates: Character[] = []): Character {
  const template = templates.find(character => character.id === entity.id);
  const color = entity.state.color;
  return { ...template, id: entity.id, name: entity.name, description: entity.description, subtitle: template?.subtitle || (template || entity.state.origin === 'seed' ? '故事的起点' : '在这个故事中结识'), initial: text(entity.state.initial) || entity.name.slice(0, 1), color: color === 'blue' || color === 'peach' || color === 'sage' ? color : template?.color || 'sage', greeting: text(entity.state.greeting), source: template?.source || 'generated' };
}
export function worldCharacters(world: WorldView | undefined, templates: Character[], focusId?: string): Character[] {
  if (!world) return [];
  const npcs = world.entities?.filter(entity => entity.kind === 'npc') || [];
  if (npcs.length) return npcs.map(entity => entityCharacter(entity, templates));
  // Legacy worlds can retain their existing participants; the global catalog is never an expansion roster.
  const ids = new Set([focusId, ...world.scene?.presentCharacterIds || []].filter(Boolean));
  return templates.filter(character => ids.has(character.id));
}
export const entityKinds = { npc: '角色', location: '地点', item: '物品', quest: '任务', faction: '组织' };
export const questStatus = (value: unknown): string => ({ proposed: '待开展', active: '进行中', completed: '已完成', failed: '未完成' }[String(value)] || '尚未记录状态');
export function messageCharacter(message: Message, characters: Character[], fallback?: Character): Character | undefined {
  if (!message.characterId) return fallback;
  return characters.find(character => character.id === message.characterId) || { id: message.characterId, name: message.characterName || '新登场角色', subtitle: '这一幕的新人物', description: '', initial: (message.characterName || '角').slice(0, 1), color: 'sage', greeting: '', source: 'generated' };
}
