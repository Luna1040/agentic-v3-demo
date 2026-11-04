// Worldbook transport is provided by the shared harness SDK and re-exported from
// the harness build: `WorldbookClient` from apps/agentic-v3/index.ts
// (backed by packages/sdk/src/worldbook-client.ts). This file intentionally keeps
// only the host-side type contract so the app never maintains a second HTTP client.
// Wiring (select/inject/revision publish) happens when worldbook is enabled.

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

/** Service is down or misconfigured. Hosts must degrade, not fail the turn. */
export class WorldbookUnavailable extends Error {
  constructor(message: string, public readonly code = 'WORLDBOOK_UNAVAILABLE') { super(message); this.name = 'WorldbookUnavailable'; }
}
