/** A story clock is never inferred from a database timestamp or elapsed milliseconds. */
export function storyTimeLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return '剧情时间未确定';
  const time = value as Record<string, unknown>;
  const day = typeof time.day === 'number' && Number.isSafeInteger(time.day) && time.day >= 1 ? `故事第 ${time.day} 天` : '';
  if (time.precision === 'unknown') return '剧情时间未确定';
  if (time.precision === 'minute' && typeof time.minute === 'number' && Number.isSafeInteger(time.minute) && time.minute >= 0 && time.minute < 1440) {
    return `${day || '故事日期未确定'} · ${String(Math.floor(time.minute / 60)).padStart(2, '0')}:${String(time.minute % 60).padStart(2, '0')}`;
  }
  const periods: Record<string, string> = { dawn: '黎明', morning: '上午', noon: '中午', afternoon: '下午', evening: '傍晚', night: '夜间' };
  const period = time.precision === 'period' && typeof time.period === 'string' ? periods[time.period] : undefined;
  return [day, period].filter(Boolean).join(' · ') || '剧情时间未确定';
}

export function recordedTimeLabel(value: unknown, timeZone?: string): string {
  if (typeof value !== 'string' || !value.trim()) return '记录时间未确定';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '记录时间未确定';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone }).format(date);
}

export function localTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone; }

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
