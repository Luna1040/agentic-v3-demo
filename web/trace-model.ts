import type { AgentCallRecord, AgentTestResult } from '../shared/contracts';
export interface CallNode { call: AgentCallRecord; children: CallNode[] }
/** Parent links are evidence from the server; missing/cyclic parents stay visible. */
export function callForest(calls: AgentCallRecord[]): CallNode[] {
  const nodes = new Map(calls.map(call => [call.id, { call, children: [] as CallNode[] }]));
  const roots: CallNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.call.parentId ? nodes.get(node.call.parentId) : undefined;
    const ancestors = new Set([node.call.id]);
    let cursor = parent;
    while (cursor && !ancestors.has(cursor.call.id)) { ancestors.add(cursor.call.id); cursor = cursor.call.parentId ? nodes.get(cursor.call.parentId) : undefined; }
    if (parent && parent.call.attemptId === node.call.attemptId && !cursor) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
export function displayValue(value: unknown): string { return value === undefined ? '未返回' : typeof value === 'string' ? value : JSON.stringify(value, null, 2); }

export function callCharacterLabel(call: AgentCallRecord): string | undefined {
  if (call.agent !== 'actor' || !call.input || typeof call.input !== 'object') return undefined;
  const character = (call.input as Record<string, unknown>).character;
  if (!character || typeof character !== 'object') return undefined;
  const { name, id } = character as Record<string, unknown>;
  return typeof name === 'string' && name.trim() ? `${name}${typeof id === 'string' && id ? ` · #${id.slice(-6)}` : ''}` : undefined;
}

/** Preserve the response error even when execution failed before a call record existed. */
export function testFailureSummary(result: Pick<AgentTestResult, 'output' | 'calls'>): string | undefined {
  const output = result.output && typeof result.output === 'object' ? result.output as Record<string, unknown> : undefined;
  const error = output?.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return [value.code, value.message].filter(item => typeof item === 'string' && item).join(' · ') || '试跑未完成，请查看实际输出与调用记录。';
  }
  const failed = [...result.calls].reverse().find(call => call.status === 'failed' || call.status === 'cancelled');
  return failed ? failed.error ? `${failed.error.code} · ${failed.error.message}` : '试跑未完成，请查看调用记录。' : undefined;
}
