import type { AgentKey, AgentPromptConfig, AgentTestResult, RuntimeAuditView, TurnTrace } from '../../shared/contracts';
import { createApiClient, type ApiClient } from '../api';
import { createApiTransport, type ApiClientOptions, type RequestOptions } from '../http';
export { ApiError } from '../http';

export interface RuntimeAuditOptions extends RequestOptions { captureId?: string; includeCalls?: boolean }
export interface LegacyAgentCatalogEntry { key: string; name: string; responsibility: string; enabled: boolean; currentVersion: string | number | null; prompt: string; versions: { version: string | number; status: string; prompt: string; createdAt: string }[]; executionKeys: AgentKey[]; dispatchKey?: string; implementation: string; configuration?: { promptKey?: unknown; modelRouteId?: unknown; runtimeLimits?: unknown; config?: unknown } }
export interface AdminApiClient extends ApiClient {
  runtimeAudit(id: string, options?: RuntimeAuditOptions): Promise<RuntimeAuditView>;
  captureRuntimeAudit(id: string, input: { expectedTurns: number }, options?: RequestOptions): Promise<RuntimeAuditView>;
  trace(id: string, options?: RequestOptions): Promise<TurnTrace>;
  prompts(options?: RequestOptions): Promise<{ prompts: AgentPromptConfig[] }>;
  agentCatalog(options?: RequestOptions): Promise<{ agents: LegacyAgentCatalogEntry[] }>;
  savePrompt(key: AgentKey, input: { content: string; expectedVersion: number }, options?: RequestOptions): Promise<AgentPromptConfig>;
  testAgent(key: AgentKey, input: { sessionId: string; userText: string; prompt: string; assistantText?: string }, options?: RequestOptions): Promise<AgentTestResult>;
}

export function createAdminApiClient(options: ApiClientOptions = {}): AdminApiClient {
  const { json } = createApiTransport(options);
  return {
    ...createApiClient(options),
    runtimeAudit: (id, options) => {
      const query = new URLSearchParams();
      if (options?.captureId) query.set('captureId', options.captureId);
      if (options?.includeCalls) query.set('includeCalls', '1');
      return json('/worlds/' + encodeURIComponent(id) + '/runtime-audit' + (query.size ? '?' + query : ''), options);
    },
    captureRuntimeAudit: (id, input, options) => json('/worlds/' + encodeURIComponent(id) + '/runtime-audit/capture', options, 'POST', input),
    trace: (id, options) => json('/turns/' + encodeURIComponent(id) + '/trace', options),
    prompts: options => json('/dev/prompts', options),
    agentCatalog: options => json('/dev/agent-catalog', options),
    savePrompt: (key, input, options) => json('/dev/prompts/' + encodeURIComponent(key), options, 'PUT', input),
    testAgent: (key, input, options) => json('/dev/agents/' + encodeURIComponent(key) + '/test', options, 'POST', input),
  };
}
