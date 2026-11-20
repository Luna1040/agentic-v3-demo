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
