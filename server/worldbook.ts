// Thin transport adapter for the worldbook-service (FlowGPT/worldbook-service).
// The service is an independent Python/PostgreSQL service; this file only binds
// the host to its HTTP contract. Missing service must never break dialogue:
// callers catch WorldbookUnavailable and continue without worldbook context.

export interface WorldbookBookRef { book_id: string; revision: number | null }
export interface WorldbookHistoryMessage { role: 'user' | 'assistant' | 'system'; content: string }
export interface WorldbookCondition { path: string; op?: 'eq' | 'ne' | 'in' | 'exists'; value?: unknown }
export type WorldbookPosition =
  | 'before_character' | 'after_character' | 'author_note_top' | 'author_note_bottom'
  | 'at_depth' | 'before_examples' | 'after_examples' | 'outlet';

/** Entry metadata is the fixed part of the contract; `content` stays free text.
 * Without keys (or constant/required) an entry can never be selected by rules. */
export interface WorldbookEntry {
  id?: string; title?: string; content: string;
  keys?: string[]; secondary_keys?: string[];
  enabled?: boolean; constant?: boolean; required?: boolean; selective?: boolean;
  logic?: 'and_any' | 'and_all' | 'not_any' | 'not_all';
  case_sensitive?: boolean; match_whole_words?: boolean; probability?: number; scan_depth?: number | null;
  exclude_recursion?: boolean; prevent_recursion?: boolean; delay_until_recursion?: number;
  priority?: number; order?: number;
  position?: WorldbookPosition; outlet_name?: string | null; depth?: number;
  role?: 'system' | 'user' | 'assistant';
  kind?: 'lore' | 'character' | 'rule' | 'template' | 'state_update' | 'presentation';
  audience?: string[]; conditions?: WorldbookCondition[]; requires?: string[];
  conflict_key?: string | null; runtime_requirements?: string[];
  source?: Record<string, unknown>;
}
export interface WorldbookBookCreate { name: string; description?: string; entries?: WorldbookEntry[]; metadata?: Record<string, unknown> }

export interface WorldbookSelectRequest {
  query: string;
  books: WorldbookBookRef[];
  history?: WorldbookHistoryMessage[];
  state?: Record<string, unknown>;
  audience?: string;
  strategy?: 'rules' | 'hybrid';
  scan_depth?: number;
  token_budget?: number;
  constant_budget_ratio?: number;
  max_recursion_rounds?: number;
  max_entries?: number;
  seed?: string;
  template_vars?: Record<string, string>;
  placement_capabilities?: { positions: WorldbookPosition[]; outlets?: string[] };
}
export interface WorldbookBlock {
  id: string; book_id: string; revision: number; entry_id: string; title?: string;
  content: string; position: WorldbookPosition; depth?: number; role?: string; order?: number;
  reason?: string; outlet_name?: string | null;
}
export interface WorldbookDecision { entry_id?: string; id?: string; reason: string; [key: string]: unknown }
export interface WorldbookSelectResult {
  context: string; blocks: WorldbookBlock[]; decisions: WorldbookDecision[];
  diagnostics?: unknown; prompt_hash?: string; selection_fingerprint?: string;
  token_count?: number; revision?: number;
}
export interface WorldbookBookSummary { book_id: string; revision: number; name?: string }
export interface WorldbookResolvedBindings { tenant_id: string; entity_id: string; books: WorldbookBookRef[] }

export class WorldbookError extends Error {
  constructor(message: string, public code = 'WORLDBOOK_ERROR', public status = 0) { super(message); this.name = 'WorldbookError'; }
}
/** Service is down or misconfigured. Hosts must degrade, not fail the turn. */
export class WorldbookUnavailable extends WorldbookError {
  constructor(message: string) { super(message, 'WORLDBOOK_UNAVAILABLE', 503); this.name = 'WorldbookUnavailable'; }
}

export interface WorldbookClientOptions {
  baseUrl: string; tenantId: string; timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class WorldbookClient {
  private readonly base: string; private readonly fetchImpl: typeof globalThis.fetch; private readonly timeoutMs: number;
  constructor(private readonly options: WorldbookClientOptions) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 3000;
  }
  private qs(extra: Record<string, string | undefined> = {}): string {
    const params = new URLSearchParams({ tenant_id: this.options.tenantId });
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, value);
    return '?' + params.toString();
  }
  private async request<T>(method: string, path: string, body?: unknown, extra?: Record<string, string | undefined>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('worldbook timeout')), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.base + path + this.qs(extra), {
        method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        let code = 'WORLDBOOK_ERROR', message = `worldbook ${response.status}`;
        try { const parsed = JSON.parse(text); code = parsed?.error?.code ?? code; message = parsed?.error?.message ?? message; } catch { /* non-JSON error body */ }
        if (response.status >= 500 || response.status === 503) throw new WorldbookUnavailable(message);
        throw new WorldbookError(message, code, response.status);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      if (error instanceof WorldbookError) throw error;
      throw new WorldbookUnavailable(error instanceof Error ? error.message : 'worldbook unavailable');
    } finally { clearTimeout(timer); }
  }

  /** Which books this entity pins. Resolve once per turn; reuse for retries. */
  async resolve(entityId: string): Promise<WorldbookResolvedBindings> {
    return this.request<WorldbookResolvedBindings>('GET', '/v1/entity-bindings/resolve', undefined, { entity_id: entityId });
  }
  /** Select this turn's context. `query` should include current place and entities;
   * the final player message stays verbatim (see README call order). */
  async select(body: WorldbookSelectRequest): Promise<WorldbookSelectResult> {
    return this.request<WorldbookSelectResult>('POST', '/v1/context/select', body);
  }
  async getBook(bookId: string, revision?: number): Promise<unknown> {
    return this.request('GET', `/v1/books/${encodeURIComponent(bookId)}`, undefined, revision === undefined ? {} : { revision: String(revision) });
  }
  async listBooks(limit = 20, cursor?: string): Promise<{ items: WorldbookBookSummary[]; next_cursor?: string | null }> {
    return this.request('GET', '/v1/books', undefined, { limit: String(limit), ...(cursor ? { cursor } : {}) });
  }
  async createBook(book: WorldbookBookCreate, idempotencyKey: string): Promise<{ books: Array<{ book_id: string; revision: number }>; replayed?: boolean }> {
    return this.request('POST', '/v1/books', book, { 'Idempotency-Key': idempotencyKey } as unknown as Record<string, string>);
  }
  /** Full-replacement new revision; `expected_revision` guards concurrent edits. */
  async publishRevision(bookId: string, book: WorldbookBookCreate & { expected_revision: number }): Promise<{ revision: number }> {
    return this.request('POST', `/v1/books/${encodeURIComponent(bookId)}/revisions`, book);
  }
}
