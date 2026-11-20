import { storyTimeLabel } from '../time-model';

export function actorRecallSummary(input: unknown): { count: number; related: number; sessions: number; time: string; records: Array<{ turnId: string; sessionId: string; time: string; reason: string; matches: string[] }> } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const packet = input as Record<string, unknown>;
  if (!packet.character || !Array.isArray(packet.episodes)) return undefined;
  const episodes = packet.episodes.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
  const world = packet.worldContext as { story?: { now?: unknown }; temporal?: { story?: unknown } } | undefined;
  const records = episodes.map(episode => {
    const retrieval = episode.retrieval as { reason?: unknown; matches?: unknown } | undefined;
    return { turnId: String(episode.turnId ?? ''), sessionId: String(episode.sessionId ?? ''), time: storyTimeLabel(episode.storyTime), reason: retrieval?.reason === 'related' ? '相关经历' : retrieval?.reason === 'recent' ? '近期经历' : '未标注选择原因', matches: Array.isArray(retrieval?.matches) ? retrieval.matches.filter((x): x is string => typeof x === 'string') : [] };
  });
  return { count: records.length, related: episodes.filter(e => (e.retrieval as { reason?: string } | undefined)?.reason === 'related').length, sessions: new Set(records.map(e => e.sessionId).filter(Boolean)).size, time: storyTimeLabel(world?.story?.now ?? world?.temporal?.story), records };
}
