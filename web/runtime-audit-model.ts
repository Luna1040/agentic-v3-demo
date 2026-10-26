import type { RuntimeAuditView } from '../shared/contracts';

export type AuditEvent = RuntimeAuditView['events'][number];
export const auditEventLabels: Record<string, string> = {
  capture_started: '开始录制', queued: '进入归档队列', claimed: '领取归档批次', result_saved: '提取结果已保存',
  wait: '等待前序提交', rebased: '版本冲突 · 重新对齐', split: '拆分批次', failed: '归档失败', committed: '归档已提交',
  director_requested: '请求主线规划', director_superseded: '旧规划已被新请求替代', director_claimed: '开始主线规划',
  director_completed: '主线规划已保存', director_failed: '主线规划失败',
};
export const foregroundLabels: Record<string, string> = { running: '正在回复', committed: '回复已保存', failed: '回复失败', cancelled: '回复已停止' };
export const settlementLabels: Record<string, string> = { pending: '排队中', running: '整理中', completed: '归档完成', failed: '归档失败 · 原文保留' };

export function auditObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function auditValue(value: unknown): string {
  return value === undefined ? '未记录' : value === null ? '空' : typeof value === 'string' ? value : JSON.stringify(value);
}
export function auditTurnIds(event: AuditEvent): string[] {
  const ids = event.data.memberTurnIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : event.turnId ? [event.turnId] : [];
}
export function auditBatches(view: RuntimeAuditView) {
  // Only claimed records prove a shared extraction request. A backlog count does not.
  const groups = new Map<string, { id: string; turnIds: string[]; attempts: number; event: AuditEvent; memberAttempts: Map<string, Set<string>> }>();
  for (const event of view.events) {
    if (event.kind !== 'claimed' || !event.batchId || event.data.lane === 'director') continue;
    const previous = groups.get(event.batchId);
    const memberAttempts = previous?.memberAttempts ?? new Map<string, Set<string>>();
    const member = event.turnId ?? 'batch';
    const attempts = memberAttempts.get(member) ?? new Set<string>();
    attempts.add(event.attemptId ?? String(event.data.attemptNumber ?? 'unknown'));
    memberAttempts.set(member, attempts);
    // One claimed event is emitted for each member. Three members do not mean three attempts.
    groups.set(event.batchId, { id: event.batchId, turnIds: auditTurnIds(event), attempts: Math.max(...[...memberAttempts.values()].map(attempts => attempts.size)), event, memberAttempts });
  }
  return [...groups.values()];
}
export interface AuditFieldChange { path: string; before: unknown; after: unknown }
export function auditFieldChanges(before: unknown, after: unknown, prefix = ''): AuditFieldChange[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const left = auditObject(before), right = auditObject(after);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  if (keys.length) return keys.flatMap(key => auditFieldChanges(left[key], right[key], prefix ? prefix + '.' + key : key));
  return [{ path: prefix || '值', before, after }];
}
export function auditRowChanges(event: AuditEvent, field: 'entityChanges' | 'eventChanges') {
  const rows = event.data[field];
  return Array.isArray(rows) ? rows.map(value => auditObject(value)).map(row => ({
    id: String(row.id ?? ''), before: auditObject(row.before), after: auditObject(row.after),
    changes: auditFieldChanges(row.before, row.after),
  })) : [];
}
export function auditFieldSource(view: RuntimeAuditView, entityId: string, path: string, kind: 'entity' | 'event' | 'scene' = 'entity', current?: { value: unknown }): string | null {
  for (let i = view.events.length - 1; i >= 0; i--) {
    const event = view.events[i];
    if (event.kind !== 'committed') continue;
    if (kind === 'scene') {
      const scene = auditObject(event.data.scene);
      const change = scene.disposition === 'applied' ? auditFieldChanges(scene.before, scene.after).find(change => change.path === path) : undefined;
      if (change) return current && JSON.stringify(current.value) !== JSON.stringify(change.after) ? null : event.turnId ?? null;
      continue;
    }
    const row = auditRowChanges(event, kind === 'event' ? 'eventChanges' : 'entityChanges').find(row => row.id === entityId);
    const change = row?.changes.find(change => change.path === path);
    if (change) return current && JSON.stringify(current.value) !== JSON.stringify(change.after) ? null : event.turnId ?? (String(row?.after.sourceTurnId ?? '') || null);
  }
  return null;
}
