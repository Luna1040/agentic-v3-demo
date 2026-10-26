import type { StoryEvent } from '../shared/contracts';

export function memoryAction(event: StoryEvent): 'retracted' | 'active' | null {
  if (event.status === 'active' || event.status === 'unverified') return 'retracted';
  if (event.status === 'retracted' && event.evidence?.source === 'user' && event.evidence.turnId) return 'active';
  return null;
}

export function memoryLabel(event: StoryEvent): string {
  if (event.status === 'retracted') return '已停用';
  if (event.status === 'active') return event.evidence?.source === 'user' ? '玩家原话' : '有效记录 · 来源待核对';
  return '旧记录待核对';
}
