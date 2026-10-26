import type { AgentKey } from '../shared/contracts';

export type PromptDrafts = Partial<Record<AgentKey, string>>;
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
const agents: AgentKey[] = ['main', 'actor', 'updater', 'opening', 'pulse', 'arbiter'];
export const promptDraftKey = (namespace?: string): string | null => namespace?.trim() ? `${namespace}prompt-drafts:v1` : null;
function browserStorage(): DraftStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function promptValues(value: unknown): PromptDrafts {
  const result: PromptDrafts = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of agents) {
    const text = (value as Record<string, unknown>)[key];
    if (typeof text === 'string') result[key] = text;
  }
  return result;
}
export function readPromptDrafts(namespace?: string, storage = browserStorage()): PromptDrafts {
  const key = promptDraftKey(namespace);
  if (!key || !storage) return {};
  try { return promptValues(JSON.parse(storage.getItem(key) || '{}')); } catch { return {}; }
}
export function writePromptDrafts(namespace: string | undefined, drafts: PromptDrafts, storage = browserStorage()): void {
  const key = promptDraftKey(namespace);
  if (!key || !storage) return;
  // Only prompt text is persisted; never serialize the client, headers or provider configuration.
  try { storage.setItem(key, JSON.stringify(promptValues(drafts))); } catch { /* Storage restrictions must not prevent editing. */ }
}
