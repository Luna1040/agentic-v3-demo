import type { Character, Session, WorldView } from '../shared/contracts';

export const lastSessionKey = (draftKeyPrefix: string): string => draftKeyPrefix + 'last-opened-session';

export function resolveInitialSession(sessions: Session[], explicitId?: string, rememberedId?: string | null): string | null {
  // Explicit host navigation wins. Stored browser state is only trusted after bootstrap authorizes it.
  if (explicitId) return explicitId;
  return sessions.find(session => session.id === rememberedId)?.id || sessions[0]?.id || null;
}

export function sessionPresentation(session: Session, worlds: WorldView[] = []) {
  const created = new Date(session.createdAt);
  const date = Number.isNaN(created.getTime()) ? '日期未记录' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(created);
  const shortId = session.id.slice(-6);
  const worldTitle = worlds.find(world => world.id === session.worldId)?.title || '故事';
  const worldLabel = `世界 #${session.worldId.slice(-6)} · ${worldTitle}`;
  return { worldLabel, stamp: `${date} · #${shortId}`, option: `#${shortId} · ${session.title} · ${worldLabel} · ${date}` };
}

export function filterSessions(sessions: Session[], characters: Character[], worlds: WorldView[], query: string): Session[] {
  const needle = query.trim().toLocaleLowerCase();
  return sessions.filter(session => `${sessionPresentation(session, worlds).option} ${characters.find(character => character.id === session.characterId)?.name || ''}`.toLocaleLowerCase().includes(needle));
}
