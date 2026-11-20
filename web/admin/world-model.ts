import type { WorldView } from '../../shared/contracts';

export function worldBackgroundStatus(world?: WorldView) {
  const pendingTurns = world?.settlementBacklog?.pendingTurns ?? world?.settlements?.filter(job => job.status === 'pending' || job.status === 'running').length ?? 0;
  const failedTurns = world?.settlementBacklog?.failedTurns ?? world?.settlements?.filter(job => job.status === 'failed').length ?? 0;
  const directorPending = world?.director?.status === 'pending' || world?.director?.status === 'running';
  return { pendingTurns, failedTurns, directorPending, polling: pendingTurns > 0 || directorPending };
}
export function worldRecordCounts(world?: WorldView): { quotations: number; interactions: number } {
  return {
    quotations: world?.events.filter(event => event.status === 'active' && event.evidence?.source === 'user' && event.evidence.turnId).length || 0,
    interactions: new Set(world?.episodes?.filter(episode => episode.kind === 'chat' || episode.kind === 'opening').map(episode => episode.turnId) || []).size,
  };
}
