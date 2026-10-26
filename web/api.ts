import type { PlayerProfile, AgentKey, AgentPromptConfig, AgentTestResult, Bootstrap, Message, RuntimeAuditView, SceneState, SessionDetail, TurnEvent, TurnTrace, TurnView, WorldView } from '../shared/contracts';

export class ApiError extends Error {
  constructor(message: string, public code = 'REQUEST_FAILED', public status = 0) { super(message); this.name = 'ApiError'; }
}
export class StreamInterruptedError extends Error {
  constructor(public turnId: string | null) { super('连接中断，正在确认消息是否已保存。'); this.name = 'StreamInterruptedError'; }
}
export interface RequestOptions { signal?: AbortSignal }
export interface RuntimeAuditOptions extends RequestOptions { captureId?: string; includeCalls?: boolean }
export interface CreateSessionInput { playerProfileId?: string | null; characterId: string; worldId?: string; dynamicOpening?: boolean; scene?: SceneState; expectedRevision?: number }
export interface LegacyAgentCatalogEntry { key: string; name: string; responsibility: string; enabled: boolean; currentVersion: string | number | null; prompt: string; versions: { version: string | number; status: string; prompt: string; createdAt: string }[]; executionKeys: AgentKey[]; implementation: string; configuration?: { promptKey?: unknown; modelRouteId?: unknown; runtimeLimits?: unknown; config?: unknown } }
export interface ApiClient {
  /** Non-secret owner/workspace storage scope supplied by the embedding host. */
  readonly storageNamespace?: string;
  playerProfiles(options?: RequestOptions): Promise<{profiles: PlayerProfile[]}>;
  savePlayerProfile(id: string|null,input: {name:string;persona:string;expectedVersion?:number},options?: RequestOptions): Promise<PlayerProfile>;
  deletePlayerProfile(id:string,expectedVersion:number,options?: RequestOptions): Promise<void>;
  setPlayerProfile(worldId:string,input:{profileId:string|null;expectedRevision:number},options?:RequestOptions):Promise<WorldView>;
  bootstrap(options?: RequestOptions): Promise<Bootstrap>;
  createSession(input: CreateSessionInput, options?: RequestOptions): Promise<SessionDetail>;
  world(id: string, options?: RequestOptions): Promise<WorldView>;
  runtimeAudit(id: string, options?: RuntimeAuditOptions): Promise<RuntimeAuditView>;
  captureRuntimeAudit(id: string, input: { expectedTurns: number }, options?: RequestOptions): Promise<RuntimeAuditView>;
  retrySettlements(id: string, options?: RequestOptions): Promise<WorldView>;
  updateClock(id: string, input: { expectedRevision: number; mode: 'paused' | 'quiet' | 'active'; rate: number }, options?: RequestOptions): Promise<WorldView>;
  session(id: string, options?: RequestOptions): Promise<SessionDetail>;
  messages(id: string, before: string, options?: RequestOptions): Promise<{ messages: Message[]; hasMore: boolean; nextBefore: string | null }>;
  turn(id: string, options?: RequestOptions): Promise<TurnView>;
  cancel(id: string, options?: RequestOptions): Promise<TurnView>;
  trace(id: string, options?: RequestOptions): Promise<TurnTrace>;
  updateScene(id: string, input: { expectedRevision: number; scene: SceneState; sessionId?: string }, options?: RequestOptions): Promise<WorldView>;
  updateMemory(worldId: string, eventId: string, input: { expectedRevision: number; status: 'retracted' | 'active' }, options?: RequestOptions): Promise<WorldView>;
  prompts(options?: RequestOptions): Promise<{ prompts: AgentPromptConfig[] }>;
  agentCatalog(options?: RequestOptions): Promise<{ agents: LegacyAgentCatalogEntry[] }>;
  savePrompt(key: AgentKey, input: { content: string; expectedVersion: number }, options?: RequestOptions): Promise<AgentPromptConfig>;
  testAgent(key: AgentKey, input: { sessionId: string; userText: string; prompt: string; assistantText?: string }, options?: RequestOptions): Promise<AgentTestResult>;
  stream(id: string, input: { clientTurnId: string; content: string }, onEvent: (event: TurnEvent) => void, options?: RequestOptions): Promise<void>;
  opening(id: string, input: { clientTurnId: string }, onEvent: (event: TurnEvent) => void, options?: RequestOptions): Promise<void>;
}
export interface ApiClientOptions {
  storageNamespace?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
}
const terminal = new Set(['committed', 'failed', 'cancelled']);
export function parseEvent(block: string): TurnEvent | null {
  const lines = block.split(/\r?\n/);
  const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!payload) return null;
  const value = JSON.parse(payload) as TurnEvent;
  if (!value || typeof value !== 'object' || typeof value.turnId !== 'string'
      || !['accepted', 'delta', 'phase', 'committed', 'failed', 'cancelled'].includes(value.type)
      || (event && event !== value.type)) throw new ApiError('服务器返回了无法识别的消息事件。', 'INVALID_EVENT');
  return value;
}

export function createApiClient({ baseUrl = '/api', fetch: fetchImpl = globalThis.fetch.bind(globalThis), getHeaders, storageNamespace }: ApiClientOptions = {}): ApiClient {
  const base = baseUrl.replace(/\/$/, '');
  async function request(path: string, { signal }: RequestOptions = {}, method = 'GET', body?: unknown, stream = false) {
    const headers = new Headers(await getHeaders?.());
    headers.set('Accept', stream ? 'text/event-stream' : 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetchImpl(base + path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(data.error?.message || data.message || `请求失败 (${response.status})`, data.error?.code, response.status);
    }
    return response;
  }
  async function json<T>(path: string, options?: RequestOptions, method?: string, body?: unknown): Promise<T> {
    return (await request(path, options, method, body)).json();
  }
  async function stream(path: string, input: unknown, onEvent: (event: TurnEvent) => void, options: RequestOptions = {}) {
    const response = await request(path, options, 'POST', input, true);
    return readTurnStream(response, onEvent);
  }
  return {
    storageNamespace,
    playerProfiles: options => json('/player-profiles',options),
    savePlayerProfile: (id,input,options) => json('/player-profiles'+(id?'/'+encodeURIComponent(id):''),options,id?'PUT':'POST',input),
    deletePlayerProfile: async (id,expectedVersion,options) => { await request('/player-profiles/'+encodeURIComponent(id),options,'DELETE',{expectedVersion}); },
    setPlayerProfile: (worldId,input,options) => json('/worlds/'+encodeURIComponent(worldId)+'/player-profile',options,'PATCH',input),
    bootstrap: options => json('/bootstrap', options),
    createSession: (input, options) => json('/sessions', options, 'POST', input),
    world: (id, options) => json('/worlds/' + encodeURIComponent(id), options),
    runtimeAudit: (id, options) => {
      const query = new URLSearchParams();
      if (options?.captureId) query.set('captureId', options.captureId);
      if (options?.includeCalls) query.set('includeCalls', '1');
      return json('/worlds/' + encodeURIComponent(id) + '/runtime-audit' + (query.size ? '?' + query : ''), options);
    },
    captureRuntimeAudit: (id, input, options) => json('/worlds/' + encodeURIComponent(id) + '/runtime-audit/capture', options, 'POST', input),
    retrySettlements: (id, options) => json('/worlds/' + encodeURIComponent(id) + '/settlements/retry', options, 'POST', {}),
    updateClock: (id, input, options) => json(`/worlds/${encodeURIComponent(id)}/clock`, options, 'PATCH', input),
    session: (id, options) => json('/sessions/' + encodeURIComponent(id), options),
    messages: (id, before, options) => json(`/sessions/${encodeURIComponent(id)}/messages?before=${encodeURIComponent(before)}`, options),
    turn: (id, options) => json('/turns/' + encodeURIComponent(id), options),
    cancel: (id, options) => json('/turns/' + encodeURIComponent(id) + '/cancel', options, 'POST', {}),
    trace: (id, options) => json('/turns/' + encodeURIComponent(id) + '/trace', options),
    updateScene: (id, input, options) => json('/worlds/' + encodeURIComponent(id) + '/scene', options, 'PATCH', input),
    updateMemory: (worldId, eventId, input, options) => json(`/worlds/${encodeURIComponent(worldId)}/events/${encodeURIComponent(eventId)}`, options, 'PATCH', input),
    prompts: options => json('/dev/prompts', options),
    agentCatalog: options => json('/dev/agent-catalog', options),
    savePrompt: (key, input, options) => json('/dev/prompts/' + encodeURIComponent(key), options, 'PUT', input),
    testAgent: (key, input, options) => json('/dev/agents/' + encodeURIComponent(key) + '/test', options, 'POST', input),
    stream: (id, input, onEvent, options) => stream(`/sessions/${encodeURIComponent(id)}/turns`, input, onEvent, options),
    opening: (id, input, onEvent, options) => stream(`/sessions/${encodeURIComponent(id)}/opening`, input, onEvent, options),
  };
}
export async function readTurnStream(response: Response, onEvent: (event: TurnEvent) => void): Promise<void> {
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new ApiError('服务器没有返回消息流。', 'INVALID_STREAM');
      const reader = response.body?.getReader();
      if (!reader) throw new StreamInterruptedError(null);
      const decoder = new TextDecoder();
      let buffer = '', turnId: string | null = null, ended = false;
      function dispatch(block: string) {
        const event = parseEvent(block);
        if (!event) return;
        if (turnId && event.turnId !== turnId) throw new ApiError('消息流的轮次不一致。', 'TURN_MISMATCH');
        if (ended) throw new ApiError('消息流在完成后仍返回事件。', 'EVENT_AFTER_TERMINAL');
        turnId = event.turnId;
        ended = terminal.has(event.type);
        onEvent(event);
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || '';
          for (const block of blocks) dispatch(block);
          if (done) break;
        }
        if (buffer.trim()) {
          try { dispatch(buffer); }
          catch (error) {
            // A connection may end in the middle of JSON, before its event separator.
            // Keep the accepted turn identity so the caller can recover its saved result.
            if (error instanceof SyntaxError) throw new StreamInterruptedError(turnId);
            throw error;
          }
        }
        if (!ended) throw new StreamInterruptedError(turnId);
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
