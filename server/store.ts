import { loadMemorySnapshot, loadContextSnapshot, knownEntityRows, dependencyVersions, dependenciesMatch, type ContextSnapshot, type TurnEvidence, type CommitContext } from './context-snapshot.ts';
import { profiles, profile, saveProfile, validateProfileVersion } from './player-profiles.ts';
import { readPreparedDirection, requestDirection, applyStoryProgress, invalidateDirection, pauseDirectionForTurn } from './director.ts';
import { resolveRoleplayTemplate } from '../shared/roleplay-template.ts';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AgentCallRecord, AgentKey, Character, Message, PromptVersion, SceneState, Session, SessionDetail, StoryEvent, TurnTrace, TurnView, WorldView } from '../shared/contracts.ts';
import { MEMORY_POLICY, ServiceError, validateChanges, type ActorCheckpoint, type ActorInput, type ModelUsage, type WorldChange, type WorldTurnResult, type DialogueReadRequest, type DialogueReadResult } from './runtime.ts';
import type { CreateSessionOptions, EntityChange, EpisodeMemory, SpeakerReply, WorldActivity, WorldClock, WorldEntity, Observation, ArcProvenance, ActorLocation, StoryTime, TemporalContext } from '../shared/living-world.ts';
import { observationText, validObservation, verifiedObservationSql } from './observations.ts';
import { characterView } from '../shared/character-view.ts';
import { castProfiles, authoredMemorySummary } from './authored-cast.ts';
import { unresolvedCandidates, unresolvedCandidatePredicate } from './unresolved-candidates.ts';
import { loadEventLedgerSnapshot } from './event-ledger-snapshot.ts';
import { observedPatchSnapshot,mergeObservedState } from './observed-patch.ts';
import { appendRuntimeAudit,readRuntimeAudit,auditEntity } from './runtime-audit.ts';
import { playerDeparture } from '../shared/scene-transition.ts';
import { validMovementEvidence } from './movement.ts';
import { unknownStoryTime, initialStoryTime, validStoryTime, resolveStoryTime, settlementWindow } from '../shared/story-time.ts';
import { sceneCutRequested } from '../shared/scene-cut.ts';

type Row = Record<string, any>;
type Query = Pool | PoolClient;
export interface StoredTurn {
  id: string; ownerId: string; sessionId: string; worldId: string;
  status: TurnView['status']; phase: TurnView['phase']; attempt: string;
  draft: string | null; input: ActorInput; replayed: boolean;
  runtimeMetadata: Record<string, unknown>; usage: TurnUsage; checkpoint: ActorCheckpoint | null;
}
export interface StoreOptions { leaseMs?: number; livingWorld?: boolean }
export type TurnUsage = Partial<Record<AgentKey, ModelUsage>>;
export interface SettlementJob {
  id: string; ownerId: string; worldId: string; turnId: string; attempt: string; attempts: number;
  input: ActorInput; dialogue: WorldTurnResult; checkpoint: ActorCheckpoint | null; result: WorldTurnResult | null;
  runtimeMetadata: Record<string, unknown>;
  batchId?: string; batchedTurnIds?: string[];
  evidence?: TurnEvidence;
  commitContext?: CommitContext;
  offlineResult?: { activities: WorldActivity[]; settledCharacterIds: string[]; storyTime?: StoryTime } | null;
}
export interface CommitOptions { actorFirst?: boolean; settlement?: WorldTurnResult; scene?: SceneState; usage?: TurnUsage; replies?: SpeakerReply[]; entityChanges?: EntityChange[]; activities?: WorldActivity[]; observations?: Record<string, Observation>; actorLocations?: ActorLocation[]; storyTime?: StoryTime; settledCharacterIds?: string[] }
const agentKeys: AgentKey[] = ['main','actor','updater','opening','pulse','arbiter'];
// Runtime errors cross a module boundary, so instanceof ServiceError cannot
// identify them. Preserve only known codes and our own fixed public wording;
// neither provider messages nor error.output/headers are safe to persist here.
const settlementRuntimeErrors: Readonly<Record<string,string>> = Object.freeze({
  UPDATER_OUTPUT_INVALID:'世界整理结果未通过校验，请查看对应 Agent 调用记录。原始回复已保留。',
  PULSE_OUTPUT_INVALID:'离线结算结果未通过校验，原始回复已保留。',
  ARBITER_OUTPUT_INVALID:'冲突审查结果未通过校验，原始回复已保留。',
  INVALID_AGENT_DATA:'Agent 数据未通过校验，原始回复已保留。',
  CALL_RECORDING_FAILED:'后台 Agent 调用记录保存失败，原始回复已保留。',
  CHECKPOINT_FAILED:'后台整理检查点保存失败，原始回复已保留。',
  BATCH_REVIEW_REQUIRED:'合并整理需要逐轮核查，原始回复已保留。',
  DIALOGUE_READ_LIMIT:'Agent 原文查询次数超过限制，原始回复已保留。',
  DIALOGUE_TOOL_PROTOCOL:'Agent 原文查询协议无效，原始回复已保留。',
  PROVIDER_TIMEOUT:'模型服务响应超时，原始回复已保留。',
  PROVIDER_FAILED:'模型服务未完成响应，原始回复已保留。',
  PROVIDER_PROTOCOL_ERROR:'模型服务响应格式异常，原始回复已保留。',
  PROVIDER_CONTENT_FILTER:'模型服务未返回可用内容，原始回复已保留。',
  AGENT_CANCELLED:'后台 Agent 调用已取消，原始回复已保留。',
});
const internalStateKeys = ['lastEncounterAt','lastEncounterStoryTime','lastSettledStoryTime','lastSettledStoryMs','lastSettledAt','lastSettledWorldMs','lastSettledActiveMs','pendingRealMs','pendingWorldMs','pendingActiveRealMs','origin','rootCharacterId','source','legacyEnsembleMemory','authoredSharedMemory','authoredCastSplitAfterSeq'];
const iso = (value: Date | string): string => new Date(value).toISOString();
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const contextScene = (value: SceneState): SceneState => ({ location: value.location, presentCharacterIds: [...value.presentCharacterIds], ...(value.mode ? { mode: value.mode } : {}), ...(value.situation ? { situation: value.situation } : {}), ...(value.playerPresent !== undefined ? { playerPresent: value.playerPresent } : {}) });
const actorStoryTime = (value: StoryTime): StoryTime => ({ ...value, source: { kind: value.source.kind, ...(value.source.turnId ? { turnId: value.source.turnId } : {}) } });
const authorNarrativeName = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.trim().length <= 80 && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : undefined;
const verifiedEvidence = `e.evidence=jsonb_build_object('source','user','turnId',e.source_turn_id::text)
  AND ${verifiedObservationSql} AND t.input_json->>'turnId'=t.id::text
  AND t.status='committed'`;
function usage(value?: ModelUsage): ModelUsage | undefined {
  if (!value) return undefined;
  const result: ModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) if (Number.isSafeInteger(value[key]) && value[key]! >= 0) result[key] = value[key];
  return Object.keys(result).length ? result : undefined;
}

/** PostgreSQL owns concurrency. No process-wide writer lease or idle background work. */
export class StoryStore {
  readonly leaseMs: number;
  readonly livingWorld: boolean;
  // Studio previews have no persisted turn. These short-lived capabilities bind
  // their random source ID to the authenticated owner and a frozen archive edge.
  private readonly dialoguePreviews = new Map<string,{ownerId:string;worldId:string;characterIds:string[];beforeSeq:string;excludedTurnIds:string[];expiresAt:number}>();
  private pruneDialoguePreviews() {
    for(const [id,scope] of this.dialoguePreviews) if(scope.expiresAt<=Date.now()) this.dialoguePreviews.delete(id);
    while(this.dialoguePreviews.size>200) this.dialoguePreviews.delete(this.dialoguePreviews.keys().next().value!);
  }
  constructor(readonly pool: Pool, options: StoreOptions = {}) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.livingWorld = options.livingWorld ?? false;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 100) throw new Error('leaseMs must be at least 100.');
  }
  async close(): Promise<void> { await this.pool.end(); }
  private async row(q: Query, sql: string, args: unknown[] = []): Promise<Row | undefined> { return (await q.query(sql, args)).rows[0]; }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await work(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async scopedSession(q: Query, ownerId: string, id: string): Promise<Row> {
    const row = uuid(id) ? await this.row(q, 'SELECT * FROM sessions WHERE id=$1 AND owner_id=$2', [id, ownerId]) : undefined;
    if (!row) throw new ServiceError('SESSION_NOT_FOUND', '会话不存在。', 404); return row;
  }
  private async scopedWorld(q: Query, ownerId: string, id: string, lock = false): Promise<Row> {
    const row = uuid(id) ? await this.row(q, `SELECT * FROM worlds WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, ownerId]) : undefined;
    if (!row) throw new ServiceError('WORLD_NOT_FOUND', '故事不存在。', 404); return row;
  }
  private async scopedTurn(q: Query, ownerId: string, id: string): Promise<Row> {
    const row = uuid(id) ? await this.row(q, 'SELECT * FROM turns WHERE id=$1 AND owner_id=$2', [id, ownerId]) : undefined;
    if (!row) throw new ServiceError('TURN_NOT_FOUND', '本轮消息不存在。', 404); return row;
  }
  private async expireWorld(q: Query, ownerId: string, worldId: string): Promise<void> {
    const expired = await q.query("UPDATE turns SET status='failed',error_code='RUN_INTERRUPTED',error_message='上次执行已中断，可以重试。',updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND status='running' AND lease_expires_at<=clock_timestamp() RETURNING id,attempt", [ownerId, worldId]);
    for (const turn of expired.rows) await this.finishCalls(q, ownerId, turn.id, turn.attempt, 'failed', 'RUN_INTERRUPTED', '上次执行已中断，可以重试。');
  }
  async renewAttempt(turn: StoredTurn): Promise<boolean> {
    const result = await this.pool.query("UPDATE turns SET lease_expires_at=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp()", [turn.id, turn.ownerId, turn.attempt, this.leaseMs]);
    return result.rowCount === 1;
  }
  async listCharacters(q: Query = this.pool): Promise<Character[]> { return (await q.query(`SELECT id,name,subtitle,description,initial,color,greeting,thumbnail_url AS "thumbnailUrl",cover_url AS "coverUrl",language,source_kind AS source FROM characters ORDER BY CASE source_kind WHEN 'legacy' THEN 0 ELSE 1 END,CASE language WHEN 'zh-CN' THEN 0 ELSE 1 END,sort_order`)).rows; }
  async ensureSeed(ownerId: string): Promise<void> {
    await this.transaction(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended('seed:' || $1,0))", [ownerId]);
      if (await this.row(q, 'SELECT id FROM worlds WHERE owner_id=$1 LIMIT 1', [ownerId])) return;
      const character = (await this.listCharacters(q))[0];
      if (!character) throw new ServiceError('CHARACTER_NOT_FOUND', '角色目录尚未初始化。', 503);
      await this.createSessionIn(q, ownerId, character.id);
    });
  }
  private sessionView(row: Row): Session { return { id: row.id, worldId: row.world_id, characterId: row.character_id, title: row.title, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), dynamicOpening: row.dynamic_opening, ...(row.scene ? { scene: row.scene } : {}) }; }
  async listSessions(ownerId: string): Promise<Session[]> { return (await this.pool.query('SELECT * FROM sessions WHERE owner_id=$1 ORDER BY updated_at DESC,seq DESC LIMIT 100', [ownerId])).rows.map((row) => this.sessionView(row)); }
  async listWorlds(ownerId: string): Promise<WorldView[]> {
    return this.transaction(async (q) => {
      const rows = (await q.query('SELECT id FROM worlds WHERE owner_id=$1 ORDER BY seq DESC LIMIT 100', [ownerId])).rows;
      const worlds: WorldView[] = [];
      for (const row of rows) worlds.push(await this.worldView(q, ownerId, row.id));
      return worlds;
    }, true);
  }
  private entityView(row: Row): WorldEntity { return { id: row.id, kind: row.kind, name: row.name, description: row.description, state: row.state, knownByCharacterIds: row.known_by_character_ids, sourceTurnId: row.source_turn_id ?? (row.state.origin === 'user-scene' ? 'user-scene' : 'seed'), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), version: row.version ?? 1 }; }
  private async entities(q: Query, ownerId: string, worldId: string, characterId?: string): Promise<WorldEntity[]> {
    if (!characterId) return (await q.query('SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 ORDER BY created_at,id', [ownerId, worldId])).rows.map(row => this.entityView(row));
    const rows = (await q.query(`SELECT k.snapshot,k.observed_at,k.source_turn_id FROM world_entity_knowledge k
      WHERE k.owner_id=$1 AND k.world_id=$2 AND k.character_id=$3 ORDER BY k.entity_id`, [ownerId, worldId, characterId])).rows;
    const known = rows.flatMap(row => {
      const snapshot = row.snapshot as Row;
      const authorized = Array.isArray(snapshot.known_by_character_ids) && snapshot.known_by_character_ids.includes(characterId);
      // Old co-presence snapshots can contain a private persona even though only
      // the person's identity was witnessed. Never widen that persona's audience.
      if (!authorized && snapshot.kind !== 'npc') return [];
      const visible = authorized ? snapshot : { ...snapshot, description: '',
        state: { initial: snapshot.state?.initial, color: snapshot.state?.color }, known_by_character_ids: [characterId] };
      return [{ ...this.entityView(visible), knowledge: { observedAt: iso(row.observed_at), sourceTurnId: row.source_turn_id } }];
    });
    // A character knows its own current state. Other people only get the version witnessed.
    const own = await this.row(q, "SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'", [ownerId, worldId, characterId]);
    return own ? [...known.filter(entity => entity.id !== characterId), this.entityView({...own,known_by_character_ids:[...new Set([...(own.known_by_character_ids??[]),characterId])]})] : known;
  }
  private async rememberEntities(q: Query, ownerId: string, worldId: string, ids: string[], witnesses: string[], sourceTurnId: string | null = null, sceneObservation=false): Promise<void> {
    if (!ids.length || !witnesses.length) return;
    await q.query(`INSERT INTO world_entity_knowledge(owner_id,world_id,character_id,entity_id,version,snapshot,observed_at,source_turn_id)
      SELECT e.owner_id,e.world_id,n.id,e.id,e.version,
        CASE WHEN $6::boolean AND n.id<>e.id THEN to_jsonb(e) || jsonb_build_object('description','','state',
          CASE WHEN e.kind='npc' THEN jsonb_strip_nulls(jsonb_build_object('initial',e.state->'initial','color',e.state->'color','locationId',e.state->'locationId')) ELSE '{}'::jsonb END,
          'known_by_character_ids',jsonb_build_array(n.id),'knowledgeScope','identity')
        WHEN n.id=ANY(e.known_by_character_ids) THEN to_jsonb(e)
        ELSE to_jsonb(e) || jsonb_build_object('description','','state',jsonb_strip_nulls(jsonb_build_object('initial',e.state->'initial','color',e.state->'color')),'known_by_character_ids',jsonb_build_array(n.id),'knowledgeScope','identity') END,
        clock_timestamp(),$5 FROM world_entities e
      JOIN world_entities n ON n.owner_id=e.owner_id AND n.world_id=e.world_id AND n.kind='npc' AND n.id=ANY($4::text[])
      WHERE e.owner_id=$1 AND e.world_id=$2 AND e.id=ANY($3::text[]) AND (n.id=ANY(e.known_by_character_ids) OR e.kind='npc')
      ON CONFLICT(world_id,character_id,entity_id) DO UPDATE SET
        version=CASE WHEN $6::boolean AND EXCLUDED.snapshot->>'kind'='location' THEN world_entity_knowledge.version ELSE EXCLUDED.version END,
        snapshot=CASE WHEN NOT $6::boolean OR EXCLUDED.character_id=EXCLUDED.entity_id THEN EXCLUDED.snapshot
          WHEN EXCLUDED.snapshot->>'kind'='location' THEN world_entity_knowledge.snapshot
          ELSE world_entity_knowledge.snapshot || jsonb_build_object('name',EXCLUDED.snapshot->'name','version',EXCLUDED.version,'knowledgeScope','partial','state',
            (world_entity_knowledge.snapshot->'state') || jsonb_build_object('locationId',EXCLUDED.snapshot->'state'->'locationId')) END,
        observed_at=EXCLUDED.observed_at,source_turn_id=EXCLUDED.source_turn_id`, [ownerId, worldId, ids, witnesses, sourceTurnId,sceneObservation]);
  }
  private projection(world: Row, at: string): { clock: WorldClock; activeMs: number } {
    const from = world.real_anchor_at ? iso(world.real_anchor_at) : at;
    const elapsed = Math.max(0, Date.parse(at) - Date.parse(from));
    const active = world.clock_mode === 'paused' || this.livingWorld || world.story_time ? 0 : elapsed;
    const fromWorld = Number(world.clock_world_ms);
    return { clock: { asOf: at, fromRealAt: from, elapsedRealMs: elapsed, activeElapsedRealMs: active,
      fromWorldMs: fromWorld, toWorldMs: fromWorld + Math.floor(active * world.clock_rate), elapsedWorldMs: Math.floor(active * world.clock_rate), rate: world.clock_rate, mode: world.clock_mode }, activeMs: Number(world.clock_active_ms) + active };
  }
  private actorClock(entity: WorldEntity, projection: { clock: WorldClock; activeMs: number }): WorldClock {
    const { clock, activeMs } = projection; const state = entity.state;
    const fromRealAt = typeof state.lastSettledAt === 'string' ? state.lastSettledAt : clock.asOf;
    const fromWorldMs = typeof state.lastSettledWorldMs === 'number' ? state.lastSettledWorldMs : clock.toWorldMs;
    const lastActive = typeof state.lastSettledActiveMs === 'number' ? state.lastSettledActiveMs : activeMs;
    return { ...clock, fromRealAt, fromWorldMs, elapsedRealMs: Math.max(0, Date.parse(clock.asOf) - Date.parse(fromRealAt)),
      activeElapsedRealMs: Math.max(0, activeMs - lastActive), elapsedWorldMs: Math.max(0, clock.toWorldMs - fromWorldMs) };
  }
  private async now(q: Query): Promise<string> { return iso((await q.query('SELECT clock_timestamp() AS now')).rows[0].now); }
  private async temporal(q: Query, ownerId: string, world: Row, scene: SceneState, at: string, actorId?: string, snapshot?: ContextSnapshot): Promise<TemporalContext> {
    const previous = snapshot ? snapshot.previous : await this.row(q, "SELECT updated_at,episode_scene,episode_participant_ids FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed' ORDER BY seq DESC LIMIT 1", [ownerId, world.id]);
    const previousTurnAt = previous ? iso(previous.updated_at) : null;
    const elapsedMs = previousTurnAt ? Math.max(0, Date.parse(at) - Date.parse(previousTurnAt)) : 0;
    const offlineEligible = scene.playerPresent === false && world.clock_mode !== 'paused';
    return { real: { now: at, previousTurnAt, elapsedMs }, story: validStoryTime(world.story_time) ? world.story_time : unknownStoryTime(), offlineEligible,
      realGapStoryMs: offlineEligible ? Math.floor(elapsedMs * world.clock_rate) : 0,
      storyElapsedTotalMs: Number(world.story_elapsed_ms),
      settlementEligible: !!previous && (previous.episode_scene?.playerPresent === false || !previous.episode_participant_ids.includes(actorId)) };
  }
  private async episodes(q: Query, ownerId: string, worldId: string, characterId?: string, limit = 30, relevant?: { entities: WorldEntity[]; scene: SceneState }, selection?:{beforeSeq:string|number;turnIds?:string[];query?:string;excludedTurnIds?:string[]}): Promise<EpisodeMemory[]> {
    const eligible = `SELECT * FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed'
      AND ($3::text IS NULL OR $3=ANY(episode_participant_ids) OR EXISTS(SELECT 1 FROM jsonb_array_elements(activities) a WHERE a->>'characterId'=$3))
      AND ($3::text IS NULL OR NOT EXISTS(SELECT 1 FROM events e WHERE e.owner_id=turns.owner_id AND e.world_id=turns.world_id AND e.source_turn_id=turns.id AND e.status='retracted' AND (e.visibility='public' OR e.character_id=$3)))`;
    const turns = selection ? (await q.query(`${eligible} AND seq<$4
      AND ($5::uuid[] IS NULL OR id=ANY($5::uuid[]))
      AND ($6::text='' OR position(lower($6) in lower(COALESCE(episode_observations->$3,'null'::jsonb)::text))>0
        OR EXISTS(SELECT 1 FROM messages m WHERE m.turn_id=turns.id AND m.owner_id=$1 AND m.character_id=$3 AND m.role='assistant' AND position(lower($6) in lower(m.content))>0)
        OR EXISTS(SELECT 1 FROM world_settlements j CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.dialogue->'attributedEvidence','[]')) span WHERE j.turn_id=turns.id AND j.owner_id=$1 AND span->'audienceCharacterIds' ? $3 AND position(lower($6) in lower(span->>'text'))>0))
      AND NOT(id=ANY($8::uuid[]))
      ORDER BY seq DESC LIMIT $7`,[ownerId,worldId,characterId,selection.beforeSeq,selection.turnIds ?? null,selection.query ?? '',limit,selection.excludedTurnIds ?? []])).rows
      : (await q.query(`${eligible} ORDER BY seq DESC LIMIT $4`, [ownerId, worldId, characterId ?? null, limit])).rows;
    const recentIds = new Set(turns.map(turn => turn.id));
    const pendingIds = new Set<string>();
    if (characterId && relevant) {
      // A failed summary must not make its evidence disappear merely because six
      // newer messages arrived. Keep two oldest unresolved exchanges in retrieval;
      // the entire backlog remains durable, scoped, and available for settlement.
      const pending = (await q.query(`${eligible} AND EXISTS(SELECT 1 FROM world_settlements j WHERE j.turn_id=turns.id AND j.status<>'completed') ORDER BY seq LIMIT 2`,[ownerId,worldId,characterId])).rows;
      for (const turn of pending) { pendingIds.add(turn.id); if (!recentIds.has(turn.id)) turns.push(turn); }
    }
    const relevantEntities = relevant?.entities.filter(entity => entity.kind === 'item' || entity.kind === 'quest' && ['proposed','active'].includes(String(entity.state.status))) ?? [];
    const relatedReasons = new Map<string,string[]>();
    if (characterId && relevant) {
      const ids = relevantEntities.map(entity => entity.id), sourceIds = relevantEntities.map(entity => entity.sourceTurnId).filter(uuid);
      const others = relevant.scene.presentCharacterIds.filter(id => id !== characterId);
      const older = (await q.query(`${eligible} AND NOT(id=ANY($4::uuid[])) AND
        (episode_entity_ids && $5::text[] OR id=ANY($6::uuid[]) OR episode_scene->>'location'=$7 OR episode_participant_ids && $8::text[])
        ORDER BY (CASE WHEN episode_entity_ids && $5::text[] OR id=ANY($6::uuid[]) THEN 3 ELSE 0 END
          + CASE WHEN episode_scene->>'location'=$7 THEN 1 ELSE 0 END
          + CASE WHEN episode_participant_ids && $8::text[] THEN 1 ELSE 0 END) DESC,seq DESC LIMIT 24`,
        [ownerId,worldId,characterId,turns.map(turn=>turn.id),ids,sourceIds,relevant.scene.location,others])).rows;
      for (const turn of older) {
        const matches = relevantEntities.filter(entity => turn.episode_entity_ids.includes(entity.id) || entity.sourceTurnId === turn.id).map(entity => `${entity.kind}:${entity.id}`);
        if (relevant.scene.location && turn.episode_scene?.location === relevant.scene.location) matches.push(`location:${relevant.scene.location}`);
        for (const id of others) if (turn.episode_participant_ids.includes(id)) matches.push(`character:${id}`);
        if (matches.length) { turns.push(turn); relatedReasons.set(turn.id,matches); }
      }
      turns.sort((a,b) => Number(b.seq) - Number(a.seq));
    }
    const result: EpisodeMemory[] = [];
    for (const turn of turns.reverse()) {
      const rawScene = contextScene(turn.episode_scene ?? turn.input_json.scene ?? { location: null, presentCharacterIds: [turn.character_id] });
      if (characterId && turn.input_json.worldContext && !turn.episode_observations) delete rawScene.situation;
      const scene = { ...rawScene, presentCharacterIds: rawScene.presentCharacterIds.filter(id => turn.episode_participant_ids.includes(id)) };
      if (!characterId || turn.episode_participant_ids.includes(characterId)) {
        const messages = (await q.query('SELECT * FROM messages WHERE owner_id=$1 AND turn_id=$2 ORDER BY seq', [ownerId, turn.id])).rows;
        const userMessage = messages.find(row => row.role === 'user');
        const original = turn.operation === 'opening' ? '' : userMessage?.content ?? '';
        const playerName = userMessage?.character_name ?? turn.input_json.playerProfile?.name;
        // The archive is complete. A model receives only the listener-specific perception
        // recorded during this turn; old living-world messages have no such authorization.
        const recorded=characterId ? await this.row(q,'SELECT dialogue FROM world_settlements WHERE owner_id=$1 AND turn_id=$2',[ownerId,turn.id]) : undefined;
        let scopedReplies=messages.filter(row=>row.role==='assistant').map(row=>({characterId:row.character_id,characterName:row.character_name,text:row.content}));
        if(characterId && recorded?.dialogue?.attributedEvidence?.length) {
          const allowed={...recorded.dialogue,attributedEvidence:recorded.dialogue.attributedEvidence.filter((span:any)=>span.audienceCharacterIds.includes(characterId))};
          scopedReplies=allowed.attributedEvidence.length?this.attributedReplies(allowed,turn.id):[];
        }
        const observed = turn.episode_observations?.[characterId ?? ''] as Observation | undefined;
        const perceived = characterId ? (turn.episode_observations ? (validObservation(observed, original) ? observationText(observed) : '') : turn.input_json.worldContext ? '' : original) : original;
        result.push({ turnId: turn.id, sessionId: turn.session_id, kind: turn.operation, occurredAt: iso(turn.updated_at), recordedAt: iso(turn.updated_at), ...(validStoryTime(turn.story_time) ? { storyTime: characterId ? actorStoryTime(turn.story_time) : turn.story_time } : {}), scene,
          participantIds: turn.episode_participant_ids, userText: scene.playerPresent === false && characterId ? '' : perceived,
          ...(playerName ? { playerName } : {}),
          ...(relevant ? { retrieval: { reason: pendingIds.has(turn.id) ? 'related' as const : recentIds.has(turn.id) ? 'recent' as const : 'related' as const, matches: pendingIds.has(turn.id) ? ['pending-settlement'] : relatedReasons.get(turn.id) ?? [] } } : {}),
          ...(!characterId && turn.episode_observations ? { observations: turn.episode_observations } : {}),
          replies: scopedReplies });
      }
      for (const activity of turn.activities as WorldActivity[]) if (!characterId || activity.characterId === characterId) {
        const actor = await this.row(q, 'SELECT name FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3', [ownerId, worldId, activity.characterId]);
        result.push({ turnId: turn.id, sessionId: turn.session_id, kind: 'pulse', occurredAt: activity.occurredAt ?? iso(turn.updated_at), recordedAt: iso(turn.updated_at), ...(validStoryTime(activity.storyTime) ? { storyTime: characterId ? actorStoryTime(activity.storyTime) : activity.storyTime } : {}), scene: { location: activity.locationId ?? null, presentCharacterIds: [activity.characterId] }, participantIds: [activity.characterId], userText: '', ...(relevant ? { retrieval: { reason: recentIds.has(turn.id) ? 'recent' as const : 'related' as const, matches: relatedReasons.get(turn.id) ?? [] } } : {}), replies: [{ characterId: activity.characterId, characterName: actor?.name ?? activity.characterId, text: `${activity.kind === 'invitation' ? '待参与邀请，尚未发生：' : '已结算的角色活动：'}${activity.text}` }] });
      }
    }
    return result;
  }
  private async worldView(q: Query, ownerId: string, id: string, characterId?: string, scene?: SceneState): Promise<WorldView> {
    const world = await this.scopedWorld(q, ownerId, id);
    const rows = (await q.query(`WITH candidates AS (
      SELECT e.*,t.story_time,COALESCE(e.status='active' AND ${verifiedEvidence},false) AS readable
      FROM events e JOIN turns t ON t.id=e.source_turn_id AND t.owner_id=e.owner_id AND t.world_id=e.world_id AND t.character_id=e.character_id
      WHERE e.world_id=$1 AND e.owner_id=$2 AND ($3::text IS NULL OR e.visibility='public' OR e.character_id=$3)
    ), selected AS (
      (SELECT * FROM candidates WHERE readable ORDER BY seq DESC LIMIT 100)
      UNION ALL
      (SELECT * FROM candidates WHERE NOT readable ORDER BY seq DESC LIMIT 100)
    ) SELECT * FROM selected ORDER BY seq`, [id, ownerId, characterId ?? null])).rows;
    const events = rows.map((event): StoryEvent => ({ id: event.id, kind: event.kind, text: event.text, visibility: event.visibility, characterId: event.character_id, sourceTurnId: event.source_turn_id, createdAt: iso(event.created_at), recordedAt: iso(event.created_at), ...(validStoryTime(event.story_time) ? { storyTime: event.story_time } : {}), status: event.status, evidence: event.evidence }));
    const entities = await this.entities(q, ownerId, id);
    const episodes = await this.episodes(q, ownerId, id);
    const activities = (await q.query("SELECT activities FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed' AND jsonb_array_length(activities)>0 ORDER BY seq DESC LIMIT 30", [ownerId, id])).rows.reverse().flatMap(row => row.activities as WorldActivity[]);
    const settlements = (await q.query(`SELECT * FROM (
      (SELECT id,turn_id,status,attempts,error_code,error_message,updated_at,seq,result->'deferredCommands' AS candidate_commands FROM world_settlements WHERE owner_id=$1 AND world_id=$2 ORDER BY seq DESC LIMIT 49)
      UNION
      (SELECT id,turn_id,status,attempts,error_code,error_message,updated_at,seq,result->'deferredCommands' AS candidate_commands FROM world_settlements WHERE owner_id=$1 AND world_id=$2 AND status<>'completed' ORDER BY seq LIMIT 1)
    ) jobs ORDER BY seq DESC`,[ownerId,id])).rows.map(row => ({ id: row.id, turnId: row.turn_id, status: row.status, attempts: row.attempts, unresolvedCommands:unresolvedCandidates(row.candidate_commands).length, updatedAt: iso(row.updated_at), ...(row.error_code ? { error: { code: row.error_code, message: row.error_message } } : {}) }));
    const direction=await this.row(q,'SELECT status,requested_turn_id,error_code,plan FROM world_directions WHERE owner_id=$1 AND world_id=$2',[ownerId,id]);
    if(direction?.plan?.planType==='mainline' && uuid(direction.plan.basedOnTurnId)) {
      direction.plan={...direction.plan,elapsedTurns:Number((await q.query(`SELECT count(*) AS n FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed'
        AND seq>(SELECT seq FROM turns WHERE owner_id=$1 AND world_id=$2 AND id=$3)`,[ownerId,id,direction.plan.basedOnTurnId])).rows[0].n)};
    }
    const backlog=(await q.query(`SELECT count(*) FILTER (WHERE j.status IN ('pending','running'))::int AS pending,
      count(*) FILTER (WHERE j.status='failed')::int AS failed,
      min(j.created_at) FILTER (WHERE j.status<>'completed') AS oldest,
      COALESCE(sum(candidates.unresolved),0)::int AS unresolved_commands,count(*) FILTER (WHERE candidates.unresolved>0)::int AS unresolved_turns
      FROM world_settlements j LEFT JOIN LATERAL (SELECT count(*)::int AS unresolved FROM jsonb_array_elements(COALESCE(j.result->'deferredCommands','[]'::jsonb)) c(command)
        WHERE ${unresolvedCandidatePredicate}) candidates ON true WHERE owner_id=$1 AND world_id=$2`,[ownerId,id])).rows[0];
    const settlementBacklog={pendingTurns:backlog.pending,failedTurns:backlog.failed,unresolvedCommands:backlog.unresolved_commands,unresolvedTurns:backlog.unresolved_turns,oldestPendingAt:backlog.oldest ? iso(backlog.oldest) : null};
    const director=direction ? {status:direction.status,turnId:direction.requested_turn_id,...(direction.error_code ? {errorCode:direction.error_code}: {})} : undefined;
    const ledger=await loadEventLedgerSnapshot(q,ownerId,id);const eventLedger=ledger.events;
    const deferredCommands=(await q.query(`SELECT j.turn_id,c.command FROM world_settlements j
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.result->'deferredCommands','[]')) c(command)
      WHERE j.owner_id=$1 AND j.world_id=$2 ORDER BY j.seq DESC LIMIT 100`,[ownerId,id])).rows.map(row=>({id:row.command.id,reason:row.command.reason,evidenceIds:row.command.evidenceIds,sourceTurnId:row.turn_id}));
    return { settlements, settlementBacklog, eventLedger,eventLedgerOverflow:ledger.overflow,deferredCommands,...(direction?.plan?.planType==='mainline'?{mainlinePlan:direction.plan}:{}), ...(director ? {director}: {}), id, title: world.title, revision: world.revision, playerProfile: world.player_profile ?? null, createdAt: iso(world.created_at), events, scene: scene ?? world.scene, entities, episodes, activities, storyTime: validStoryTime(world.story_time) ? world.story_time : unknownStoryTime(), clock: this.projection(world, await this.now(q)).clock, ...(characterId ? { memoryScopeCharacterId: characterId } : {}) };
  }
  async getWorld(ownerId: string, id: string): Promise<WorldView> { return this.transaction((q) => this.worldView(q, ownerId, id), true); }
  async runtimeAudit(ownerId:string,worldId:string,captureId?:string,includeCalls=false){
    return this.transaction(async q=>readRuntimeAudit(q,ownerId,await this.worldView(q,ownerId,worldId),captureId,includeCalls),true);
  }
  async startRuntimeCapture(ownerId:string,worldId:string,expectedTurns=7){
    if(!Number.isSafeInteger(expectedTurns)||expectedTurns<1||expectedTurns>7)throw new ServiceError('INPUT_INVALID','观测轮数必须是1到7轮。',422);
    return this.transaction(async q=>{
      await this.scopedWorld(q,ownerId,worldId,true);
      const afterSeq=Number((await this.row(q,'SELECT COALESCE(max(seq),0) AS n FROM turns WHERE owner_id=$1 AND world_id=$2',[ownerId,worldId]))!.n);
      const captureId=await appendRuntimeAudit(q,{ownerId,worldId,kind:'capture_started',data:{lane:'capture',afterSeq,expectedTurns}});
      return readRuntimeAudit(q,ownerId,await this.worldView(q,ownerId,worldId),captureId);
    });
  }
  private async seedEntity(q: Query, ownerId: string, worldId: string, character: Row, rootId: string): Promise<void> {
    const cast=castProfiles(character);
    if(cast) {
      for(const member of cast) await this.seedEntity(q,ownerId,worldId,member,rootId);
      await this.rememberEntities(q,ownerId,worldId,cast.map(member=>member.id),cast.map(member=>member.id));
      return;
    }
    const world = await this.scopedWorld(q,ownerId,worldId);
    const narrativeName = authorNarrativeName(character.source?.narrativeName);
    await q.query(`INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES($1,$2,$3,'npc',$4,$5,$6,$7) ON CONFLICT(world_id,id) DO NOTHING`, [ownerId, worldId, character.id, character.name, character.description, { definition: character.definition, greeting: character.greeting, initial: character.initial, color: character.color, ...(narrativeName ? { narrativeName } : {}), ...(character.source?.castKey ? {authoredCastKey:character.source.castKey,narrativeAliases:character.source.narrativeAliases??[]} : {}), origin: 'seed', rootCharacterId: rootId, lastSettledAt: await this.now(q), lastSettledStoryTime: validStoryTime(world.story_time) ? world.story_time : unknownStoryTime(), lastSettledStoryMs:Number(world.story_elapsed_ms) }, [character.id]]);
    await this.rememberEntities(q,ownerId,worldId,[character.id],[character.id]);
  }
  /** The caller holds this world's lock (or created it in this transaction). */
  private async locateSceneActors(q: Query, ownerId: string, worldId: string, scene: SceneState, focusId?: string, declare = false): Promise<void> {
    if (!scene.location) return;
    const name = scene.location.trim();
    const present = scene.mode === 'direct' ? scene.presentCharacterIds.filter(id => id === (focusId ?? scene.presentCharacterIds[0])) : scene.presentCharacterIds;
    const normalize = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase();
    const places = (await q.query("SELECT id,name,known_by_character_ids FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND kind='location' ORDER BY created_at,id", [ownerId, worldId])).rows;
    const place = places.find(row => row.id === name) ?? places.find(row => normalize(row.name) === normalize(name));
    let locationId = place?.id;
    if (place) {
      const known = [...new Set([...place.known_by_character_ids, ...present])];
      if (known.length !== place.known_by_character_ids.length) await q.query('UPDATE world_entities SET known_by_character_ids=$4,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND id=$3', [ownerId, worldId, place.id, known]);
    } else if (declare) {
      const count = Number((await q.query('SELECT count(*) AS n FROM world_entities WHERE owner_id=$1 AND world_id=$2', [ownerId, worldId])).rows[0].n);
      if (count >= 256) throw new ServiceError('WORLD_ENTITY_LIMIT', '世界档案数量已达上限，无法新增地点。', 422);
      locationId = randomUUID();
      await q.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids,source_turn_id) VALUES($1,$2,$3,'location',$4,'',$5,$6,NULL)", [ownerId, worldId, locationId, name, { origin: 'user-scene', source: 'user' }, [...present]]);
      // This record was created publicly by this very placement. Existing places
      // go through the identity-only observation below instead.
      await this.rememberEntities(q,ownerId,worldId,[locationId],present);
    }
    // Scene placement is a host-owned fact. A private conversation cannot move bystanders.
    if (locationId) {
      await q.query("UPDATE world_entities SET state=state || jsonb_build_object('locationId',$4::text),version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND kind='npc' AND id=ANY($3::text[]) AND state->>'locationId' IS DISTINCT FROM $4", [ownerId, worldId, present, locationId]);
      // Re-entering a known room reveals its identity and visible positions,
      // never every private update made to that room or its occupants since.
      await this.rememberEntities(q,ownerId,worldId,[locationId,...present],present,null,true);
    }
  }
  private async createSessionIn(q: PoolClient, ownerId: string, characterId: string, worldId?: string, options: CreateSessionOptions = {}): Promise<SessionDetail> {
    const id = randomUUID(); const selectedWorld = worldId ?? randomUUID();
    let character: Row | undefined; let scene: SceneState;
    if (worldId) {
      if (options.playerProfileId !== undefined) throw new ServiceError('PROFILE_WORLD_SCOPE','续聊沿用本世界身份，请在玩家身份面板切换。',422);
      const world = await this.scopedWorld(q, ownerId, worldId, true);
      await this.assertWorldIdle(q, ownerId, worldId);
      if (options.expectedRevision !== undefined && options.expectedRevision !== world.revision) throw new ServiceError('WORLD_CHANGED', '故事已有新的进展，请刷新后创建场景。');
      const entity = await this.row(q, "SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'", [ownerId, worldId, characterId]);
      if (entity) character = { id: entity.id, name: entity.name, greeting: entity.state.greeting ?? '' };
      else if (!options.dynamicOpening && !this.livingWorld) {
        character = await this.row(q, 'SELECT * FROM characters WHERE id=$1', [characterId]);
        if (character) await this.seedEntity(q, ownerId, worldId, character, world.root_character_id);
      }
      if (!character) throw new ServiceError('CHARACTER_NOT_FOUND', '只能选择这个世界中的角色。', 404);
      const base: SceneState = options.scene ?? (options.dynamicOpening ? { location: world.scene.location, presentCharacterIds: [characterId], mode: 'ensemble', ...(world.scene.playerPresent !== undefined ? { playerPresent: world.scene.playerPresent } : {}) } : world.scene);
      scene = await this.validateScene(q, { ...base, presentCharacterIds: base.presentCharacterIds.includes(characterId) ? base.presentCharacterIds : [...base.presentCharacterIds, characterId] }, ownerId, worldId);
      if (options.dynamicOpening || options.scene || !isDeepStrictEqual(scene, world.scene)) await q.query("UPDATE worlds SET scene=$3::jsonb || jsonb_build_object('updatedAt',clock_timestamp()),revision=revision+1 WHERE id=$1 AND owner_id=$2", [worldId, ownerId, scene]);
    } else {
      character = await this.row(q, 'SELECT * FROM characters WHERE id=$1', [characterId]);
      if (!character) throw new ServiceError('CHARACTER_NOT_FOUND', '角色不存在。', 404);
      const cast=castProfiles(character);
      scene = options.scene ?? { location: null, presentCharacterIds: cast?cast.filter(member=>member.presentAtStart).map(member=>member.id):[characterId], ...(options.dynamicOpening||cast ? { mode: 'ensemble' as const } : {}) };
      await q.query('INSERT INTO worlds(id,owner_id,title,scene,root_character_id,story_time) VALUES($1,$2,$3,$4,$5,$6)', [selectedWorld, ownerId, `与${character.name}的故事`, scene, characterId, initialStoryTime()]);
      if (options.playerProfileId !== undefined && options.playerProfileId !== null) await q.query('UPDATE worlds SET player_profile=$3 WHERE owner_id=$1 AND id=$2',[ownerId,selectedWorld,await profile(q,ownerId,options.playerProfileId)]);
      await this.seedEntity(q, ownerId, selectedWorld, character, characterId);
      scene = await this.validateScene(q, scene, ownerId, selectedWorld);
      if (!scene.presentCharacterIds.includes(characterId)) throw new ServiceError('CHARACTER_NOT_PRESENT', '新场景必须包含当前角色。', 422);
    }
    await this.locateSceneActors(q, ownerId, selectedWorld, scene, characterId, true);
    await q.query('INSERT INTO sessions(id,owner_id,world_id,character_id,title,scene,dynamic_opening) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, ownerId, selectedWorld, characterId, `与${character.name}的对话`, options.dynamicOpening || options.scene ? scene : null, !!options.dynamicOpening]);
    if (!worldId && !options.dynamicOpening) await q.query("INSERT INTO messages(id,owner_id,world_id,session_id,role,content,character_id,character_name,player_name) VALUES($1,$2,$3,$4,'assistant',$5,$6,$7,(SELECT player_profile->>'name' FROM worlds WHERE id=$3 AND owner_id=$2))", [randomUUID(), ownerId, selectedWorld, id, character.greeting, characterId, character.name]);
    return this.sessionDetail(q, ownerId, id);
  }
  async createSession(ownerId: string, characterId: string, worldId?: string, options: CreateSessionOptions = {}): Promise<SessionDetail> { return this.transaction((q) => this.createSessionIn(q, ownerId, characterId, worldId, options)); }
  /** Explicit maintenance operation: a reviewed cast import repairs old combined
   * identities. Historical text and frozen jobs are never silently rewritten. */
  async repairAuthoredCast(ownerId:string,worldId:string,expectedRevision:number,sharedMemory?:{summary:string;sourceTurnIds:string[]}):Promise<WorldView> {
    return this.transaction(async q=>{
      const world=await this.scopedWorld(q,ownerId,worldId,true);
      await this.assertWorldIdle(q,ownerId,worldId);
      if(world.revision!==expectedRevision)throw new ServiceError('WORLD_CHANGED','故事已更新，请刷新后修复人物。',409);
      if(await this.row(q,"SELECT id FROM world_settlements WHERE owner_id=$1 AND world_id=$2 AND status<>'completed' LIMIT 1",[ownerId,worldId]))throw new ServiceError('WORLD_BUSY','请先完成旧轮次的后台归档再修复人物。',409);
      const card=await this.row(q,'SELECT * FROM characters WHERE id=$1',[world.root_character_id]);
      const cast=card&&castProfiles(card);
      if(!cast)throw new ServiceError('CAST_NOT_AUTHORED','角色卡没有经过审核的多人物结构。',422);
      if(sharedMemory) {
        if(typeof sharedMemory.summary!=='string'||!sharedMemory.summary.trim()||sharedMemory.summary.length>240||!Array.isArray(sharedMemory.sourceTurnIds)||!sharedMemory.sourceTurnIds.length||sharedMemory.sourceTurnIds.length>100||sharedMemory.sourceTurnIds.some(id=>!uuid(id)))throw new ServiceError('CAST_MEMORY_INVALID','共同经历必须附带本世界已提交轮次来源。',422);
        const sources=await q.query("SELECT id FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed' AND id=ANY($3::uuid[]) AND $4=ANY(episode_participant_ids)",[ownerId,worldId,sharedMemory.sourceTurnIds,world.root_character_id]);
        if(sources.rowCount!==new Set(sharedMemory.sourceTurnIds).size)throw new ServiceError('CAST_MEMORY_INVALID','共同经历来源不属于该人物的已发生场景。',422);
      }
      const original=await this.row(q,"SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'",[ownerId,worldId,world.root_character_id]);
      const existingIds=new Set((await q.query("SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND kind='npc'",[ownerId,worldId])).rows.map(row=>row.id));
      const splitAfterSeq=Number((await this.row(q,'SELECT COALESCE(max(seq),0) AS n FROM turns WHERE owner_id=$1 AND world_id=$2',[ownerId,worldId]))!.n);
      await this.seedEntity(q,ownerId,worldId,card!,world.root_character_id);
      for(const member of cast) {
        const state:Record<string,unknown>={definition:member.definition,greeting:member.greeting,initial:member.initial,color:member.color,narrativeName:member.source.narrativeName,narrativeAliases:member.source.narrativeAliases,authoredCastKey:member.source.castKey};
        if(sharedMemory)state.authoredSharedMemory=sharedMemory;
        const splitPrimary=member.id===world.root_character_id&&!original?.state.authoredCastKey;
        if(splitPrimary)state.authoredCastSplitAfterSeq=splitAfterSeq;
        if(splitPrimary&&original?.state.arc)state.legacyEnsembleMemory={summary:original.state.arc,provenance:original.state.arcProvenance??null};
        if(original?.state.locationId && !existingIds.has(member.id) && member.presentAtStart && world.scene.presentCharacterIds.includes(world.root_character_id))state.locationId=original.state.locationId;
        await q.query(`UPDATE world_entities SET name=$4,description=$5,state=(state${splitPrimary?"-'arc'-'arcProvenance'":''}) || $6::jsonb,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND id=$3`,[ownerId,worldId,member.id,member.name,member.description,state]);
      }
      const expand=(scene:SceneState):SceneState=>({...scene,presentCharacterIds:scene.presentCharacterIds.includes(world.root_character_id)?[...new Set([...scene.presentCharacterIds,...cast.filter(member=>member.presentAtStart&&!existingIds.has(member.id)).map(member=>member.id)])]:scene.presentCharacterIds,mode:scene.mode==='direct'?'ensemble':scene.mode});
      const next=expand(world.scene);
      if(next.presentCharacterIds.length>6)throw new ServiceError('SCENE_FULL','拆分后当前场景超过六名人物，请先调整场景。',422);
      await q.query('UPDATE worlds SET scene=$3,revision=revision+1 WHERE owner_id=$1 AND id=$2',[ownerId,worldId,next]);
      const sessions=(await q.query('SELECT id,scene FROM sessions WHERE owner_id=$1 AND world_id=$2 AND scene IS NOT NULL',[ownerId,worldId])).rows;
      for(const session of sessions){const scene=expand(session.scene);if(scene.presentCharacterIds.length>6)throw new ServiceError('SCENE_FULL','拆分后会话场景超过六名人物。',422);await q.query('UPDATE sessions SET scene=$3 WHERE owner_id=$1 AND id=$2',[ownerId,session.id,scene]);}
      await this.locateSceneActors(q,ownerId,worldId,next,world.root_character_id);
      await this.rememberEntities(q,ownerId,worldId,cast.map(member=>member.id),cast.map(member=>member.id));
      await invalidateDirection(q,ownerId,worldId,'源角色卡人物已独立登记，请使用各人物的独立身份安排后续剧情。');
      return this.worldView(q,ownerId,worldId);
    });
  }
  private messageView(row: Row): Message { return { id: row.id, turnId: row.turn_id, sessionId: row.session_id, role: row.role, content: row.content, createdAt: iso(row.created_at), status: row.turn_status === 'running' ? 'pending' : row.turn_status ?? 'committed', kind: row.kind, ...((row.player_name ?? (row.role==='user' ? row.character_name : null)) ? {playerName:row.player_name ?? row.character_name} : {}), ...(row.character_id ? { characterId: row.character_id, characterName: row.character_name } : {}) }; }
  private async page(q: Query, ownerId: string, sessionId: string, before?: string): Promise<{ messages: Message[]; hasMore: boolean; nextBefore: string | null }> {
    await this.scopedSession(q, ownerId, sessionId);
    let boundary: string | null = null;
    if (before) {
      const cursor = uuid(before) ? await this.row(q, 'SELECT seq FROM messages WHERE id=$1 AND session_id=$2 AND owner_id=$3', [before, sessionId, ownerId]) : undefined;
      if (!cursor) throw new ServiceError('CURSOR_INVALID', '消息分页位置无效。', 422); boundary = cursor.seq;
    }
    const all = (await q.query('SELECT m.*,t.status AS turn_status FROM messages m LEFT JOIN turns t ON t.id=m.turn_id AND t.owner_id=m.owner_id WHERE m.session_id=$1 AND m.owner_id=$2 AND ($3::bigint IS NULL OR m.seq<$3) ORDER BY m.seq DESC LIMIT 101', [sessionId, ownerId, boundary])).rows;
    const hasMore = all.length > 100; const messages = all.slice(0, 100).reverse().map((row) => this.messageView(row));
    return { messages, hasMore, nextBefore: hasMore ? messages[0].id : null };
  }
  async messagePage(ownerId: string, sessionId: string, before?: string) { return this.transaction((q) => this.page(q, ownerId, sessionId, before), true); }
  private async sessionDetail(q: Query, ownerId: string, id: string): Promise<SessionDetail> {
    const session = await this.scopedSession(q, ownerId, id);
    return { session: this.sessionView(session), ...await this.page(q, ownerId, id), world: await this.worldView(q, ownerId, session.world_id, session.character_id, session.scene ?? undefined) };
  }
  async getSession(ownerId: string, id: string): Promise<SessionDetail> { return this.transaction((q) => this.sessionDetail(q, ownerId, id), true); }
  private async assertWorldIdle(q: Query, ownerId: string, worldId: string): Promise<void> {
    await this.expireWorld(q, ownerId, worldId);
    if (await this.row(q, "SELECT id FROM turns WHERE world_id=$1 AND owner_id=$2 AND status='running'", [worldId, ownerId])) throw new ServiceError('WORLD_BUSY', '这个故事正在回复，请稍后再调整场景。');
  }
  private async validateScene(q: Query, value: SceneState, ownerId?: string, worldId?: string): Promise<SceneState> {
    if (!value || typeof value !== 'object' || (value.location !== null && (typeof value.location !== 'string' || value.location.length > 120))
      || !Array.isArray(value.presentCharacterIds) || value.presentCharacterIds.length > 6 || value.presentCharacterIds.some(id => typeof id !== 'string' || !id || id.length > 100)
      || new Set(value.presentCharacterIds).size !== value.presentCharacterIds.length
      || (value.mode !== undefined && !['direct','ensemble','observe'].includes(value.mode))
      || (value.playerPresent !== undefined && typeof value.playerPresent !== 'boolean')
      || (value.situation !== undefined && (typeof value.situation !== 'string' || value.situation.length > 1200))) throw new ServiceError('SCENE_INVALID', '场景格式无效，最多选择六名在场角色。', 422);
    const ids = value.presentCharacterIds;
    const rows = worldId ? await q.query("SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND kind='npc' AND id=ANY($3::text[])", [ownerId, worldId, ids]) : await q.query('SELECT id FROM characters WHERE id=ANY($1::text[])', [ids]);
    if (rows.rowCount !== ids.length) throw new ServiceError('CHARACTER_NOT_FOUND', '场景中有不存在的角色。', 422);
    return { ...contextScene(value), location: value.location?.trim() || null };
  }
  async setScene(ownerId: string, worldId: string, expectedRevision: number, scene: SceneState, sessionId?: string): Promise<WorldView> {
    return this.transaction(async q => {
      const world = await this.scopedWorld(q, ownerId, worldId, true);
      await this.assertWorldIdle(q, ownerId, worldId);
      if (world.revision !== expectedRevision) throw new ServiceError('WORLD_CHANGED', '故事已有新的进展，请刷新后再调整场景。');
      const next = await this.validateScene(q, scene, ownerId, worldId);
      let focusId: string | undefined;
      if (sessionId) {
        const session = await this.scopedSession(q, ownerId, sessionId);
        if (session.world_id !== worldId) throw new ServiceError('SESSION_NOT_FOUND', '会话不属于这个故事。', 404);
        focusId = session.character_id;
        await q.query('UPDATE sessions SET scene=$3 WHERE id=$1 AND owner_id=$2', [sessionId, ownerId, next]);
      }
      await this.locateSceneActors(q, ownerId, worldId, next, focusId, true);
      await q.query("UPDATE worlds SET scene=$3::jsonb || jsonb_build_object('updatedAt',clock_timestamp()),revision=revision+1 WHERE id=$1 AND owner_id=$2", [worldId, ownerId, next]);
      await invalidateDirection(q,ownerId,worldId,'用户主动调整了场景，请依据新场景修订主线。');
      return this.worldView(q, ownerId, worldId);
    });
  }
  async setWorldClock(ownerId: string, worldId: string, expectedRevision: number, value: { mode: WorldClock['mode']; rate: number }): Promise<WorldView> {
    if (!value || !['paused','quiet','active'].includes(value.mode) || !Number.isFinite(value.rate) || value.rate < 0.1 || value.rate > 60 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ServiceError('CLOCK_INVALID', '世界节奏或版本无效。', 422);
    return this.transaction(async q => {
      const world = await this.scopedWorld(q, ownerId, worldId, true);
      await this.assertWorldIdle(q, ownerId, worldId);
      if (world.revision !== expectedRevision) throw new ServiceError('WORLD_CHANGED', '故事已有新的进展，请刷新后调整节奏。');
      const projected = this.projection(world, await this.now(q));
      await q.query('UPDATE worlds SET real_anchor_at=$3,clock_world_ms=$4,clock_active_ms=$5,clock_mode=$6,clock_rate=$7,revision=revision+1 WHERE owner_id=$1 AND id=$2', [ownerId, worldId, projected.clock.asOf, projected.clock.toWorldMs, projected.activeMs, value.mode, value.rate]);
      return this.worldView(q, ownerId, worldId);
    });
  }
  async setMemoryStatus(ownerId: string, worldId: string, eventId: string, expectedRevision: number, status: 'active' | 'retracted'): Promise<WorldView> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !['active', 'retracted'].includes(status)) throw new ServiceError('INPUT_INVALID', '记忆状态或故事版本无效。', 422);
    return this.transaction(async q => {
      const world = await this.scopedWorld(q, ownerId, worldId, true);
      await this.assertWorldIdle(q, ownerId, worldId);
      if (world.revision !== expectedRevision) throw new ServiceError('WORLD_CHANGED', '故事已有新的进展，请刷新后再调整记忆。');
      const event = uuid(eventId) ? await this.row(q, 'SELECT * FROM events WHERE id=$1 AND owner_id=$2 AND world_id=$3 FOR UPDATE', [eventId, ownerId, worldId]) : undefined;
      if (!event) throw new ServiceError('MEMORY_NOT_FOUND', '记忆不存在。', 404);
      if (status === 'active') {
        const valid = await this.row(q, `SELECT e.id FROM events e JOIN turns t ON t.id=e.source_turn_id AND t.owner_id=e.owner_id AND t.world_id=e.world_id AND t.character_id=e.character_id WHERE e.id=$1 AND e.owner_id=$2 AND e.world_id=$3 AND ${verifiedEvidence}`, [eventId, ownerId, worldId]);
        if (!valid || event.status === 'unverified') throw new ServiceError('MEMORY_UNVERIFIED', '旧记忆缺少已验证的用户原文依据，不能直接恢复。', 409);
      }
      if (event.status !== status) {
        await q.query('UPDATE events SET status=$4 WHERE id=$1 AND owner_id=$2 AND world_id=$3', [eventId, ownerId, worldId, status]);
        await q.query('UPDATE worlds SET revision=revision+1 WHERE id=$1 AND owner_id=$2', [worldId, ownerId]);
      }
      return this.worldView(q, ownerId, worldId);
    });
  }
  async listPlayerProfiles(ownerId: string) { return profiles(this.pool,ownerId); }
  async savePlayerProfile(ownerId: string,id: string|null,value: {name:string;persona:string;expectedVersion?:number}) {
    return this.transaction(q=>saveProfile(q,ownerId,id,value));
  }
  async deletePlayerProfile(ownerId: string,id: string,expectedVersion: number) {
    validateProfileVersion(expectedVersion);
    return this.transaction(async q=>{
      await profile(q,ownerId,id);
      const r=await q.query('DELETE FROM player_profiles WHERE owner_id=$1 AND id=$2 AND version=$3',[ownerId,id,expectedVersion]);
      if(!r.rowCount) throw new ServiceError('PROFILE_CHANGED','身份已被修改，请重新载入。',409);
    });
  }
  async setPlayerProfile(ownerId: string,worldId: string,id: string|null,expectedRevision: number) {
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0) throw new ServiceError('INPUT_INVALID','故事版本无效。',422);
    return this.transaction(async q=>{
      const world=await this.scopedWorld(q,ownerId,worldId,true);
      await this.assertWorldIdle(q,ownerId,worldId);
      if(world.revision!==expectedRevision) throw new ServiceError('WORLD_CHANGED','故事已更新，请刷新后切换身份。',409);
      const snapshot=id===null?null:await profile(q,ownerId,id);
      await q.query('UPDATE worlds SET player_profile=$3,revision=revision+1 WHERE owner_id=$1 AND id=$2',[ownerId,worldId,snapshot]);
      await invalidateDirection(q,ownerId,worldId,'用户切换了身份，请根据新的身份修订主线。');
      return this.worldView(q,ownerId,worldId);
    });
  }
  /** Internal runtime bridge only. Frozen source IDs are supplied by Harness;
   * never expose this identity-resolving method as an HTTP/tool argument surface. */
  async readDialogueForSource(request:DialogueReadRequest):Promise<DialogueReadResult> {
    if(!request || !uuid(request.sourceTurnId) || !uuid(request.worldId)) throw new ServiceError('DIALOGUE_SCOPE','原文读取范围无效。',403);
    const source=await this.row(this.pool,'SELECT owner_id FROM turns WHERE id=$1 AND world_id=$2',[request.sourceTurnId,request.worldId]);
    this.pruneDialoguePreviews();
    const preview=this.dialoguePreviews.get(request.sourceTurnId);
    const ownerId=source?.owner_id ?? (preview?.worldId===request.worldId ? preview.ownerId : undefined);
    if(!ownerId) throw new ServiceError('DIALOGUE_SCOPE','原文读取范围无效或试跑已过期。',403);
    return this.readDialogue(ownerId,request);
  }
  async readDialogue(ownerId:string,request:DialogueReadRequest):Promise<DialogueReadResult> {
    if(!request || Object.keys(request).some(key=>!['worldId','sourceTurnId','characterId','query','turnIds','limit'].includes(key))
      || !uuid(request.worldId) || !uuid(request.sourceTurnId) || typeof request.characterId!=='string' || !request.characterId || request.characterId.length>200
      || request.query!==undefined && (typeof request.query!=='string' || request.query.length>400)
      || request.limit!==undefined && (!Number.isInteger(request.limit) || request.limit<1 || request.limit>3)
      || request.turnIds!==undefined && (!Array.isArray(request.turnIds) || !request.turnIds.length || request.turnIds.length>3 || new Set(request.turnIds).size!==request.turnIds.length || request.turnIds.some(id=>typeof id!=='string' || !uuid(id)))) throw new ServiceError('DIALOGUE_SCOPE','原文读取范围无效；最多读取三个过去回合。',403);
    return this.transaction(async q=>{
      this.pruneDialoguePreviews();
      const stored=await this.row(q,'SELECT * FROM turns WHERE owner_id=$1 AND world_id=$2 AND id=$3',[ownerId,request.worldId,request.sourceTurnId]);
      const preview=this.dialoguePreviews.get(request.sourceTurnId);
      const scopedPreview=preview?.ownerId===ownerId && preview.worldId===request.worldId ? preview : undefined;
      const source=stored ?? (scopedPreview ? {seq:scopedPreview.beforeSeq} : undefined);
      const authorized=stored ? (stored.character_id===request.characterId || Object.prototype.hasOwnProperty.call(stored.input_json.worldContext?.actorInputs ?? {},request.characterId) || !!await this.row(q,"SELECT id FROM messages WHERE owner_id=$1 AND turn_id=$2 AND role='assistant' AND character_id=$3 LIMIT 1",[ownerId,stored.id,request.characterId])) : scopedPreview?.characterIds.includes(request.characterId);
      if(!authorized) throw new ServiceError('DIALOGUE_SCOPE','不能读取此角色或世界的对话。',403);
      if(request.turnIds) {
        if(request.turnIds.some(id=>scopedPreview?.excludedTurnIds.includes(id))) throw new ServiceError('DIALOGUE_SCOPE','请求包含试跑开始后才完成的回合。',403);
        const rows=(await q.query(`SELECT id FROM turns WHERE owner_id=$1 AND world_id=$2 AND seq<$3 AND status='committed' AND id=ANY($4::uuid[])
          AND ($5=ANY(episode_participant_ids) OR EXISTS(SELECT 1 FROM jsonb_array_elements(activities) a WHERE a->>'characterId'=$5))`,[ownerId,request.worldId,source!.seq,request.turnIds,request.characterId])).rows;
        if(rows.length!==request.turnIds.length) throw new ServiceError('DIALOGUE_SCOPE','请求包含不属于本角色的、未发生或不可用的回合。',403);
      }
      const limit=request.limit ?? 3;
      const candidates=await this.episodes(q,ownerId,request.worldId,request.characterId,limit+1,undefined,{beforeSeq:source!.seq,turnIds:request.turnIds,query:request.query?.trim(),excludedTurnIds:scopedPreview?.excludedTurnIds});
      const result:DialogueReadResult={episodes:[],truncated:false};
      const turns=new Set<string>();
      for(const episode of candidates.reverse()) {
        if(!turns.has(episode.turnId) && turns.size>=limit) {result.truncated=true;continue;}
        const candidate={...result,episodes:[...result.episodes,episode]};
        if(JSON.stringify(candidate).length>12000) {result.truncated=true;continue;}
        result.episodes.push(episode);turns.add(episode.turnId);
      }
      result.episodes.reverse();
      return result;
    },true);
  }
  async previewInput(ownerId: string, sessionId: string, userText: string): Promise<ActorInput> {
    return this.transaction(async q => {
      const session = await this.scopedSession(q, ownerId, sessionId);
      const world = await this.scopedWorld(q, ownerId, session.world_id);
      const input=await this.visibleInput(q, ownerId, session, world, randomUUID(), userText);
      const edge=await this.row(q,"SELECT (COALESCE(max(seq),0)+1)::text AS before_seq FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed'",[ownerId,world.id]);
      const excluded=(await q.query("SELECT id FROM turns WHERE owner_id=$1 AND world_id=$2 AND seq<$3 AND status<>'committed'",[ownerId,world.id,edge!.before_seq])).rows.map(row=>row.id);
      this.dialoguePreviews.set(input.turnId,{ownerId,worldId:world.id,characterIds:[...new Set([input.character.id,...Object.keys(input.worldContext?.actorInputs ?? {})])],beforeSeq:edge!.before_seq,excludedTurnIds:excluded,expiresAt:Date.now()+5*60_000});
      this.pruneDialoguePreviews();
      return input;
    }, true);
  }
  private async visibleInput(q: Query, ownerId: string, session: Row, world: Row, turnId: string, content: string, operation: 'chat' | 'opening' = 'chat', actorId = session.character_id, includeActors = true, frozen?: { clock: WorldClock; activeMs: number; temporal?: TemporalContext }, snapshot?: ContextSnapshot): Promise<ActorInput> {
    const living = this.livingWorld || session.dynamic_opening;
    snapshot ??= living ? await loadContextSnapshot(q,ownerId,world.id) : undefined;
    const entityRow = snapshot ? snapshot.entities.find(row=>row.id===actorId && row.kind==='npc') : await this.row(q, "SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'", [ownerId, world.id, actorId]);
    if (!entityRow) throw new ServiceError('CHARACTER_NOT_FOUND', '角色不属于这个世界。', 404);
    const character = !living && !entityRow.state.authoredCastKey ? await this.row(q, 'SELECT * FROM characters WHERE id=$1', [actorId]) : undefined;
    const profile = character ?? { id: entityRow.id, name: entityRow.name, description: entityRow.description, definition: entityRow.state.definition ?? entityRow.description, greeting: entityRow.state.greeting ?? '' };
    const templateNames = { char: authorNarrativeName(entityRow.state.narrativeName) ?? profile.name, user: world.player_profile?.name || '玩家' };
    const cardText = (text: unknown) => resolveRoleplayTemplate(String(text ?? ''), templateNames);
    // Materialize only authored card fields. User messages and historical evidence stay literal.
    const renderedCard = { description: cardText(profile.description), definition: cardText(profile.definition), greeting: cardText(profile.greeting) };
    const recent = living ? [] : (await q.query("SELECT id FROM turns WHERE session_id=$1 AND owner_id=$2 AND status='committed' ORDER BY seq DESC LIMIT 12", [session.id, ownerId])).rows;
    const groups: ActorInput['history'][] = []; let chars = 0;
    for (const turn of recent) {
      const group = (await q.query('SELECT role,content FROM messages WHERE turn_id=$1 AND owner_id=$2 ORDER BY seq', [turn.id, ownerId])).rows as ActorInput['history'];
      const size = group.reduce((n, message) => n + message.content.length, 0);
      if (chars + size > 6000) break; groups.push(group); chars += size;
    }
    const history = groups.reverse().flat();
    // Only an actual static welcome in this session can seed legacy history.
    // An empty continuation (or a dropped oversized turn) must not replay the card.
    const initialGreeting = !living && recent.length === 0 ? await this.row(q, "SELECT content FROM messages WHERE owner_id=$1 AND session_id=$2 AND character_id=$3 AND role='assistant' AND turn_id IS NULL ORDER BY seq LIMIT 1", [ownerId, session.id, actorId]) : undefined;
    if (initialGreeting) history.push({ role: 'assistant', content: cardText(initialGreeting.content) });
    if (living) history.length = 0;
    const visible = living ? [] : (await q.query(`SELECT e.kind,e.text,e.visibility,e.character_id,e.evidence,t.episode_observations,t.input_json ? 'worldContext' AS living_source FROM events e JOIN turns t ON t.id=e.source_turn_id AND t.owner_id=e.owner_id AND t.world_id=e.world_id AND t.character_id=e.character_id WHERE e.world_id=$1 AND e.owner_id=$2 AND e.status='active' AND (e.visibility='public' OR e.character_id=$3) AND ${verifiedEvidence} ORDER BY e.seq DESC LIMIT 100`, [world.id, ownerId, profile.id])).rows;
    const actualScene: SceneState = { ...contextScene(session.scene ?? world.scene), ...(living ? { mode: (session.scene ?? world.scene).mode ?? 'ensemble' } : {}) };
    if (actorId === session.character_id && !actualScene.presentCharacterIds.includes(profile.id)) throw new ServiceError('CHARACTER_NOT_PRESENT', '此角色当前不在场，请先让角色登场或切换会话。');
    const hears = actualScene.presentCharacterIds.includes(actorId) && (actualScene.mode !== 'direct' || actorId === session.character_id);
    const scene: SceneState = hears ? actualScene : { location: typeof entityRow.state.locationId === 'string' ? entityRow.state.locationId : null, presentCharacterIds: [actorId], mode: 'direct' };
    const availableIds = [...new Set([profile.id, ...scene.presentCharacterIds])];
    if (availableIds.length > 6) throw new ServiceError('SCENE_FULL', '在场角色已达六名，请先调整场景再与此角色对话。');
    const available = snapshot ? snapshot.entities.filter(row=>row.kind==='npc' && availableIds.includes(row.id)).map(row=>({id:row.id,name:row.name})) : (await q.query("SELECT id,name FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND kind='npc' AND id=ANY($3::text[]) ORDER BY id", [ownerId, world.id, availableIds])).rows;
    // Main gets the raw action to adjudicate perception. Prebuilt actor packets do not:
    // Harness supplies each actor's validated observation after its scene decision.
    const narrativeName = authorNarrativeName(entityRow.state.narrativeName);
    const input: ActorInput = { ...(world.player_profile ? {playerProfile:world.player_profile} : {}), turnId, character: { id: profile.id, name: profile.name, ...(narrativeName ? { narrativeName } : {}), description: renderedCard.description, greeting: living ? renderedCard.greeting : initialGreeting ? cardText(initialGreeting.content) : '', definition: renderedCard.definition }, history, world: { id: world.id, revision: world.revision, events: [] }, scene, availableCharacters: available, userText: living ? (includeActors ? content : '') : (hears ? content : '') };
    // The full persona/current input are mandatory. Memory uses the remaining global
    // window, newest first; complete recent exchanges yield space before memory does.
    while (JSON.stringify(input).length > 23000 && input.history.length) input.history.splice(0, input.history[0].role === 'user' ? 2 : 1);
    if (JSON.stringify(input).length > 23000) throw new ServiceError('INPUT_TOO_LARGE', '角色设定与当前消息超过上下文限制，请缩短消息。', 422);
    for (const row of visible) {
      const perceived = observationText(row.episode_observations?.[actorId]);
      if (living && ((row.episode_observations && !perceived) || (!row.episode_observations && row.living_source))) continue;
      const event: WorldChange = { kind: row.kind, text: row.episode_observations ? perceived : row.text, visibility: row.visibility, characterId: row.character_id, evidence: row.evidence };
      const previousHistory = input.history;
      input.history = [...previousHistory];
      input.world.events.unshift(event);
      while (JSON.stringify(input).length > 23000 && input.history.length) input.history.splice(0, input.history[0].role === 'user' ? 2 : 1);
      if (JSON.stringify(input).length > 23000) {
        // Never cut a quote (which could remove its negation). Skip only a whole
        // entry that cannot fit, restoring history if that candidate was rejected.
        input.world.events.shift(); input.history = previousHistory;
      }
    }
    if (living) {
      const projected = frozen ?? this.projection(world, await this.now(q));
      const actorTemporal = await this.temporal(q,ownerId,world,actualScene,projected.clock.asOf,actorId,snapshot);
      const temporalBase = frozen?.temporal ? { ...frozen.temporal, settlementEligible: actorTemporal.settlementEligible } : actorTemporal;
      const temporal: TemporalContext = { ...structuredClone(temporalBase), story: actorStoryTime(temporalBase.story),
        ...(typeof entityRow.state.lastEncounterAt === 'string' ? { lastEncounter: { recordedAt: entityRow.state.lastEncounterAt, storyTime: validStoryTime(entityRow.state.lastEncounterStoryTime) ? actorStoryTime(entityRow.state.lastEncounterStoryTime) : unknownStoryTime() } } : {}),
        ...(typeof entityRow.state.lastSettledAt === 'string' ? { lastSettled: { recordedAt: entityRow.state.lastSettledAt, storyTime: validStoryTime(entityRow.state.lastSettledStoryTime) ? actorStoryTime(entityRow.state.lastSettledStoryTime) : unknownStoryTime(), ...(typeof entityRow.state.lastSettledStoryMs === 'number' ? {storyElapsedTotalMs:entityRow.state.lastSettledStoryMs} : {}) } } : {}) };
      const known = knownEntityRows(snapshot!,actorId).map(({row,observedAt,sourceTurnId})=>({...this.entityView(row),...(observedAt?{knowledge:{observedAt:iso(observedAt),sourceTurnId:sourceTurnId!}}:{})}));
      const safeEntities = known.map(entity => {
        const state = { ...entity.state };
        for (const key of internalStateKeys) delete state[key];
        if (entity.kind === 'npc') {
          delete state.definition; delete state.greeting;
          // Knowing a person's public identity does not grant their private growth record.
          delete state.arc; delete state.arcProvenance; delete state.characterView;
          const view = entity.id === actorId ? characterView(entity.state) : undefined;
          if (view) state.characterView = view;
          const clock = this.actorClock(entity, projected); state.pendingRealMs = clock.elapsedRealMs; state.pendingActiveRealMs = clock.activeElapsedRealMs; state.pendingWorldMs = clock.elapsedWorldMs;
        }
        return { ...entity, description: entity.kind === 'npc' ? resolveRoleplayTemplate(entity.description, { char: authorNarrativeName(entity.state.narrativeName) ?? entity.name, user: templateNames.user }) : entity.description, state };
      });
      input.operation = operation;
      input.eventLedger=snapshot!.eventLedger.filter(event=>event.subjectId===actorId || event.entityId && safeEntities.some(entity=>entity.id===event.entityId));
      // Dialogue evidence is available through a scoped read tool, never repeated
      // in every default prompt. The durable archive is unchanged.
      input.episodes = [];
      const priority = (entity: WorldEntity) => entity.kind === 'npc' && entity.id === actorId ? 5
        : entity.kind === 'quest' && ['proposed','active'].includes(String(entity.state.status)) ? 4
        : entity.kind === 'item' ? 3 : entity.kind === 'location' && (entity.id === entityRow.state.locationId || entity.name === scene.location) ? 2 : 1;
      const prioritized = safeEntities.sort((a, b) => priority(b) - priority(a) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
      const actorClock = this.actorClock(this.entityView(entityRow), projected);
      input.worldContext = { entities: prioritized, clock: { ...actorClock, elapsedRealMs:temporal.real.elapsedMs,fromRealAt:temporal.real.previousTurnAt ?? temporal.real.now,toWorldMs: projected.clock.fromWorldMs, elapsedWorldMs: 0, activeElapsedRealMs: 0 }, actorInputs: {}, temporal,
        entityHeadVersions: Object.fromEntries(snapshot!.entities.filter(entity => prioritized.some(known => known.id === entity.id)).map(entity => [entity.id,entity.version ?? 1])) };
      const pending=snapshot!.pending.filter(row=>row.status==='completed'?row.unresolvedCharacterIds.includes(actorId):row.episode_participant_ids.includes(actorId) || row.activities.some((activity:any)=>activity.characterId===actorId)).slice(-32);
      const view=characterView(entityRow.state);
      input.contextPack={version:1,worldRevision:world.revision,characterId:actorId,
        card:{id:profile.id,name:profile.name,description:renderedCard.description,personality:renderedCard.definition,openingBackground:renderedCard.greeting},
        memory:{summary:authoredMemorySummary(entityRow.state,view?.summary??''),...(view?.provenance.turnId ? {sourceTurnId:view.provenance.turnId,throughSeq:snapshot!.turnSeqs.get(view.provenance.turnId) ?? 0}: {}),...(snapshot!.eventLedgerOverflow?.omittedOpenEvents?{openEventsOmitted:snapshot!.eventLedgerOverflow.omittedOpenEvents}:{}),pendingTurnIds:pending.map(row=>row.id)},
        dialogue:{mode:'on_demand',beforeTurnId:turnId}};
      input.history=[];input.episodes=[];input.world.events=[];input.character.greeting='';
      // Compatibility character fields are internal; the Harness emits the card
      // once from contextPack. Budget that projected packet, not both copies.
      const projectedSize=()=>JSON.stringify({...input,character:{id:input.character.id,name:input.character.name,narrativeName:input.character.narrativeName}}).length;
      while(projectedSize()>30000 && input.worldContext.entities.length>1) input.worldContext.entities.pop();
      if(projectedSize()>30000) throw new ServiceError('INPUT_TOO_LARGE','角色背景与当前消息超过上下文限制，请缩短消息。',422);
      if (includeActors) {
        // Preserve the card reference separately from the cleared performance
        // greeting. It is a template, not a replayed event or shared NPC knowledge.
        input.directorContext = { openingReference: renderedCard.greeting.slice(0,1200) };
        // Absent packets are frozen service-only inputs for offline catch-up. The
        // shared snapshot makes these pure projections; Actor exposes only the current cast.
        const npcs = snapshot!.entities.filter(entity => entity.kind === 'npc');
        for (const npc of npcs) input.worldContext.actorInputs[npc.id] = await this.visibleInput(q, ownerId, session, world, turnId, content, operation, npc.id, false, { ...projected, temporal: temporalBase }, snapshot);
      }
    }
    if (includeActors && operation === 'chat' && input.worldContext) {
      const prepared = await readPreparedDirection(q, ownerId, input);
      if (prepared !== undefined) input.preparedScenePlan = prepared;
    }
    return input;
  }
  private stored(row: Row, replayed: boolean): StoredTurn { return { id: row.id, ownerId: row.owner_id, sessionId: row.session_id, worldId: row.world_id, status: row.status, phase: row.phase, attempt: row.attempt, draft: row.actor_draft, input: row.input_json, replayed, runtimeMetadata: row.runtime_metadata, usage: row.usage, checkpoint: row.runtime_checkpoint }; }
  async beginTurn(ownerId: string, sessionId: string, clientTurnId: string, content: string, metadata: Record<string, unknown> = {}, options: { operation?: 'chat' | 'opening' } = {}): Promise<StoredTurn> {
    metadata = { ...metadata, memoryPolicy: MEMORY_POLICY };
    return this.transaction(async (q) => {
      const session = await this.scopedSession(q, ownerId, sessionId);
      const world = await this.scopedWorld(q, ownerId, session.world_id, true);
      await this.expireWorld(q, ownerId, world.id);
      const hash = createHash('sha256').update(content).digest('hex');
      let previous = await this.row(q, 'SELECT * FROM turns WHERE session_id=$1 AND owner_id=$2 AND client_turn_id=$3', [sessionId, ownerId, clientTurnId]);
      let restartingOpening = false;
      const operation = options.operation ?? 'chat';
      if (!['chat','opening'].includes(operation) || (operation === 'opening' && (!session.dynamic_opening || clientTurnId !== `opening:${sessionId}`))) throw new ServiceError('OPENING_INVALID', '开场请求无效。', 422);
      if (previous) {
        if (previous.content_hash !== hash || previous.operation !== operation) throw new ServiceError('CLIENT_TURN_CONFLICT', '此请求编号已用于另一条消息。');
        if (previous.status === 'committed') return this.stored(previous, true);
        if (previous.status === 'running') throw new ServiceError('TURN_RUNNING', '这条消息仍在处理中，请稍后恢复。');
        const configChanged=!isDeepStrictEqual(previous.runtime_metadata,JSON.parse(JSON.stringify(metadata)));
        const contextChanged=previous.base_revision!==world.revision;
        if(operation==='chat' && (configChanged||contextChanged)) {
          // Failed transport diagnostics and successful reads are not an Actor result.
          const hasResult=previous.actor_draft!==null || previous.runtime_checkpoint!==null || await this.row(q,
            `SELECT id FROM agent_calls WHERE owner_id=$1 AND turn_id=$2 AND (record->>'status' IN ('completed','reused') OR
              (record->'output' IS NOT NULL AND record->'output'<>'null'::jsonb AND
               CASE WHEN jsonb_typeof(record->'output')='object' THEN ((record->'output') - 'provider' - 'dialogueReads')<>'{}'::jsonb ELSE true END)) LIMIT 1`,[ownerId,previous.id]);
          if(previous.status!=='failed'||hasResult)throw new ServiceError(configChanged?'RUNTIME_CHANGED':'WORLD_CHANGED','本轮已有生成结果或状态发生变化，请刷新后核对。');
          if(contextChanged) {
            const later=await this.row(q,'SELECT id FROM turns WHERE owner_id=$1 AND world_id=$2 AND seq>$3 LIMIT 1',[ownerId,world.id,previous.seq]);
            const sameScene=isDeepStrictEqual(contextScene(world.scene),contextScene(previous.input_json.scene));
            const earlierSettlement=await this.row(q,"SELECT j.id FROM world_settlements j JOIN turns t ON t.id=j.turn_id WHERE t.owner_id=$1 AND t.world_id=$2 AND t.seq<$3 AND j.status='completed' AND j.updated_at>$4 LIMIT 1",[ownerId,world.id,previous.seq,previous.created_at]);
            if(later||!earlierSettlement||!sameScene||!isDeepStrictEqual(world.player_profile??null,previous.input_json.playerProfile??null))throw new ServiceError('WORLD_CHANGED','故事已有新的场景、身份或消息，请作为新消息重新发送。');
          }
          const projected=contextChanged?this.projection(world,await this.now(q)):previous.clock_snapshot;
          const refreshed=contextChanged?await this.visibleInput(q,ownerId,session,world,previous.id,content,operation,session.character_id,true,projected):previous.input_json;
          previous=(await q.query(`UPDATE turns SET runtime_history=runtime_history || jsonb_build_array(jsonb_build_object(
            'attemptId',attempt,'runtimeMetadata',runtime_metadata,'input',input_json,'baseRevision',base_revision,
            'status',status,'errorCode',error_code,'errorMessage',error_message,'recordedAt',clock_timestamp())),
            runtime_metadata=$3,input_json=$4,base_revision=$5,clock_snapshot=$6 WHERE owner_id=$1 AND id=$2 RETURNING *`,[ownerId,previous.id,metadata,refreshed,world.revision,projected])).rows[0];
        } else if(configChanged) {
          if(previous.base_revision!==world.revision)throw new ServiceError('WORLD_CHANGED','故事已有新的进展，请新建会话生成开场。');
          await q.query('UPDATE turns SET client_turn_id=$3 WHERE id=$1 AND owner_id=$2',[previous.id,ownerId,`${clientTurnId}:archived:${previous.id}`]);
          previous=undefined;restartingOpening=true;
        }
      }
      if (operation === 'opening' && !previous && !restartingOpening && await this.row(q, 'SELECT id FROM messages WHERE owner_id=$1 AND session_id=$2 LIMIT 1', [ownerId, sessionId])) throw new ServiceError('OPENING_ALREADY_STARTED', '此会话已有对话，不能重新生成开场。');
      if (await this.row(q, "SELECT id FROM turns WHERE world_id=$1 AND owner_id=$2 AND status='running'", [world.id, ownerId])) throw new ServiceError('WORLD_BUSY', '这个故事正在回复，请稍后再发送。');
      if (previous && previous.base_revision !== world.revision) throw new ServiceError('WORLD_CHANGED', '故事已有新的进展，请作为新消息重新发送。');
      await pauseDirectionForTurn(q,ownerId,world.id);
      const attempt = randomUUID();
      const initialPhase = operation==='opening' || metadata.orchestration && metadata.orchestration!=='scene-actor-first-v1' ? 'planning' : 'responding';
      if (previous) {
        const row = (await q.query("UPDATE turns SET status='running',phase=$3,attempt=$4,lease_expires_at=clock_timestamp()+$5*interval '1 millisecond',error_code=NULL,error_message=NULL,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING *", [previous.id, ownerId, previous.actor_draft ? 'settling' : initialPhase, attempt, this.leaseMs])).rows[0];
        return this.stored(row, true);
      }
      const id = randomUUID(); const projected = this.projection(world, await this.now(q));
      const input = await this.visibleInput(q, ownerId, session, world, id, content, operation, session.character_id, true, projected);
      const row = (await q.query("INSERT INTO turns(id,owner_id,world_id,session_id,character_id,client_turn_id,content_hash,status,phase,base_revision,input_json,runtime_metadata,attempt,lease_expires_at,operation,clock_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,'running',$13,$8,$9,$10,$11,clock_timestamp()+$12*interval '1 millisecond',$14,$15) RETURNING *", [id, ownerId, world.id, sessionId, session.character_id, clientTurnId, hash, world.revision, input, metadata, attempt, this.leaseMs, initialPhase, operation, projected])).rows[0];
      await q.query("INSERT INTO messages(id,owner_id,world_id,session_id,turn_id,role,content,kind,character_name,player_name) VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,$8)", [randomUUID(), ownerId, world.id, sessionId, id, content, operation === 'opening' ? 'operation' : 'dialogue',world.player_profile?.name ?? null]);
      return this.stored(row, false);
    });
  }
  async saveDraft(turn: StoredTurn, text: string, modelUsage?: ModelUsage): Promise<void> {
    const count = usage(modelUsage);
    const result = await this.pool.query("UPDATE turns SET actor_draft=$4,phase='settling',usage=usage || $5::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp()", [turn.id, turn.ownerId, turn.attempt, text, JSON.stringify(count ? { actor: count } : {})]);
    if (result.rowCount !== 1) throw new ServiceError('TURN_LEASE_LOST', '本轮执行已结束或过期。');
  }
  private async applyEntities(q: Query, current: Row, changes: EntityChange[], audience: string[], sources: { observations: Record<string, Observation> | null; replies: SpeakerReply[]; activities: WorldActivity[]; storyTime?: StoryTime; attributedEvidence?: WorldTurnResult['attributedEvidence']; eventLedger?:WorldTurnResult['eventLedger'] }): Promise<void> {
    // At most 3 performer views + 5 items + 5 quests + 3 discoveries + 4 scene identities/places.
    if (!Array.isArray(changes) || changes.length > 20 || new Set(changes.map(change => change?.entity?.id)).size !== changes.length) throw new ServiceError('ENTITY_INVALID', '世界档案变更无效。', 422);
    const before = await this.entities(q, current.owner_id, current.world_id);
    const writerKnowledge=new Map((await q.query('SELECT entity_id,snapshot FROM world_entity_knowledge WHERE owner_id=$1 AND world_id=$2 AND character_id=$3',[current.owner_id,current.world_id,(current.input_json as ActorInput).character.id])).rows.map(row=>[row.entity_id,row.snapshot]));
    const additions = changes.filter(change => change.op === 'create');
    if (additions.filter(change => change.entity.kind === 'npc').length > 2 || before.filter(entity => entity.kind === 'npc').length + additions.filter(change => change.entity.kind === 'npc').length > 24 || before.length + additions.length > 256) throw new ServiceError('WORLD_ENTITY_LIMIT', '本轮或世界中的角色与档案数量超过限制。', 422);
    const npcIds = new Set([...before.filter(entity => entity.kind === 'npc').map(entity => entity.id), ...additions.filter(change => change.entity.kind === 'npc').map(change => change.entity.id)]);
    const locationIds = new Set([...before.filter(entity => entity.kind === 'location').map(entity => entity.id), ...additions.filter(change => change.entity.kind === 'location').map(change => change.entity.id)]);
    const observedUpdates: Array<{ id: string; witnesses: string[] }> = [];
    for (const change of changes) {
      const entity = change.entity;
      if (!entity || !['create','update'].includes(change.op) || !['npc','location','item','quest','faction'].includes(entity.kind) || typeof entity.id !== 'string'
        || typeof entity.name !== 'string' || !entity.name.trim() || entity.name.length > 120 || typeof entity.description !== 'string' || entity.description.length > 6000
        || (entity.state !== undefined && (!entity.state || typeof entity.state !== 'object' || Array.isArray(entity.state) || JSON.stringify(entity.state).length > 14000))) throw new ServiceError('ENTITY_INVALID', '世界档案格式无效。', 422);
      const prior = before.find(row => row.id === entity.id);
      const personalActivityMemory=entity.kind==='npc' && typeof entity.state?.arc==='string' && change.arcSource?.source==='pulse'
        && change.arcSource.characterId===entity.id && typeof change.arcSource.quote==='string' && change.arcSource.quote.trim().length>0
        && sources.activities.some(activity=>activity.characterId===entity.id && activity.kind==='completed' && activity.text.includes(change.arcSource!.quote));
      if (change.op === 'create' && (!uuid(entity.id) || prior || await this.row(q, 'SELECT id FROM characters WHERE id=$1', [entity.id]))) throw new ServiceError('ENTITY_INVALID', '新实体必须使用本世界的新编号。', 422);
      if (change.op === 'update' && (!prior || prior.kind !== entity.kind || !prior.knownByCharacterIds.some(id => audience.includes(id)) && !personalActivityMemory)) throw new ServiceError('ENTITY_NOT_KNOWN', '不能修改当前角色未知的档案。', 422);
      const frozenEntities = (current.input_json as ActorInput).worldContext?.entities;
      const expectedVersion = change.baseVersion ?? frozenEntities?.find(row => row.id === entity.id)?.version;
      if (prior && expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion !== prior.version)) throw new ServiceError('ENTITY_VERSION_CONFLICT', '角色所知档案已过时，不能用旧版本覆盖当前状态。', 422);
      const normalizeName = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase();
      const questOwner=entity.state?.ownerCharacterId??prior?.state.ownerCharacterId??null;
      const sameOwner=(row:{state?:Record<string,unknown>})=>entity.kind!=='quest'||(row.state?.ownerCharacterId??null)===questOwner;
      if (before.some(row => row.id !== entity.id && row.kind === entity.kind && sameOwner(row) && normalizeName(row.name) === normalizeName(entity.name)) || changes.some(other => other !== change && other.entity.kind === entity.kind && sameOwner(other.entity) && normalizeName(other.entity.name) === normalizeName(entity.name))) throw new ServiceError('ENTITY_NAME_CONFLICT', '同一世界已有同名同类档案，请复用其编号。', 422);
      const state = { ...entity.state };
      // The application adapter may attach seed identity; the database derives it again.
      if (change.op === 'create' && entity.kind === 'npc') { delete state.origin; delete state.rootCharacterId; }
      if (internalStateKeys.some(key => key in state)) throw new ServiceError('ENTITY_INVALID', '模型不能修改宿主时间游标或角色来源。', 422);
      if (['narrativeName','narrativeAliases','authoredCastKey'].some(key=>key in state) || prior?.state.authoredCastKey && entity.name!==prior.name) throw new ServiceError('ENTITY_LOCKED', '正文姓名与原卡人物身份只能来自作者角色资料。', 422);
      if ('arcProvenance' in state || 'characterView' in state) throw new ServiceError('ARC_SOURCE_INVALID', '角色视角的来源和可信类别只能由宿主生成。', 422);
      if (change.arcSource !== undefined && (entity.kind !== 'npc' || typeof state.arc !== 'string')) throw new ServiceError('ARC_SOURCE_INVALID', '视角来源只能关联本轮角色摘要。', 422);
      if (entity.kind === 'npc' && 'locationId' in state) throw new ServiceError('ENTITY_INVALID', '角色当前位置只能由已确认的场景维护。', 422);
      if (entity.kind === 'npc' && 'arc' in state && !audience.includes(entity.id) && !personalActivityMemory) throw new ServiceError('KNOWLEDGE_SCOPE', '不能把本轮私密互动写入未参与角色的成长记录。', 422);
      if (entity.kind === 'npc' && 'arc' in state) {
        if (typeof state.arc !== 'string') throw new ServiceError('ENTITY_INVALID', '角色视角摘要必须是文本。', 422);
        const evidence = change.arcSource;
        let provenance: ArcProvenance = { kind: 'character_view', status: 'legacy_unverified', turnId: current.id };
        if (evidence !== undefined) {
          if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
            || Object.keys(evidence).some(key => !['source', 'quote', 'characterId'].includes(key))
            || !['user', 'actor', 'pulse'].includes(evidence.source) || typeof evidence.quote !== 'string' || !evidence.quote.trim() || evidence.quote.length > 1200
            || (evidence.characterId !== undefined && typeof evidence.characterId !== 'string')) throw new ServiceError('ARC_SOURCE_INVALID', '角色视角摘要来源格式无效。', 422);
          const seen = sources.observations?.[entity.id];
          const parts = typeof seen === 'string' ? [seen] : seen ?? [];
          const attributed=sources.attributedEvidence?.some(span=>span.source==='actor' && span.turnId===current.id && span.characterId===evidence.characterId && span.audienceCharacterIds.includes(entity.id) && sources.replies.length===1 && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start>=0 && span.end>span.start && span.text===sources.replies[0].text.slice(span.start,span.end) && span.text.includes(evidence.quote));
          const valid = evidence.source === 'user' ? (evidence.characterId === undefined || evidence.characterId === entity.id) && parts.some(part => part.includes(evidence.quote))
            : (evidence.source === 'actor'
              ? attributed || evidence.characterId === entity.id && sources.replies.some(reply => reply.characterId === entity.id && typeof reply.text === 'string' && reply.text.includes(evidence.quote))
              : evidence.characterId === entity.id && sources.activities.some(activity => activity.characterId === entity.id && activity.kind === 'completed' && typeof activity.text === 'string' && activity.text.includes(evidence.quote)));
          if (!valid) throw new ServiceError('ARC_SOURCE_INVALID', '角色视角摘要必须对应本人可见原话、本人回应或已结算活动。', 422);
          provenance = { kind: 'character_view', status: 'source_verified', turnId: current.id, ...evidence };
        }
        state.arcProvenance = provenance;
      }
      // Model-facing card descriptions contain this turn's resolved names. That
      // exact host projection is equivalent to the stored template, not a rewrite.
      const projectedDescription=frozenEntities?.find(row=>row.id===entity.id)?.description;
      const persistedDescription = prior?.kind!=='npc' && prior && entity.description===projectedDescription?prior.description:prior?.kind === 'npc' && entity.description === resolveRoleplayTemplate(prior.description, {
        char: authorNarrativeName(prior.state.narrativeName) ?? prior.name,
        user: (current.input_json as ActorInput).playerProfile?.name || '玩家',
      }) ? prior.description : entity.description;
      if (prior?.kind === 'npc' && (entity.name !== prior.name || persistedDescription !== prior.description || ['definition','greeting','initial','color'].some(key => key in state && state[key] !== prior.state[key]))) throw new ServiceError('ENTITY_LOCKED', '原始角色设定不能被世界更新覆盖，请使用角色成长字段。', 422);
      const writerScope=writerKnowledge.get(entity.id)?.knowledgeScope;
      const observed=frozenEntities?.find(row=>row.id===entity.id);
      if(prior&&observed&&entity.kind!=='npc'&&['partial','identity'].includes(writerScope)){
        const merged=mergeObservedState(prior.state,observed.state,state);
        for(const key of Object.keys(state))delete state[key];Object.assign(state,merged);
      }
      if ('worldRole' in state) {
        const role = state.worldRole as Record<string,unknown>;
        if (entity.kind !== 'npc' || prior || !role || typeof role !== 'object' || Array.isArray(role)
          || Object.keys(role).sort().join(',') !== 'anchorEntityId,goal,relation'
          || typeof role.anchorEntityId !== 'string' || !before.some(row => row.id === role.anchorEntityId && (row.knownByCharacterIds.some(id => audience.includes(id)) || audience.includes(row.id)))
          || ['relation','goal'].some(key => typeof role[key] !== 'string' || !(role[key] as string).trim() || (role[key] as string).length > 400)) throw new ServiceError('ENTITY_INVALID', '新角色需要已知世界锚点、关系和目标，既有身份不能重写。', 422);
      }
      if (state.definition !== undefined && (typeof state.definition !== 'string' || state.definition.length > 12000)) throw new ServiceError('ENTITY_INVALID', '角色设定过长。', 422);
      if (state.greeting !== undefined && (typeof state.greeting !== 'string' || state.greeting.length > 6000)) throw new ServiceError('ENTITY_INVALID', '角色开场资料过长。', 422);
      if (state.ownerCharacterId !== undefined && !(entity.kind==='quest'&&state.ownerCharacterId==='$player') && !npcIds.has(state.ownerCharacterId as string)) throw new ServiceError('ENTITY_INVALID', '任务或物品归属角色不存在。', 422);
      if (state.holderCharacterId !== undefined && !(entity.kind === 'item' && (state.holderCharacterId === null || state.holderCharacterId === '$player')) && !npcIds.has(state.holderCharacterId as string)) throw new ServiceError('ENTITY_INVALID', '物品持有角色不存在。', 422);
      if (state.locationId !== undefined && !(entity.kind === 'item' && state.locationId === null) && !locationIds.has(state.locationId as string)) throw new ServiceError('ENTITY_INVALID', '档案引用地点不存在。', 422);
      if (entity.kind === 'quest') {
        const status = state.status ?? prior?.state.status;
        if (!['proposed','active','completed','failed'].includes(status as string) || (state.dueAt !== undefined && (typeof state.dueAt !== 'string' || !Number.isFinite(Date.parse(state.dueAt))))) throw new ServiceError('ENTITY_INVALID', '任务状态或期限无效。', 422);
        if (!prior && ['completed','failed'].includes(status as string) && !sources.eventLedger?.some(event=>event.entityId===entity.id && event.kind==='commitment' && ((status==='completed' && event.phase==='completed') || (status==='failed' && event.phase==='cancelled')) && event.lastSourceTurnId===current.id && event.evidenceIds.length>0)) throw new ServiceError('ENTITY_INVALID', '新任务不能直接创建为已结束。', 422);
        if (state.storyDue !== undefined && !validStoryTime({ ...(state.storyDue as object), source: { kind: 'unknown' } })) throw new ServiceError('ENTITY_INVALID', '约定的剧情期限格式无效。', 422);
        if (state.recurrence !== undefined && !['once','daily'].includes(String(state.recurrence))) throw new ServiceError('ENTITY_INVALID', '约定重复周期无效。', 422);
        if (state.progression !== undefined) {
          const progression = state.progression as Record<string,unknown>;
          if (!progression || typeof progression !== 'object' || Array.isArray(progression)
            || Object.keys(progression).sort().join(',') !== 'completedMilestones,nextStep,phase'
            || typeof progression.phase !== 'string' || !progression.phase.trim() || progression.phase.length > 160
            || !Array.isArray(progression.completedMilestones) || progression.completedMilestones.length > 64 || progression.completedMilestones.some(row => typeof row !== 'string' || !row.trim() || row.length > 240)
            || (progression.nextStep !== null && (typeof progression.nextStep !== 'string' || progression.nextStep.length > 400))) throw new ServiceError('ENTITY_INVALID', '主线阶段、已完成里程碑和下一步格式无效。', 422);
        }
      }
      if (entity.kind === 'location' && state.connectedTo !== undefined && (!Array.isArray(state.connectedTo) || state.connectedTo.some(id => !locationIds.has(id)))) throw new ServiceError('ENTITY_INVALID', '地点连接不存在。', 422);
      // Editing a private record is not evidence that its old contents were disclosed.
      const requestedKnown = entity.knownByCharacterIds;
      const allowedKnown = new Set([...audience, ...(entity.kind === 'npc' ? [entity.id] : [])]);
      if (requestedKnown !== undefined && (!Array.isArray(requestedKnown) || requestedKnown.some(id => typeof id !== 'string' || (!prior && !allowedKnown.has(id))))) throw new ServiceError('KNOWLEDGE_SCOPE', '不能把档案透露给本轮没有获知信息的角色。', 422);
      if (change.witnessedByCharacterIds !== undefined && (!Array.isArray(change.witnessedByCharacterIds) || change.witnessedByCharacterIds.some(id => typeof id !== 'string' || !allowedKnown.has(id)))) throw new ServiceError('KNOWLEDGE_SCOPE', '变更见证者必须在本轮实际知情范围。', 422);
      const witnesses = prior ? (change.witnessedByCharacterIds ?? prior.knownByCharacterIds.filter(id => audience.includes(id))) : (change.witnessedByCharacterIds ?? requestedKnown ?? [...allowedKnown]);
      // A partial update is not disclosure of all prior private versions. Only listeners
      // holding this base snapshot may receive its successor; others retain their version.
      const eligibleWitnesses: string[] = [];
      const partialWitnesses:Array<{id:string;snapshot?:Row}>=[];
      for (const id of new Set(witnesses)) {
        const old = prior ? await this.row(q,'SELECT version,snapshot FROM world_entity_knowledge WHERE owner_id=$1 AND world_id=$2 AND character_id=$3 AND entity_id=$4',[current.owner_id,current.world_id,id,entity.id]) : undefined;
        if (!prior || entity.kind === 'npc' && id === entity.id || old && old.version === prior.version && !['identity','partial'].includes(old.snapshot?.knowledgeScope)) eligibleWitnesses.push(id);
        else if(change.witnessedByCharacterIds!==undefined)partialWitnesses.push({id,snapshot:old?.snapshot});
      }
      // A generated person always knows their own identity/persona. This grants
      // no new reader access to anyone else's private state.
      if(entity.kind==='npc' && !eligibleWitnesses.includes(entity.id))eligibleWitnesses.push(entity.id);
      const known = [...new Set([...(prior?.knownByCharacterIds ?? []), ...eligibleWitnesses,...partialWitnesses.map(witness=>witness.id)])];
      const birth = current.clock_snapshot?.clock;
      const nextState = { ...(prior?.state ?? {}), ...state, ...(entity.kind === 'npc' && !prior ? { origin: 'generated', rootCharacterId: (await this.scopedWorld(q, current.owner_id, current.world_id)).root_character_id,
        ...(birth ? { lastSettledAt: birth.asOf, lastSettledWorldMs: birth.toWorldMs, lastSettledActiveMs: current.clock_snapshot.activeMs, lastSettledStoryTime: sources.storyTime ?? unknownStoryTime(), lastSettledStoryMs: current.story_elapsed_total ?? 0 } : {}) } : {}) };
      const written=prior ? await q.query('UPDATE world_entities SET name=$4,description=$5,state=$6,known_by_character_ids=$7,source_turn_id=$8,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND id=$3 RETURNING *', [current.owner_id, current.world_id, entity.id, entity.name, persistedDescription, nextState, known, current.id])
        : await q.query('INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids,source_turn_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [current.owner_id, current.world_id, entity.id, entity.kind, entity.name, entity.description, nextState, known, current.id]);
      for(const witness of partialWitnesses){
        const snapshot=observedPatchSnapshot({prior:prior!,head:written.rows[0],old:witness.snapshot,patch:state,witnessId:witness.id,
          hiddenStateKeys:entity.kind==='npc'?[...internalStateKeys,'definition','greeting','arc','arcProvenance','characterView']:internalStateKeys,descriptionChanged:persistedDescription!==prior!.description});
        await q.query(`INSERT INTO world_entity_knowledge(owner_id,world_id,character_id,entity_id,version,snapshot,observed_at,source_turn_id) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$7)
          ON CONFLICT(world_id,character_id,entity_id) DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at,source_turn_id=EXCLUDED.source_turn_id`,[current.owner_id,current.world_id,witness.id,entity.id,snapshot.version,snapshot,current.id]);
      }
      if(entity.kind==='npc' && typeof state.arc==='string' && (state.arcProvenance as ArcProvenance)?.status==='source_verified')
        await q.query(`INSERT INTO world_memory_snapshots(owner_id,world_id,character_id,source_turn_id,through_seq,summary,provenance)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(world_id,character_id,source_turn_id) DO NOTHING`,[current.owner_id,current.world_id,entity.id,current.id,current.seq,state.arc,state.arcProvenance]);
      observedUpdates.push({ id: entity.id, witnesses: eligibleWitnesses });
    }
    for (const update of observedUpdates) await this.rememberEntities(q,current.owner_id,current.world_id,[update.id],update.witnesses,current.id);
  }
  private async applyActorLocations(q: Query, current: Row, scene: SceneState, replies: SpeakerReply[], moves: ActorLocation[]): Promise<SceneState> {
    if (!Array.isArray(moves) || moves.length > 3) throw new ServiceError('ACTOR_LOCATION_INVALID', '本轮角色移动格式无效。', 422);
    const seen = new Set<string>(), destinations = new Map<string, { id: string | null; name: string | null }>();
    for (const move of moves) {
      if (!move || typeof move !== 'object' || Array.isArray(move)
        || Object.keys(move).sort().join(',') !== 'characterId,evidence,locationId'
        || typeof move.characterId !== 'string' || seen.has(move.characterId)
        || (move.locationId !== null && typeof move.locationId !== 'string')
        || !scene.presentCharacterIds.includes(move.characterId)) throw new ServiceError('ACTOR_LOCATION_INVALID', '角色移动必须对应本轮实际演员。', 422);
      const proof = move.evidence;
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)
        || Object.keys(proof).sort().join(',') !== 'characterId,quote,source'
        || proof.source !== 'actor' || proof.characterId !== move.characterId
        || typeof proof.quote !== 'string' || !proof.quote.trim() || proof.quote.length > 1200) throw new ServiceError('ACTOR_LOCATION_INVALID', '移动证据必须来自本人当轮完整动作片段。', 422);
      const reply = replies.find(row => row.characterId === move.characterId);
      const actor = await this.row(q, "SELECT name,state FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'", [current.owner_id, current.world_id, move.characterId]);
      const place = move.locationId === null ? undefined : await this.row(q, "SELECT name FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='location' AND $4=ANY(known_by_character_ids)", [current.owner_id, current.world_id, move.locationId, move.characterId]);
      if ((move.locationId !== null && !place) || !reply || !actor || !validMovementEvidence(reply.text, proof.quote, place?.name ?? null, actor.name, authorNarrativeName(actor.state.narrativeName))) throw new ServiceError('ACTOR_LOCATION_INVALID', '只记录已发生的本人离开或到达；目的地必须已知，意图和台词不算到达。', 422);
      seen.add(move.characterId); destinations.set(move.characterId, { id: move.locationId, name: place?.name ?? null });
    }
    for (const [id, destination] of destinations) {
      await q.query("UPDATE world_entities SET state=state || jsonb_build_object('locationId',$4::text),version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc' AND state->>'locationId' IS DISTINCT FROM $4::text", [current.owner_id, current.world_id, id, destination.id]);
      await this.rememberEntities(q,current.owner_id,current.world_id,[id],scene.mode === 'direct' ? [current.character_id] : scene.presentCharacterIds,current.id,true);
    }
    const focus = destinations.get(current.character_id);
    // Camera follows the focus; a post-performance move never teleports the player
    // or any other actor, and never changes who witnessed the completed episode.
    if (focus && (focus.name === null || focus.name !== scene.location)) return {
      location: focus.name, presentCharacterIds: [current.character_id, ...[...destinations.entries()].filter(([id, destination]) => id !== current.character_id && focus.id !== null && destination.id === focus.id).map(([id]) => id)], mode: scene.mode, playerPresent: false,
    };
    const presentCharacterIds = scene.presentCharacterIds.filter(id => !destinations.has(id) || destinations.get(id)!.name === scene.location);
    return { ...scene, presentCharacterIds };
  }
  /** Production boundary: one visible response plus a durable background job. */
  async commitDialogue(turn:StoredTurn,result:WorldTurnResult) {
    if(result.replies.length!==1 || result.replies[0].characterId!==turn.input.character.id || result.text!==result.replies[0].text)
      throw new ServiceError('REPLIES_INVALID','每轮只保存一条完整场景回复。',422);
    return this.commit(turn,result.text,[],{actorFirst:true,settlement:result,replies:result.replies,
      scene:result.scene,usage:result.usage,observations:result.observations,storyTime:result.storyTime,
      entityChanges:[],activities:[],actorLocations:[]});
  }
  async commit(turn: StoredTurn, text: string, changes: WorldChange[], usageOrOptions?: ModelUsage | CommitOptions): Promise<{ message: Message; messages: Message[]; world: WorldView }> {
    const options: CommitOptions = usageOrOptions && ['scene','usage','replies','entityChanges','activities','observations','actorLocations','storyTime','settledCharacterIds','settlement'].some(key => key in usageOrOptions) ? usageOrOptions as CommitOptions : { usage: { updater: usageOrOptions as ModelUsage | undefined } };
    return this.transaction(async (q) => {
      const world = await this.scopedWorld(q, turn.ownerId, turn.worldId, true);
      const current = await this.row(q, "SELECT * FROM turns WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE", [turn.id, turn.ownerId, turn.attempt]);
      if (!current) throw new ServiceError('TURN_LEASE_LOST', '本轮执行已结束或过期。');
      if (current.runtime_metadata.memoryPolicy !== MEMORY_POLICY) throw new ServiceError('RUNTIME_CHANGED', '记忆规则已更新，请作为新消息重新发送。');
      const input = current.input_json as ActorInput;
      const temporal = input.worldContext?.temporal;
      let appliedTime: ReturnType<typeof resolveStoryTime> | undefined;
      if (temporal) {
        try {
          if (current.operation === 'opening' && options.storyTime?.source.kind === 'user_explicit') throw new TypeError('Opening cannot invent user time evidence');
          appliedTime = resolveStoryTime(temporal,options.storyTime,input.userText,current.id);
          if (validStoryTime(world.story_time) && JSON.stringify(actorStoryTime(world.story_time)) === JSON.stringify(appliedTime.story)) appliedTime.story = world.story_time;
        } catch { throw new ServiceError('STORY_TIME_INVALID','剧情时间必须由本轮明确叙事或宿主冻结的离场间隔证明。',422); }
      } else if (options.storyTime !== undefined) throw new ServiceError('STORY_TIME_INVALID','此旧回合没有可提交的剧情时间快照。',422);
      current.story_elapsed_total = Number(world.story_elapsed_ms) + (appliedTime?.elapsedMs ?? 0);
      const initialScene = input.scene ?? world.scene;
      const proposedScene = contextScene(options.scene ?? initialScene);
      if (initialScene.mode === 'direct' && (proposedScene.mode ?? 'direct') !== 'direct') throw new ServiceError('KNOWLEDGE_SCOPE', '私聊不能由模型自动改为公开场景。', 422);
      const audience = initialScene.mode === 'ensemble' || initialScene.mode === 'observe' ? [...proposedScene.presentCharacterIds] : [current.character_id];
      const observations: Record<string, Observation> | null = input.worldContext ? {} : null;
      if (options.observations !== undefined && (!options.observations || typeof options.observations !== 'object' || Array.isArray(options.observations)
        || Object.entries(options.observations).some(([id, excerpt]) => !audience.includes(id) || !validObservation(excerpt, input.userText) || (observationText(excerpt) !== '' && (proposedScene.playerPresent === false || current.operation === 'opening'))))) throw new ServiceError('OBSERVATION_INVALID', '角色观察必须由本轮原文中按序、不重叠的可感知片段组成。', 422);
      if (observations) for (const id of audience) observations[id] = proposedScene.playerPresent === false || current.operation === 'opening' ? '' : structuredClone(options.observations?.[id] ?? '');
      // Situation is shared by the cast. A private excerpt must not re-enter the next
      // turn through a free-form scene summary, even if the adapter missed the rule.
      if (observations && current.operation !== 'opening' && (proposedScene.playerPresent === false || audience.some(id => observationText(observations[id]) !== input.userText))) delete proposedScene.situation;
      const perceivedInput = observations ? { ...input, userText: observationText(observations[current.character_id]) } : input;
      const verifiedChanges = current.operation === 'opening' ? [] : validateChanges(changes, { ...perceivedInput, turnId: current.id, character: { ...input.character, id: current.character_id } });
      const replies: SpeakerReply[] = options.replies ?? [{ characterId: current.character_id, characterName: input.character.name, text }];
      if (!Array.isArray(replies) || replies.length < 1 || replies.length > 3 || new Set(replies.map(reply => reply.characterId)).size !== replies.length) throw new ServiceError('REPLIES_INVALID', '每轮需要一至三名不同角色的完整回应。', 422);
      if (!Array.isArray(options.activities ?? []) || (options.activities?.length ?? 0) > 3) throw new ServiceError('ACTIVITY_INVALID', '本轮离线活动过多。', 422);
      await this.applyEntities(q, current, options.entityChanges ?? [], audience, { observations, replies, activities: options.activities ?? [], storyTime: appliedTime?.story });
      const scene = await this.validateScene(q, proposedScene, turn.ownerId, turn.worldId);
      const messages: Message[] = [];
      for (const reply of replies) {
        const entity = await this.row(q, "SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'", [turn.ownerId, turn.worldId, reply.characterId]);
        if (!entity || !audience.includes(reply.characterId) || !scene.presentCharacterIds.includes(reply.characterId) || typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > 12000) throw new ServiceError('REPLIES_INVALID', '回应角色不在授权场景中或正文无效。', 422);
        if (reply.callId) {
          const call = await this.row(q, "SELECT record FROM agent_calls WHERE owner_id=$1 AND turn_id=$2 AND attempt=$3 AND (id=$4 OR (record->>'status'='reused' AND record->>'sourceCallId'=$4)) AND record->>'agent'='actor' AND record->>'status' IN ('completed','reused')", [turn.ownerId, turn.id, turn.attempt, reply.callId]);
          const receipt=(current.runtime_checkpoint?.living?.stages??[]).find((stage:any)=>stage.agent==='actor' && stage.id===reply.callId && stage.input?.character?.id===reply.characterId && stage.output?.text===reply.text);
          if (!receipt && (!call || call.record.input?.character?.id !== reply.characterId || call.record.output?.text !== reply.text)) throw new ServiceError('REPLY_SOURCE_INVALID', '角色回应与已保存执行结果不一致。', 422);
        }
        const message = (await q.query("INSERT INTO messages(id,owner_id,world_id,session_id,turn_id,role,content,character_id,character_name,player_name) VALUES($1,$2,$3,$4,$5,'assistant',$6,$7,$8,$9) RETURNING *", [randomUUID(), turn.ownerId, turn.worldId, turn.sessionId, turn.id, reply.text, reply.characterId, entity.name, input.playerProfile?.name ?? null])).rows[0];
        messages.push(this.messageView(message));
      }
      const projected = current.clock_snapshot as { clock?: WorldClock; activeMs?: number };
      const activities: WorldActivity[] = [];
      if (!Array.isArray(options.activities ?? []) || (options.activities?.length ?? 0) > 3) throw new ServiceError('ACTIVITY_INVALID', '本轮离线活动过多。', 422);
      for (const activity of options.activities ?? []) {
        const actor = input.worldContext?.actorInputs[activity.characterId];
        const clock = actor?.worldContext?.clock;
        const storyWindow = appliedTime && actor?.worldContext?.temporal ? Math.min(settlementWindow(actor.worldContext.temporal,appliedTime),86400000) : undefined;
        const invalidTime = appliedTime ? storyWindow === undefined || storyWindow < 1000
          || !Number.isFinite(activity.elapsedStoryMs) || activity.elapsedStoryMs! < 0 || activity.elapsedStoryMs! > storyWindow!
          || !Number.isFinite(activity.elapsedMs) || activity.elapsedMs < 0 || activity.elapsedMs > temporal!.real.elapsedMs
          : !clock || clock.mode === 'paused' || (clock.activeElapsedRealMs ?? 0) < 60000 || !Number.isFinite(activity.elapsedMs) || activity.elapsedMs < 0 || activity.elapsedMs > (clock.activeElapsedRealMs ?? 0);
        if (!clock || invalidTime || typeof activity.text !== 'string' || !activity.text.trim() || activity.text.length > 4000
          || (activity.minimumDurationMs !== undefined && (!Number.isFinite(activity.minimumDurationMs) || activity.minimumDurationMs < 1000 || activity.kind === 'completed' && activity.minimumDurationMs > (storyWindow ?? clock.activeElapsedRealMs ?? 0)))
          || !['completed','invitation'].includes(activity.kind) || (activity.requiresIntervention && activity.kind !== 'invitation')
          || activities.some(row => row.characterId === activity.characterId)) throw new ServiceError('ACTIVITY_INVALID', '离线活动超出角色真实时间或需要玩家介入。', 422);
        if (activity.locationId && !await this.row(q, "SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='location'", [turn.ownerId, turn.worldId, activity.locationId])) throw new ServiceError('ACTIVITY_INVALID', '离线活动地点不属于这个世界。', 422);
        if (activity.kind === 'completed') {
          const known = actor!.worldContext!.entities;
          const frozenLocation = known.find(entity => entity.kind === 'npc' && entity.id === activity.characterId)?.state.locationId;
          if (!activity.locationId || activity.locationId !== frozenLocation || !known.some(entity => entity.kind === 'location' && entity.id === activity.locationId && entity.knownByCharacterIds.includes(activity.characterId))) throw new ServiceError('ACTIVITY_INVALID', '已完成活动必须位于角色冻结时已确认的地点；未知位置只能生成邀请。', 422);
        }
        activities.push({ ...activity, occurredAt: clock.asOf, sourceTurnId: current.id, ...(appliedTime ? { storyTime: appliedTime.story } : {}) });
      }
      const changed = await q.query('UPDATE worlds SET revision=revision+1 WHERE id=$1 AND owner_id=$2 AND revision=$3', [turn.worldId, turn.ownerId, current.base_revision]);
      if (changed.rowCount !== 1) throw new ServiceError('WORLD_CHANGED', '故事已有新的进展，请作为新消息重新发送。');
      await this.locateSceneActors(q, turn.ownerId, turn.worldId, scene, current.character_id);
      const currentScene = await this.applyActorLocations(q, current, scene, replies, options.actorLocations ?? []);
      // Preserve `scene` for this episode's audience. Apply departure only to the
      // next-turn snapshot, so a goodbye is retained without leaving the player present forever.
      if (current.operation !== 'opening' && playerDeparture(input.userText, replies.map(reply => reply.text), scene.location)) {
        currentScene.playerPresent = false; delete currentScene.situation;
      }
      await q.query("UPDATE worlds SET scene=$3::jsonb || jsonb_build_object('updatedAt',clock_timestamp()) WHERE id=$1 AND owner_id=$2", [turn.worldId, turn.ownerId, currentScene]);
      await q.query('UPDATE sessions SET scene=CASE WHEN scene IS NOT NULL THEN $3 ELSE scene END WHERE id=$1 AND owner_id=$2', [turn.sessionId, turn.ownerId, currentScene]);
      if (appliedTime && temporal) {
        await q.query('UPDATE worlds SET story_time=$3,real_anchor_at=$4,clock_world_ms=clock_world_ms+$5,story_elapsed_ms=story_elapsed_ms+$5 WHERE id=$1 AND owner_id=$2',[turn.worldId,turn.ownerId,appliedTime.story,temporal.real.now,appliedTime.elapsedMs]);
        for (const characterId of scene.playerPresent === false ? [] : audience) await q.query("UPDATE world_entities SET state=state || $4::jsonb WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'",[turn.ownerId,turn.worldId,characterId,{lastEncounterAt:temporal.real.now,lastEncounterStoryTime:appliedTime.story}]);
        const settled = options.settledCharacterIds ?? activities.map(activity => activity.characterId);
        if (!Array.isArray(settled) || settled.length > 3 || new Set(settled).size !== settled.length || settled.some(id => typeof id !== 'string' || !input.worldContext?.actorInputs[id]?.worldContext?.temporal || settlementWindow(input.worldContext.actorInputs[id].worldContext!.temporal!,appliedTime!) < 1000)) throw new ServiceError('ACTIVITY_INVALID','时间审阅游标只能推进本轮确有可结算跨度的角色。',422);
        if (activities.some(activity=>!settled.includes(activity.characterId))) throw new ServiceError('ACTIVITY_INVALID','活动必须属于本轮已审阅角色。',422);
        if (options.settledCharacterIds?.length) {
          const pulse = (await q.query("SELECT record FROM agent_calls WHERE owner_id=$1 AND turn_id=$2 AND attempt=$3 AND record->>'agent'='pulse' AND record->>'status' IN ('completed','reused')",[turn.ownerId,turn.id,turn.attempt])).rows;
          if (settled.some(id => !pulse.some(row => Array.isArray(row.record.output?.settledCharacterIds) && row.record.output.settledCharacterIds.includes(id)))) throw new ServiceError('ACTIVITY_INVALID','结算游标必须对应本轮实际Pulse审阅记录。',422);
        }
        for (const characterId of settled) await q.query("UPDATE world_entities SET state=state || $4::jsonb WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'",[turn.ownerId,turn.worldId,characterId,{lastSettledAt:temporal.real.now,lastSettledStoryTime:appliedTime.story,lastSettledStoryMs:current.story_elapsed_total,lastSettledWorldMs:Number(world.clock_world_ms)+appliedTime.elapsedMs}]);
      } else if (projected.clock) {
        await q.query('UPDATE worlds SET real_anchor_at=$3,clock_world_ms=$4,clock_active_ms=$5 WHERE id=$1 AND owner_id=$2', [turn.worldId, turn.ownerId, projected.clock.asOf, projected.clock.toWorldMs, projected.activeMs]);
        for (const characterId of new Set([...replies.map(reply => reply.characterId), ...activities.map(activity => activity.characterId)])) await q.query("UPDATE world_entities SET state=state || $4::jsonb,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc'", [turn.ownerId, turn.worldId, characterId, { lastSettledAt: projected.clock.asOf, lastSettledWorldMs: projected.clock.toWorldMs, lastSettledActiveMs: projected.activeMs }]);
      }
      for (const change of verifiedChanges) await q.query("INSERT INTO events(id,owner_id,world_id,kind,text,visibility,character_id,source_turn_id,evidence,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')", [randomUUID(), turn.ownerId, turn.worldId, change.kind, change.text, change.visibility, change.characterId, turn.id, change.evidence]);
      const counts: TurnUsage = {};
      for (const key of agentKeys) { const count = usage(options.usage?.[key]); if (count) counts[key] = count; }
      const episodeScene = initialScene.mode === 'direct' ? { ...scene, presentCharacterIds: [current.character_id] } : scene;
      const completed = await q.query("UPDATE turns SET status='committed',actor_draft=NULL,usage=usage || $4::jsonb,error_code=NULL,error_message=NULL,episode_scene=$5,episode_participant_ids=$6,activities=$7,episode_observations=$8,story_time=$9,episode_entity_ids=$10,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp()", [turn.id, turn.ownerId, turn.attempt, JSON.stringify(counts), episodeScene, audience, JSON.stringify(activities), observations ? JSON.stringify(observations) : null,appliedTime?.story ?? null,(options.entityChanges ?? []).map(change => change.entity.id)]);
      if (completed.rowCount !== 1) throw new ServiceError('TURN_LEASE_LOST', '本轮执行已结束或过期。');
      if (options.settlement) {
        if (!input.worldContext || JSON.stringify(options.settlement).length > 300000 || !isDeepStrictEqual(options.settlement.replies,replies)) throw new ServiceError('SETTLEMENT_INVALID','后台整理必须对应已保存的完整回复。',422);
        await q.query('INSERT INTO world_settlements(id,owner_id,world_id,turn_id,session_id,dialogue,runtime_metadata) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(),turn.ownerId,turn.worldId,turn.id,turn.sessionId,options.settlement,current.runtime_metadata]);
        await appendRuntimeAudit(q,{ownerId:turn.ownerId,worldId:turn.worldId,turnId:turn.id,attemptId:turn.attempt,kind:'queued',data:{lane:'worldops',turnSeq:Number(current.seq),sessionId:turn.sessionId,messageIds:messages.map(message=>message.id),worldRevision:world.revision+1}});
        if (options.actorFirst) await requestDirection(q, turn.ownerId, turn.worldId, turn.id);
      }

      await q.query('UPDATE sessions SET updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2', [turn.sessionId, turn.ownerId]);
      return { message: messages[0], messages, world: await this.worldView(q, turn.ownerId, turn.worldId, current.character_id, currentScene) };
    });
  }
  async finish(turn: StoredTurn, status: 'failed' | 'cancelled', code: string, message: string): Promise<boolean> {
    return this.transaction(async (q) => {
      await this.scopedWorld(q, turn.ownerId, turn.worldId, true);
      const result = await q.query("UPDATE turns SET status=$4,error_code=$5,error_message=$6,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp()", [turn.id, turn.ownerId, turn.attempt, status, code, message]);
      if (result.rowCount === 1) await this.finishCalls(q, turn.ownerId, turn.id, turn.attempt, status, code, message);
      return result.rowCount === 1;
    });
  }
  private settlementJob(row: Row): SettlementJob {
    return { id: row.id, ownerId: row.owner_id, worldId: row.world_id, turnId: row.turn_id,
      attempt: row.attempt, attempts: row.attempts, input: row.input_json, dialogue: row.dialogue,
      checkpoint: row.checkpoint, result: row.result, runtimeMetadata: row.runtime_metadata, batchId:row.batch_id, offlineResult:row.offline_result };
  }
  private async settlementInput(q: Query, source: Row, world: Row, dialogue: WorldTurnResult): Promise<ActorInput> {
    const input = structuredClone(source.input_json) as ActorInput;
    if (!input.worldContext) throw new ServiceError('SETTLEMENT_INVALID','本轮缺少世界上下文。',422);
    const all = await this.entities(q,source.owner_id,source.world_id);
    const ledger=await loadEventLedgerSnapshot(q,source.owner_id,source.world_id);
    const scene = dialogue.scene ?? source.episode_scene ?? input.scene!;
    const project = async (packet: ActorInput, id: string): Promise<ActorInput> => {
      const known = await this.entities(q,source.owner_id,source.world_id,id);
      const self=all.find(entity=>entity.id===id && entity.kind==='npc');
      const currentView=self ? characterView(self.state) : undefined;
      // The immutable memory journal has an explicit as-of edge. Live state and
      // frozen turn evidence are never used as substitutes for one another.
      const historicalMemory=packet.contextPack ? await loadMemorySnapshot(q,source.owner_id,source.world_id,id,source.seq) : undefined;
      const memory=historicalMemory && historicalMemory.throughSeq>Number(self?.state.authoredCastSplitAfterSeq??-1)?historicalMemory:undefined;
      const previousView=memory ? characterView({arc:memory.summary,arcProvenance:memory.provenance}) : undefined;
      const selfView=packet.contextPack ? previousView ?? packet.worldContext?.entities.find(original=>original.id===id)?.state.characterView : currentView;
      const contextPack=packet.contextPack && previousView ? {...packet.contextPack,memory:{...packet.contextPack.memory,summary:authoredMemorySummary(self?.state??{},previousView.summary),sourceTurnId:previousView.provenance.turnId,throughSeq:memory!.throughSeq}} : packet.contextPack;
      const originalIds = new Set(packet.worldContext?.entities.map(entity=>entity.id));
      const priority = (entity:WorldEntity) => entity.id===id ? 6 : scene.presentCharacterIds.includes(entity.id) ? 5
        : originalIds.has(entity.id) ? 4 : entity.kind==='quest' && ['active','proposed'].includes(String(entity.state.status)) ? 3 : entity.kind==='item' ? 2 : 1;
      const entities = known.sort((a,b)=>priority(b)-priority(a) || b.updatedAt.localeCompare(a.updatedAt)).slice(0,100).map(entity => {
        const state = { ...entity.state };
        for (const key of internalStateKeys) delete state[key];
        if (entity.kind === 'npc') {
          delete state.definition; delete state.greeting; delete state.arc; delete state.arcProvenance; delete state.characterView;
          const view = entity.id === id ? selfView : undefined;
          if (view) state.characterView = view;
        }
        return { ...entity, description: entity.kind === 'npc' ? resolveRoleplayTemplate(entity.description, {char:authorNarrativeName(entity.state.narrativeName) ?? entity.name,user:input.playerProfile?.name || '玩家'}) : entity.description, state };
      });
      const temporal=packet.worldContext?.temporal ? structuredClone(packet.worldContext.temporal) : undefined;
      if(temporal && typeof self?.state.lastSettledAt==='string' && validStoryTime(self.state.lastSettledStoryTime)) {
        temporal.lastSettled={recordedAt:self.state.lastSettledAt,storyTime:actorStoryTime(self.state.lastSettledStoryTime),
          ...(Number.isFinite(self.state.lastSettledStoryMs) ? {storyElapsedTotalMs:Number(self.state.lastSettledStoryMs)} : {})};
        if(Date.parse(self.state.lastSettledAt)>=Date.parse(temporal.real.now)) {temporal.offlineEligible=false;temporal.settlementEligible=false;temporal.realGapStoryMs=0;}
      }
      if(contextPack)contextPack.memory={...contextPack.memory,...(ledger.overflow.omittedOpenEvents?{openEventsOmitted:ledger.overflow.omittedOpenEvents}:{})};
      return { ...packet,...(contextPack ? {contextPack} : {}), world: { ...packet.world,revision:world.revision },
        availableCharacters: all.filter(entity => entity.kind === 'npc' && (known.some(row => row.id === entity.id) || scene.presentCharacterIds.includes(entity.id))).sort((a,b)=>Number(scene.presentCharacterIds.includes(b.id))-Number(scene.presentCharacterIds.includes(a.id))).slice(0,20).map(entity => ({id:entity.id,name:entity.name})),
        worldContext: { ...packet.worldContext!, entities, actorInputs: {},
          entityHeadVersions:Object.fromEntries(all.filter(entity => known.some(row => row.id === entity.id)).map(entity=>[entity.id,entity.version ?? 1])),
          ...(temporal ? { temporal } : {}) } };
    };
    const result = await project(input,input.character.id);
    const eventSubjects=new Set([input.character.id,...scene.presentCharacterIds,...dialogue.activities.map(activity=>activity.characterId)]);
    result.eventLedger=ledger.events.filter(event=>eventSubjects.has(event.subjectId) || event.entityId && result.worldContext!.entities.some(entity=>entity.id===event.entityId));
    if(result.contextPack)result.contextPack.memory={...result.contextPack.memory,...(ledger.overflow.omittedOpenEvents?{openEventsOmitted:ledger.overflow.omittedOpenEvents}:{})};
    for (const id of new Set([...Object.keys(input.worldContext.actorInputs),...dialogue.replies.map(reply=>reply.characterId)])) {
      let packet = input.worldContext.actorInputs[id];
      if (!packet) {
        const entity = all.find(row => row.id===id && row.kind==='npc');
        if (!entity) throw new ServiceError('SETTLEMENT_INVALID','已保存回应的角色身份不存在。',422);
        const render = (value: unknown) => resolveRoleplayTemplate(String(value ?? ''),{char:authorNarrativeName(entity.state.narrativeName) ?? entity.name,user:input.playerProfile?.name || '玩家'});
        packet = { ...structuredClone(input), character:{id,name:entity.name,description:render(entity.description),definition:render(entity.state.definition ?? entity.description),greeting:''},
          history:[],episodes:[],userText:observationText(dialogue.observations?.[id]),scene,
          world:{...input.world,events:[]},worldContext:{...input.worldContext,actorInputs:{}} };
        delete packet.directorContext;
        if(input.contextPack) packet.contextPack={version:1,worldRevision:input.contextPack.worldRevision,characterId:id,
          card:{id,name:entity.name,description:packet.character.description,personality:packet.character.definition ?? packet.character.description,openingBackground:''},
          memory:{summary:'',pendingTurnIds:[]},dialogue:{mode:'on_demand',beforeTurnId:input.turnId}};
      }
      result.worldContext!.actorInputs[id] = await project(packet,id);
    }
    return result;
  }
  /** FIFO per world; immutable bounded batches keep all source evidence and restart checkpoints. */
  async claimSettlement(runtimeMetadata?: Record<string,unknown>): Promise<SettlementJob | null> {
    return (await this.claimSettlementBatch(runtimeMetadata,1))[0] ?? null;
  }
  async claimSettlementBatch(runtimeMetadata?: Record<string,unknown>,max=3): Promise<SettlementJob[]> {
    const limit=Math.max(1,Math.min(3,Math.floor(max)||1));
    return this.transaction(async q=>{
      const candidate=await this.row(q,`SELECT j.* FROM world_settlements j WHERE
        ((j.status='pending' AND j.next_attempt_at<=clock_timestamp()) OR (j.status='running' AND j.lease_expires_at<=clock_timestamp()))
        AND NOT EXISTS(SELECT 1 FROM world_settlements older WHERE older.world_id=j.world_id AND older.seq<j.seq AND older.status<>'completed')
        ORDER BY j.next_attempt_at,j.seq LIMIT 1`);
      if(!candidate) return [];
      const world=await this.scopedWorld(q,candidate.owner_id,candidate.world_id,true);
      const pending=(await q.query("SELECT j.*,t.character_id FROM world_settlements j JOIN turns t ON t.id=j.turn_id WHERE j.world_id=$1 AND j.status<>'completed' ORDER BY j.seq LIMIT 3 FOR UPDATE OF j",[candidate.world_id])).rows;
      if(pending[0]?.id!==candidate.id) return [];
      const now=Date.now(); const selected:Row[]=[];
      for(const row of pending) {
        if(row.character_id!==pending[0].character_id || selected.length && (pending[0].batch_disabled || row.batch_disabled)) break;
        if(candidate.batch_id ? row.batch_id!==candidate.batch_id : row.batch_id || selected.length>=limit) break;
        if(!((row.status==='pending' && new Date(row.next_attempt_at).getTime()<=now) || (row.status==='running' && new Date(row.lease_expires_at).getTime()<=now))) break;
        selected.push(row);
      }
      if(!selected.length) return [];
      // A live peer or a failed member fences the entire previous batch.
      if(candidate.batch_id && (await q.query("SELECT count(*)::int AS n FROM world_settlements WHERE batch_id=$1 AND status<>'completed'",[candidate.batch_id])).rows[0].n!==selected.length) return [];
      if(selected.some(row=>row.attempts>=3)) {
        for(const row of selected.filter(row=>row.attempts>=3)){
          await q.query("UPDATE world_settlements SET status='failed',lease_expires_at=NULL,error_code=COALESCE(error_code,'SETTLEMENT_INTERRUPTED'),updated_at=clock_timestamp() WHERE id=$1",[row.id]);
          await appendRuntimeAudit(q,{ownerId:row.owner_id,worldId:row.world_id,turnId:row.turn_id,batchId:row.batch_id??undefined,attemptId:row.attempt??undefined,kind:'failed',data:{lane:'worldops',code:row.error_code??'SETTLEMENT_INTERRUPTED',reason:'attempt_limit_reached',attemptNumber:row.attempts}});
        }
        return [];
      }
      const batchId=candidate.batch_id ?? randomUUID();
      const jobs:SettlementJob[]=[];
      for(const current of selected) {
        const job=await this.claimSettlementRow(q,current,world,runtimeMetadata,batchId);
        if(!job) return [];
        await q.query('UPDATE world_settlements SET batch_id=$2 WHERE id=$1',[job.id,batchId]);
        job.batchId=batchId; jobs.push(job);
      }
      const ids=jobs.map(job=>job.turnId); for(const job of jobs) job.batchedTurnIds=ids;
      for(const job of jobs)await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId,attemptId:job.attempt,kind:'claimed',data:{lane:'worldops',size:jobs.length,memberTurnIds:ids,memberJobIds:jobs.map(member=>member.id),attemptNumber:job.attempts,reusedResult:!!job.result,reusedCheckpoint:!!job.checkpoint,worldRevision:world.revision,headVersions:job.commitContext?.entityVersions??{}}});
      return jobs;
    });
  }
  private async claimSettlementRow(q:Query,current:Row,world:Row,runtimeMetadata?:Record<string,unknown>,batchId?:string):Promise<SettlementJob|null> {
      if (current.attempt) await this.finishCalls(q,current.owner_id,current.turn_id,current.attempt,'failed','SETTLEMENT_INTERRUPTED','后台整理执行中断，正在恢复。');
      if (current.attempts>=3) {
        await q.query("UPDATE world_settlements SET status='failed',error_code=COALESCE(error_code,'SETTLEMENT_INTERRUPTED'),error_message=COALESCE(error_message,'后台整理已暂停，可手动重试。'),updated_at=clock_timestamp() WHERE id=$1",[current.id]);
        return null;
      }
      const source = await this.scopedTurn(q,current.owner_id,current.turn_id);
      let input = await this.settlementInput(q,source,world,current.dialogue);
      const heads = dependencyVersions(input);
      const metadata = runtimeMetadata ?? current.runtime_metadata;
      const withoutRevision = (packet:ActorInput):ActorInput => {
        const copy=structuredClone(packet); copy.world.revision=0; if(copy.contextPack) copy.contextPack.worldRevision=0;
        if(copy.worldContext) {
          const relevant=new Set([copy.character.id,...(copy.scene?.presentCharacterIds??[])]);
          for(const [id,actor] of Object.entries(copy.worldContext.actorInputs)) { if(relevant.has(id))copy.worldContext.actorInputs[id]=withoutRevision(actor);else delete copy.worldContext.actorInputs[id]; }
        }
        return copy;
      };
      // Pure dialogue commits advance the world revision without changing any
      // authorized fact. Keep the exact frozen checkpoint in that case, avoiding
      // another paid extraction merely because the player already sent a reply.
      // Compare all projected contents and knowledge, not just entity versions.
      const same = !!current.input_json && isDeepStrictEqual(heads,current.head_versions)
        && isDeepStrictEqual(withoutRevision(input),withoutRevision(current.input_json))
        && isDeepStrictEqual(metadata,current.runtime_metadata);
      if(same) input=current.input_json;
      const row = await this.row(q,`UPDATE world_settlements SET status='running',attempt=$2,attempts=attempts+1,
        lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',input_json=$4,head_versions=$5,runtime_metadata=$6,
        checkpoint=CASE WHEN $7 THEN checkpoint ELSE NULL END,result=CASE WHEN $7 THEN result ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [current.id,randomUUID(),this.leaseMs,input,heads,metadata,same]);
      if(current.input_json&&!same)await appendRuntimeAudit(q,{ownerId:current.owner_id,worldId:current.world_id,turnId:current.turn_id,batchId,attemptId:row!.attempt,kind:'rebased',data:{lane:'worldops',reason:'authorized_input_changed',expectedVersions:current.head_versions??{},actualVersions:heads,discardedResult:!!current.result,discardedCheckpoint:!!current.checkpoint}});
      return {...this.settlementJob(row!),evidence:{turnId:source.id,throughSeq:Number(source.seq),input:structuredClone(source.input_json),dialogue:structuredClone(current.dialogue)},commitContext:{worldRevision:world.revision,entityVersions:heads}};
  }
  async renewSettlement(job: SettlementJob): Promise<boolean> {
    return (await this.pool.query("UPDATE world_settlements SET lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND attempt=$2 AND status='running' AND lease_expires_at>clock_timestamp()",[job.id,job.attempt,this.leaseMs])).rowCount===1;
  }
  async yieldSettlement(job: SettlementJob): Promise<void> {
    await this.transaction(async q=>{
      const changed=await q.query("UPDATE world_settlements SET status='pending',attempts=GREATEST(attempts-1,0),lease_expires_at=NULL,next_attempt_at=clock_timestamp()+interval '1 second',updated_at=clock_timestamp() WHERE id=$1 AND attempt=$2 AND status='running' AND lease_expires_at>clock_timestamp()",[job.id,job.attempt]);
      if(changed.rowCount)await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId:job.batchId,attemptId:job.attempt,kind:'wait',data:{lane:'worldops',reason:'foreground_yield',resultRetained:!!job.result}});
    });
  }
  private async activeSettlement(q: Query, job: SettlementJob): Promise<Row> {
    const row = await this.row(q,"SELECT * FROM world_settlements WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE",[job.id,job.ownerId,job.attempt]);
    if (!row) throw new ServiceError('SETTLEMENT_LEASE_LOST','后台整理执行已过期。');
    return row;
  }
  async saveSettlementCall(job: SettlementJob, record: AgentCallRecord): Promise<void> {
    if (!record || record.attemptId!==job.attempt || typeof record.id!=='string' || !record.id || record.id.length>200
      || !['updater','arbiter','pulse'].includes(record.agent) || !['running','completed','failed','cancelled','reused'].includes(record.status)
      || typeof record.model!=='string' || record.model.length>200 || !Number.isFinite(Date.parse(record.startedAt))) throw new ServiceError('TRACE_INVALID','后台调用记录无效。',422);
    const serialized=JSON.stringify({...record,...(job.batchedTurnIds?.length ? {batchedTurnIds:job.batchedTurnIds}: {})},(key,value)=>/^(authorization|api[-_]?key|access[-_]?token|password|secret)$/i.test(key)?'[REDACTED]':value);
    if (serialized.length>(job.batchedTurnIds && job.batchedTurnIds.length>1 ? 300000 : 80000)) throw new ServiceError('TRACE_INVALID','调用记录超过大小限制。',422);
    await this.transaction(async q=>{
      const row=await this.activeSettlement(q,job);
      const saved=await q.query("INSERT INTO agent_calls(turn_id,attempt,id,owner_id,world_id,session_id,record) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(turn_id,attempt,id) DO UPDATE SET record=EXCLUDED.record,updated_at=clock_timestamp() WHERE agent_calls.record->>'status'='running' OR agent_calls.record=EXCLUDED.record RETURNING id",[job.turnId,job.attempt,record.id,job.ownerId,job.worldId,row.session_id,serialized]);
      if(saved.rowCount!==1) throw new ServiceError('TRACE_ALREADY_COMPLETED','此调用记录已结束。');
    });
  }
  async saveSettlementCheckpoint(job: SettlementJob, checkpoint: ActorCheckpoint): Promise<void> {
    if (!checkpoint || typeof checkpoint.text!=='string' || !checkpoint.living || JSON.stringify(checkpoint).length>300000) throw new ServiceError('CHECKPOINT_INVALID','后台保存点无效。',422);
    const changed=await this.pool.query("UPDATE world_settlements SET checkpoint=$3,updated_at=clock_timestamp() WHERE id=$1 AND attempt=$2 AND status='running' AND lease_expires_at>clock_timestamp()",[job.id,job.attempt,checkpoint]);
    if(changed.rowCount!==1) throw new ServiceError('SETTLEMENT_LEASE_LOST','后台整理执行已过期。');
  }
  async saveSettlementResult(job: SettlementJob, result: WorldTurnResult): Promise<void> {
    if (!result || JSON.stringify(result).length>300000 || !isDeepStrictEqual(result.replies,job.dialogue.replies)) throw new ServiceError('SETTLEMENT_INVALID','后台整理不能改写已保存回复。',422);
    await this.transaction(async q=>{
      await this.activeSettlement(q,job);
      await q.query('UPDATE world_settlements SET result=$2,updated_at=clock_timestamp() WHERE id=$1',[job.id,result]);
      await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId:job.batchId,attemptId:job.attempt,kind:'result_saved',data:{lane:'worldops',result,source:'world_settlements.result',memberTurnIds:job.batchedTurnIds??[job.turnId]}});
    });
  }
  async saveSettlementOffline(job:SettlementJob,result:NonNullable<SettlementJob['offlineResult']>, receiptBeforeTrace=false):Promise<void> {
    await this.transaction(async q=>{
      const row=await this.activeSettlement(q,job);
      const source=await this.scopedTurn(q,job.ownerId,job.turnId);
      if(receiptBeforeTrace && result.settledCharacterIds.length) {
        const calls=(await q.query("SELECT id FROM agent_calls WHERE owner_id=$1 AND turn_id=$2 AND attempt=$3 AND record->>'agent'='pulse' AND record->>'status'='running'",[job.ownerId,job.turnId,job.attempt])).rows;
        if(!calls.length)throw new ServiceError('ACTIVITY_INVALID','离线执行凭据缺失。',422);
        row.offline_receipt={attemptId:job.attempt,callIds:calls.map(call=>call.id),result};
      }
      await this.validateSettlementOffline(q,job,row,source,result);
      await q.query('UPDATE world_settlements SET offline_result=$2,offline_receipt=$3,updated_at=clock_timestamp() WHERE id=$1',[job.id,result,row.offline_receipt??null]);
    });
  }
  private async validateSettlementOffline(q:Query,job:SettlementJob,row:Row,source:Row,result:NonNullable<SettlementJob['offlineResult']>) {
    const input=source.input_json as ActorInput;
    const temporal=input.worldContext?.temporal;
    if(!result || !Array.isArray(result.activities) || result.activities.length>3 || !Array.isArray(result.settledCharacterIds) || result.settledCharacterIds.length>3 || new Set(result.settledCharacterIds).size!==result.settledCharacterIds.length || JSON.stringify(result).length>30000) throw new ServiceError('ACTIVITY_INVALID','后台离线结算格式无效。',422);
    if(!temporal) {
      if(result.activities.length || result.settledCharacterIds.length) throw new ServiceError('ACTIVITY_INVALID','本轮没有已冻结的时间依据。',422);
      return {activities:[],applied:undefined};
    }
    let applied:ReturnType<typeof resolveStoryTime>;
    try {
      // The foreground has already committed the clock. Recompute from its
      // frozen input, then compare the actor projection: persisted provenance
      // retains earlier quotes that are deliberately absent from actor inputs.
      applied=resolveStoryTime(temporal,undefined,input.userText,source.id);
      if(!validStoryTime(source.story_time) || !isDeepStrictEqual(actorStoryTime(source.story_time),actorStoryTime(applied.story))) throw new TypeError('Committed story time differs from frozen chronology');
    }
    catch { throw new ServiceError('ACTIVITY_INVALID','本轮离线时间依据无效。',422); }
    if(result.storyTime && (!validStoryTime(result.storyTime) || !isDeepStrictEqual(actorStoryTime(result.storyTime),actorStoryTime(applied.story)))) throw new ServiceError('ACTIVITY_INVALID','后台离线结算不能改变已经发生的剧情时间。',422);
    applied.story=structuredClone(source.story_time);
    const activities:WorldActivity[]=[];
    for(const activity of result.activities) {
      const actor=input.worldContext?.actorInputs[activity.characterId]; const clock=actor?.worldContext?.clock;
      const storyWindow=actor?.worldContext?.temporal ? Math.min(settlementWindow(actor.worldContext.temporal,applied),86400000) : 0;
      if(!clock || storyWindow<1000 || !Number.isFinite(activity.elapsedStoryMs) || activity.elapsedStoryMs!<0 || activity.elapsedStoryMs!>storyWindow
        || !Number.isFinite(activity.elapsedMs) || activity.elapsedMs<0 || activity.elapsedMs>temporal.real.elapsedMs
        || typeof activity.text!=='string' || !activity.text.trim() || activity.text.length>4000
        || !['completed','invitation'].includes(activity.kind) || (activity.requiresIntervention && activity.kind!=='invitation')
        || (activity.minimumDurationMs!==undefined && (!Number.isFinite(activity.minimumDurationMs) || activity.minimumDurationMs<1000 || activity.kind==='completed' && activity.minimumDurationMs>storyWindow))
        || activities.some(row=>row.characterId===activity.characterId) || !result.settledCharacterIds.includes(activity.characterId)) throw new ServiceError('ACTIVITY_INVALID','后台活动超出本轮冻结的可结算时间。',422);
      if(activity.locationId && !await this.row(q,"SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='location'",[job.ownerId,job.worldId,activity.locationId])) throw new ServiceError('ACTIVITY_INVALID','后台活动地点不存在。',422);
      if(activity.kind==='completed') {
        const known=actor!.worldContext!.entities;
        const location=known.find(entity=>entity.kind==='npc' && entity.id===activity.characterId)?.state.locationId;
        if(!activity.locationId || activity.locationId!==location || !known.some(entity=>entity.id===activity.locationId && entity.kind==='location' && entity.knownByCharacterIds.includes(activity.characterId))) throw new ServiceError('ACTIVITY_INVALID','完成的后台活动只能发生在角色当时已知的所在地。',422);
      }
      activities.push({...activity,occurredAt:clock.asOf,sourceTurnId:source.id,storyTime:applied.story});
    }
    for(const id of result.settledCharacterIds) {
      const actor=input.worldContext?.actorInputs[id];
      if(!actor?.worldContext?.temporal || settlementWindow(actor.worldContext.temporal,applied)<1000) throw new ServiceError('ACTIVITY_INVALID','后台审阅游标没有真实可结算跨度。',422);
    }
    const receipted=!!row.offline_receipt?.attemptId && isDeepStrictEqual(row.offline_receipt.result,result);
    if(result.settledCharacterIds.length && !receipted) {
      const calls=(await q.query("SELECT record FROM agent_calls WHERE owner_id=$1 AND turn_id=$2 AND record->>'agent'='pulse' AND record->>'status' IN ('completed','reused')",[job.ownerId,job.turnId])).rows;
      if(result.settledCharacterIds.some(id=>!calls.some(call=>call.record.output?.settledCharacterIds?.includes(id)))) throw new ServiceError('ACTIVITY_INVALID','后台审阅游标必须对应真实 Pulse 调用。',422);
    }
    return {activities,applied};
  }
  private async commitSettlementOffline(q:Query,job:SettlementJob,row:Row,source:Row):Promise<{activities:WorldActivity[]}|undefined> {
    if(!row.offline_result) return;
    const result=row.offline_result as NonNullable<SettlementJob['offlineResult']>;
    const {activities,applied}=await this.validateSettlementOffline(q,job,row,source,result);
    const input=source.input_json as ActorInput; const temporal=input.worldContext?.temporal;
    const merged=[...(source.activities ?? [])] as WorldActivity[];
    for(const activity of activities) {
      if(merged.some(previous=>previous.characterId===activity.characterId)) throw new ServiceError('ACTIVITY_INVALID','本轮角色离线活动不能重复提交。',422);
      merged.push(activity);
    }
    await q.query('UPDATE turns SET activities=$2 WHERE id=$1',[source.id,JSON.stringify(merged)]);
    if(applied && temporal) for(const id of result.settledCharacterIds) {
      const state={lastSettledAt:temporal.real.now,lastSettledStoryTime:applied.story,lastSettledStoryMs:(temporal.storyElapsedTotalMs ?? 0)+applied.elapsedMs,
        lastSettledWorldMs:(source.clock_snapshot?.clock?.toWorldMs ?? 0)};
      // Cursor-only updates never relocate characters, change current scene, or
      // advance world time. A later reviewed cursor always wins.
      await q.query("UPDATE world_entities SET state=state || $4::jsonb WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND kind='npc' AND (state->>'lastSettledAt' IS NULL OR (state->>'lastSettledAt')::timestamptz<$5::timestamptz)",[job.ownerId,job.worldId,id,state,temporal.real.now]);
    }
    return {activities:merged};
  }
  /** Semantic batch conflicts retry individual sources once, never regrouping them. */
  async splitSettlementBatch(jobs:SettlementJob[],reason='semantic_batch_conflict'):Promise<void> {
    if(jobs.length<2 || jobs.length>3 || jobs.some(job=>job.worldId!==jobs[0].worldId)) throw new ServiceError('SETTLEMENT_INVALID','只有同一世界的合并任务可以拆分。');
    await this.transaction(async q=>{
      await this.scopedWorld(q,jobs[0].ownerId,jobs[0].worldId,true);
      for(const job of jobs) await this.activeSettlement(q,job);
      for(const job of jobs){
        await q.query("UPDATE world_settlements SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,batch_id=NULL,batch_disabled=true,checkpoint=NULL,result=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp(),error_code='SETTLEMENT_BATCH_SPLIT',error_message='合并整理存在冲突，保留原始对话并改为依序整理。',updated_at=clock_timestamp() WHERE id=$1",[job.id]);
        await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId:job.batchId,attemptId:job.attempt,kind:'split',data:{lane:'worldops',reason:/^[A-Za-z0-9_:-]{1,100}$/u.test(reason)?reason:'semantic_batch_conflict',memberTurnIds:jobs.map(member=>member.turnId),batchDisabled:true}});
      }
    });
  }
  async saveSettlementBatchResults(jobs:SettlementJob[],results:WorldTurnResult[]):Promise<void> {
    if(jobs.length!==results.length || !jobs.length || jobs.length>3) throw new ServiceError('SETTLEMENT_INVALID','后台整理批次无效。',422);
    await this.transaction(async q=>{
      for(const [index,job] of jobs.entries()) {
        const result=results[index]; await this.activeSettlement(q,job);
        if(!result || JSON.stringify(result).length>300000 || !isDeepStrictEqual(result.replies,job.dialogue.replies)) throw new ServiceError('SETTLEMENT_INVALID','后台整理不能改写已保存回复。',422);
        await q.query('UPDATE world_settlements SET result=$2,updated_at=clock_timestamp() WHERE id=$1',[job.id,result]);
        await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId:job.batchId,attemptId:job.attempt,kind:'result_saved',data:{lane:'worldops',result,source:'world_settlements.result',memberTurnIds:jobs.map(member=>member.turnId)}});
      }
    });
  }
  async completeSettlement(job:SettlementJob):Promise<boolean> { return this.completeSettlementBatch([job]); }
  async completeSettlementBatch(jobs:SettlementJob[]):Promise<boolean> {
    if(!jobs.length || jobs.length>3 || jobs.some(job=>job.worldId!==jobs[0].worldId || job.ownerId!==jobs[0].ownerId)) throw new ServiceError('SETTLEMENT_INVALID','后台整理批次无效。',422);
    return this.transaction(async q=>{
      const first=jobs[0];
      const world=await this.scopedWorld(q,first.ownerId,first.worldId,true);
      const rows:Row[]=[]; for(const job of jobs) rows.push(await this.activeSettlement(q,job));
      if(rows.some(row=>row.batch_id!==rows[0].batch_id) || rows[0].batch_id && (await q.query("SELECT count(*)::int AS n FROM world_settlements WHERE batch_id=$1 AND status<>'completed'",[rows[0].batch_id])).rows[0].n!==jobs.length) throw new ServiceError('SETTLEMENT_ORDER','合并任务必须完整且按原顺序提交。');
      const pending=(await q.query("SELECT id FROM world_settlements WHERE world_id=$1 AND status<>'completed' ORDER BY seq LIMIT $2",[first.worldId,jobs.length])).rows;
      if(pending.some((row,index)=>row.id!==jobs[index].id)) throw new ServiceError('SETTLEMENT_ORDER','后台整理必须按对话顺序提交。');
      if(rows.some(row=>!row.result)) throw new ServiceError('SETTLEMENT_INVALID','后台整理结果尚未保存。');
      await this.expireWorld(q,first.ownerId,first.worldId);
      const foreground=await this.row(q,"SELECT id FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='running'",[first.ownerId,first.worldId]);
      if(foreground){
        for(const job of jobs)await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId:job.batchId,attemptId:job.attempt,kind:'wait',data:{lane:'worldops',reason:'foreground_running',foregroundTurnId:foreground.id,resultRetained:true}});
        return false;
      }
      const heads=Object.fromEntries((await this.entities(q,first.ownerId,first.worldId)).map(entity=>[entity.id,entity.version ?? 1]));
      if(rows.some(row=>!dependenciesMatch(row.head_versions,heads))) {
        for(const row of rows){
          await q.query("UPDATE world_settlements SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,checkpoint=NULL,result=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp(),error_code='SETTLEMENT_REBASED',error_message='新对话已更新世界，需要重新合并后台整理。',updated_at=clock_timestamp() WHERE id=$1",[row.id]);
          await appendRuntimeAudit(q,{ownerId:row.owner_id,worldId:row.world_id,turnId:row.turn_id,batchId:row.batch_id,attemptId:row.attempt,kind:'rebased',data:{lane:'worldops',reason:'entity_version_conflict',expectedVersions:row.head_versions,actualVersions:heads,discardedResult:!!row.result,discardedCheckpoint:!!row.checkpoint}});
        }
        return false;
      }
      const internallyUpdated=new Set<string>();
      for(const [index,job] of jobs.entries()) await this.completeSettlementRow(q,job,rows[index],world,internallyUpdated);
      return true;
    });
  }
  private async completeSettlementRow(q:Query,job:SettlementJob,row:Row,world:Row,internallyUpdated:Set<string>):Promise<void> {
      const source=await this.scopedTurn(q,job.ownerId,job.turnId);
      const current={...source,input_json:row.input_json};
      const result=structuredClone(row.result) as WorldTurnResult;
      const affectedIds=[...new Set([...(result.entityChanges??[]).map(change=>change.entity.id),...(result.actorLocations??[]).map(move=>move.characterId),...(row.offline_result?.settledCharacterIds??[]),...(result.scene?.location?source.episode_participant_ids:[])])];
      const entityRowsBefore=(await q.query('SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=ANY($3::text[])',[job.ownerId,job.worldId,affectedIds])).rows;
      const eventIds=(result.eventLedger??[]).map(event=>event.id);
      const eventRowsBefore=(await q.query('SELECT id,record FROM world_story_events WHERE owner_id=$1 AND world_id=$2 AND id=ANY($3::text[])',[job.ownerId,job.worldId,eventIds])).rows;
      const worldBefore=await this.scopedWorld(q,job.ownerId,job.worldId);
      const directionBefore=result.storyProgress?(await q.query('SELECT plan FROM world_directions WHERE owner_id=$1 AND world_id=$2',[job.ownerId,job.worldId])).rows[0]?.plan:undefined;
      let sceneDisposition:'applied'|'historical'|'unchanged'='unchanged';
      // A batch is extracted against one initial snapshot. Only versions changed
      // by earlier entries in this same transaction can be advanced internally.
      for(const change of result.entityChanges ?? []) if(change.op==='update' && internallyUpdated.has(change.entity.id)) {
        const prior=await this.row(q,'SELECT version FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3',[job.ownerId,job.worldId,change.entity.id]);
        const expected=change.baseVersion ?? row.input_json.worldContext?.entities.find((entity:WorldEntity)=>entity.id===change.entity.id)?.version;
        const initial=row.head_versions[change.entity.id];
        if(prior && (expected===initial || expected===prior.version || initial===undefined && expected===undefined)) change.baseVersion=prior.version;
      }
      const offline=await this.commitSettlementOffline(q,job,row,source);
      if(offline) source.activities=offline.activities;
      const dialogue=row.dialogue as WorldTurnResult;
      const audience=source.episode_participant_ids as string[];
      const observations=source.episode_observations as Record<string,Observation> | null;
      await this.applyEntities(q,current,result.entityChanges ?? [],audience,{observations,replies:dialogue.replies,activities:source.activities,storyTime:source.story_time,attributedEvidence:dialogue.attributedEvidence,eventLedger:result.eventLedger});
      for(const change of result.entityChanges ?? []) internallyUpdated.add(change.entity.id);
      await this.commitEventLedger(q,job,result);
      await applyStoryProgress(q,job.ownerId,job.worldId,job.turnId,result.storyProgress);
      const verified=source.operation==='opening'?[]:validateChanges(result.changes,{...row.input_json,userText:observationText(observations?.[source.character_id]),turnId:source.id});
      for(const change of verified) await q.query("INSERT INTO events(id,owner_id,world_id,kind,text,visibility,character_id,source_turn_id,evidence,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')",[randomUUID(),job.ownerId,job.worldId,change.kind,change.text,change.visibility,change.characterId,job.turnId,change.evidence]);
      const latest=await this.row(q,`SELECT t.id,COALESCE((w.scene->>'updatedAt')::timestamptz<=t.updated_at,false) AS scene_not_newer
        FROM turns t JOIN worlds w ON w.id=t.world_id AND w.owner_id=t.owner_id
        WHERE t.owner_id=$1 AND t.world_id=$2 AND t.status='committed' ORDER BY t.seq DESC LIMIT 1`,[job.ownerId,job.worldId]);
      const discovered=(result.entityChanges??[]).filter(change=>change.op==='create' && change.entity.kind==='npc').map(change=>change.entity.id);
      // Compose both changes once. A focus move changes the camera; only a new
      // character whose recorded destination matches it is present there.
      // Earlier background commits advance the world revision without moving
      // the camera. Fence on the latest turn and actual scene edits, including
      // a manual confirmation of identical values (compare timestamps in PG).
      const sceneCurrent=latest?.id===job.turnId && (world.revision===source.base_revision+1
        || latest.scene_not_newer && isDeepStrictEqual(contextScene(world.scene),contextScene(source.episode_scene)));
      const established=dialogue.attributedEvidence && !source.episode_scene.location && result.scene?.location;
      // A validated cut changes the camera without inventing a travelled route.
      // Only the evidenced focus moves; old scene participants do not teleport.
      const cut=dialogue.attributedEvidence && source.episode_scene.location && result.scene?.location
        && source.episode_scene.location!==result.scene.location && sceneCutRequested(source.input_json.userText)
        && isDeepStrictEqual(result.scene.presentCharacterIds,[source.character_id]);
      const anchored=established || cut&&result.scene?.location;
      if(sceneCurrent && (discovered.length || result.actorLocations?.length || anchored)) {
        sceneDisposition='applied';
        let scene=source.episode_scene;
        if(anchored && await this.row(q,"SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND kind='location' AND name=$3 AND $4=ANY(known_by_character_ids)",[job.ownerId,job.worldId,anchored,source.character_id])) {
          scene=cut?contextScene(result.scene!):{...scene,location:anchored};
          if(cut)delete scene.situation;
          await this.locateSceneActors(q,job.ownerId,job.worldId,scene,source.character_id);
        }
        if(result.actorLocations?.length) scene=await this.applyActorLocations(q,current,scene,this.attributedReplies(dialogue,job.turnId),result.actorLocations);
        if(discovered.length && scene.mode!=='direct') {
          const staying=scene.location===source.episode_scene.location ? discovered : [];
          const joined=(await q.query("SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=ANY($3::text[]) AND state->>'locationId' IN (SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND kind='location' AND name=$4)",[job.ownerId,job.worldId,discovered,scene.location])).rows.map(entity=>entity.id);
          scene={...scene,presentCharacterIds:[...new Set([...scene.presentCharacterIds,...staying,...joined])].slice(0,6)};
        }
        if(world.scene?.playerPresent===false)scene.playerPresent=false;
        await q.query("UPDATE worlds SET scene=$3::jsonb || jsonb_build_object('updatedAt',clock_timestamp()) WHERE id=$1 AND owner_id=$2",[job.worldId,job.ownerId,scene]);
        await q.query('UPDATE sessions SET scene=CASE WHEN scene IS NOT NULL THEN $3 ELSE scene END WHERE id=$1 AND owner_id=$2',[source.session_id,job.ownerId,scene]);
      } else if(result.actorLocations?.length || cut){
        sceneDisposition='historical';
        await q.query("UPDATE world_settlements SET result=result || '{\"movementDisposition\":\"historical_only_newer_world_state\"}'::jsonb WHERE id=$1",[job.id]);
      }
      // Do not change the original turn's timestamp: offline elapsed time is based
      // on dialogue completion, never on an asynchronous summary finishing later.
      const counts:TurnUsage={};
      for(const key of ['updater','arbiter'] as const) { const count=usage(result.usage?.[key]); if(count) counts[key]=count; }
      await q.query('UPDATE turns SET usage=usage || $3::jsonb,episode_entity_ids=ARRAY(SELECT DISTINCT unnest(episode_entity_ids || $4::text[])) WHERE id=$1 AND owner_id=$2',[job.turnId,job.ownerId,JSON.stringify(counts),(result.entityChanges ?? []).map(change=>change.entity.id)]);
      await q.query('UPDATE worlds SET revision=revision+1 WHERE id=$1 AND owner_id=$2',[job.worldId,job.ownerId]);
      await q.query("UPDATE world_settlements SET status='completed',error_code=NULL,error_message=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",[job.id]);
      const entityRowsAfter=(await q.query('SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=ANY($3::text[])',[job.ownerId,job.worldId,affectedIds])).rows;
      const eventRowsAfter=(await q.query('SELECT id,record FROM world_story_events WHERE owner_id=$1 AND world_id=$2 AND id=ANY($3::text[])',[job.ownerId,job.worldId,eventIds])).rows;
      const worldAfter=await this.scopedWorld(q,job.ownerId,job.worldId);
      const calls=(await q.query("SELECT id FROM agent_calls WHERE owner_id=$1 AND world_id=$2 AND (turn_id=$3 OR record->'batchedTurnIds' @> jsonb_build_array($3::text)) ORDER BY seq",[job.ownerId,job.worldId,job.turnId])).rows;
      const savedMemories=(await q.query('SELECT character_id,source_turn_id,through_seq,summary,provenance FROM world_memory_snapshots WHERE owner_id=$1 AND world_id=$2 AND source_turn_id=$3 ORDER BY character_id',[job.ownerId,job.worldId,job.turnId])).rows;
      const legacyMemories=(await q.query('SELECT id,kind,text,visibility,character_id,source_turn_id,evidence,status FROM events WHERE owner_id=$1 AND world_id=$2 AND source_turn_id=$3 ORDER BY seq',[job.ownerId,job.worldId,job.turnId])).rows;
      const directionAfter=result.storyProgress?(await q.query('SELECT plan FROM world_directions WHERE owner_id=$1 AND world_id=$2',[job.ownerId,job.worldId])).rows[0]?.plan:undefined;
      await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId:job.batchId,attemptId:job.attempt,kind:'committed',data:{lane:'worldops',
        entityChanges:affectedIds.map(id=>({id,before:auditEntity(entityRowsBefore.find(entity=>entity.id===id)),after:auditEntity(entityRowsAfter.find(entity=>entity.id===id))})),
        eventChanges:eventIds.map(id=>({id,before:eventRowsBefore.find(event=>event.id===id)?.record??null,after:eventRowsAfter.find(event=>event.id===id)?.record??null})),
        scene:{before:worldBefore.scene,after:worldAfter.scene,disposition:sceneDisposition},worldRevisionBefore:worldBefore.revision,worldRevisionAfter:worldAfter.revision,
        memoryChanges:{events:legacyMemories,snapshots:savedMemories},storyProgress:{requested:result.storyProgress??null,before:directionBefore??null,after:directionAfter??null},
        sourceTurnId:job.turnId,callIds:calls.map(call=>call.id),memberTurnIds:job.batchedTurnIds??[job.turnId],unresolvedCommands:unresolvedCandidates(result.deferredCommands).length}});
  }
  private attributedReplies(dialogue:WorldTurnResult,turnId:string):SpeakerReply[] {
    if(!dialogue.attributedEvidence?.length)return dialogue.replies;
    const text=dialogue.replies.length===1?dialogue.replies[0].text:'';
    const grouped=new Map<string,string[]>();
    for(const span of dialogue.attributedEvidence) {
      if(span.turnId!==turnId || span.source!=='actor' || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start<0 || span.end<=span.start || span.text!==text.slice(span.start,span.end))throw new ServiceError('SETTLEMENT_INVALID','场景证据与已保存原文不一致。',422);
      grouped.set(span.characterId,[...(grouped.get(span.characterId)??[]),span.text]);
    }
    return [...grouped].map(([characterId,parts])=>({characterId,characterName:characterId,text:parts.join('\n')}));
  }
  private async commitEventLedger(q:Query,job:SettlementJob,result:WorldTurnResult):Promise<void> {
    for(const event of result.eventLedger??[]) {
      if(!event.id || event.lastSourceTurnId!==job.turnId || !Number.isSafeInteger(event.version) || event.version<1 || !['movement','item','commitment'].includes(event.kind) || !['planned','in_progress','completed','cancelled'].includes(event.phase) || !event.evidenceIds?.length)
        throw new ServiceError('SETTLEMENT_INVALID','事件身份或来源无效。',422);
      const prior=await this.row(q,'SELECT * FROM world_story_events WHERE owner_id=$1 AND world_id=$2 AND id=$3 FOR UPDATE',[job.ownerId,job.worldId,event.id]);
      if(prior) {
        if(prior.last_source_turn_id===job.turnId && isDeepStrictEqual(prior.record,event))continue;
        if(prior.version+1!==event.version || prior.source_turn_id!==event.sourceTurnId || prior.record.kind!==event.kind || prior.record.subjectId!==event.subjectId)
          throw new ServiceError('ENTITY_VERSION_CONFLICT','事件已经更新，不能重复计入或覆盖。');
        await q.query('UPDATE world_story_events SET version=$4,record=$5,last_source_turn_id=$6,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND id=$3',[job.ownerId,job.worldId,event.id,event.version,event,job.turnId]);
      } else {
        if(event.version!==1 || event.sourceTurnId!==job.turnId)throw new ServiceError('SETTLEMENT_INVALID','新事件来源无效。',422);
        await q.query('INSERT INTO world_story_events(owner_id,world_id,id,version,record,source_turn_id,last_source_turn_id) VALUES($1,$2,$3,$4,$5,$6,$6)',[job.ownerId,job.worldId,event.id,event.version,event,job.turnId]);
      }
    }
  }
  async failSettlement(job: SettlementJob, error: unknown): Promise<void> {
    const runtimeCode=error && typeof error==='object' && 'code' in error && typeof error.code==='string' && Object.prototype.hasOwnProperty.call(settlementRuntimeErrors,error.code) ? error.code : undefined;
    const code=error instanceof ServiceError?error.code:runtimeCode ?? 'SETTLEMENT_FAILED';
    const message=error instanceof ServiceError?error.message:runtimeCode ? settlementRuntimeErrors[runtimeCode] : '世界整理暂未完成，回复和原始记忆已保存。';
    await this.transaction(async q=>{
      const row=await this.row(q,"SELECT * FROM world_settlements WHERE id=$1 AND attempt=$2 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE",[job.id,job.attempt]);
      if(!row) return;
      const interrupted=code==='SETTLEMENT_INTERRUPTED';
      await this.finishCalls(q,job.ownerId,job.turnId,job.attempt,'failed',code,message.slice(0,1000));
      await q.query("UPDATE world_settlements SET status=$3,attempts=attempts-$4,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+$5*interval '1 millisecond',error_code=$6,error_message=$7,checkpoint=CASE WHEN result IS NOT NULL AND NOT $8 THEN NULL ELSE checkpoint END,result=CASE WHEN $8 THEN result ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1 AND attempt=$2",[job.id,job.attempt,!interrupted&&row.attempts>=3?'failed':'pending',interrupted?1:0,interrupted?0:Math.min(30000,1000*2**row.attempts),code,message.slice(0,1000),interrupted || !['SETTLEMENT_INVALID','ENTITY_INVALID','ENTITY_VERSION_CONFLICT','ENTITY_NAME_CONFLICT','ARC_SOURCE_INVALID','ACTIVITY_INVALID','KNOWLEDGE_SCOPE'].includes(code)]);
      await appendRuntimeAudit(q,{ownerId:job.ownerId,worldId:job.worldId,turnId:job.turnId,batchId:job.batchId,attemptId:job.attempt,kind:'failed',data:{lane:'worldops',code,message:message.slice(0,1000),attemptNumber:row.attempts,disposition:!interrupted&&row.attempts>=3?'failed':'pending',resultRetained:!!row.result&&(interrupted||!['SETTLEMENT_INVALID','ENTITY_INVALID','ENTITY_VERSION_CONFLICT','ENTITY_NAME_CONFLICT','ARC_SOURCE_INVALID','ACTIVITY_INVALID','KNOWLEDGE_SCOPE'].includes(code))}});
    });
  }
  async retrySettlements(ownerId: string, worldId: string): Promise<WorldView> {
    return this.transaction(async q=>{
      await this.scopedWorld(q,ownerId,worldId,true);
      await q.query("UPDATE world_settlements SET status='pending',attempts=0,next_attempt_at=clock_timestamp(),error_code=NULL,error_message=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND status IN ('failed','pending')",[ownerId,worldId]);
      return this.worldView(q,ownerId,worldId);
    });
  }
  private async turnView(q: Query, ownerId: string, id: string): Promise<TurnView> {
    const turn = await this.scopedTurn(q, ownerId, id);
    const messages = (await q.query('SELECT m.*,$3::text AS turn_status FROM messages m WHERE m.turn_id=$1 AND m.owner_id=$2 ORDER BY m.seq', [id, ownerId, turn.status])).rows.map((row) => this.messageView(row));
    const assistant = messages.find((message) => message.role === 'assistant');
    return { id, worldId: turn.world_id, sessionId: turn.session_id, status: turn.status, phase: turn.phase, userMessage: messages.find((message) => message.role === 'user')!, ...(assistant ? { assistantMessage: assistant, assistantMessages: messages.filter(message => message.role === 'assistant') } : {}), ...(turn.error_code ? { error: { code: turn.error_code, message: turn.error_message } } : {}) };
  }
  async getTurn(ownerId: string, id: string): Promise<TurnView> {
    return this.transaction(async (q) => {
      const turn = await this.scopedTurn(q, ownerId, id); await this.scopedWorld(q, ownerId, turn.world_id, true);
      await this.expireWorld(q, ownerId, turn.world_id); return this.turnView(q, ownerId, id);
    });
  }
  async cancelTurn(ownerId: string, id: string, attempt?: string): Promise<{ view: TurnView; attempt: string }> {
    return this.transaction(async (q) => {
      const turn = await this.scopedTurn(q, ownerId, id); await this.scopedWorld(q, ownerId, turn.world_id, true);
      await this.expireWorld(q, ownerId, turn.world_id);
      const cancelled = await q.query("UPDATE turns SET status='cancelled',error_code='TURN_CANCELLED',error_message='已停止本轮，可以重试。',updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND status='running' AND ($3::uuid IS NULL OR attempt=$3) RETURNING attempt", [id, ownerId, attempt ?? null]);
      if (cancelled.rows[0]) await this.finishCalls(q, ownerId, id, cancelled.rows[0].attempt, 'cancelled', 'TURN_CANCELLED', '已停止本轮，可以重试。');
      return { view: await this.turnView(q, ownerId, id), attempt: (await this.scopedTurn(q, ownerId, id)).attempt };
    });
  }
  private async finishCalls(q: Query, ownerId: string, turnId: string, attempt: string, status: 'failed' | 'cancelled', code: string, message: string): Promise<void> {
    await q.query("UPDATE agent_calls SET record=record || jsonb_build_object('status',$4::text,'completedAt',clock_timestamp(),'error',jsonb_build_object('code',$5::text,'message',$6::text)),updated_at=clock_timestamp() WHERE owner_id=$1 AND turn_id=$2 AND attempt=$3 AND record->>'status'='running'", [ownerId, turnId, attempt, status, code, message]);
  }
  async getTrace(ownerId: string, turnId: string): Promise<TurnTrace> {
    return this.transaction(async q => {
      const before = await this.scopedTurn(q, ownerId, turnId);
      await this.scopedWorld(q, ownerId, before.world_id, true);
      await this.expireWorld(q, ownerId, before.world_id);
      const current = await this.scopedTurn(q, ownerId, turnId);
      const calls = (await q.query("SELECT record FROM agent_calls WHERE owner_id=$1 AND world_id=$3 AND (turn_id=$2::uuid OR record->'batchedTurnIds' @> jsonb_build_array($2::text)) ORDER BY seq", [ownerId, turnId,current.world_id])).rows.map(row => row.record as AgentCallRecord);
      const settlement = await this.row(q,'SELECT status,attempts,runtime_metadata,error_code FROM world_settlements WHERE owner_id=$1 AND turn_id=$2',[ownerId,turnId]);
      return { turnId, status: current.status, calls, metadata: { ...current.runtime_metadata,
        ...(current.runtime_history?.length ? {priorRuntimeAttempts:current.runtime_history} : {}),
        ...(settlement ? { settlement: { status:settlement.status, attempts:settlement.attempts, runtimeMetadata:settlement.runtime_metadata,
          ...(settlement.error_code ? {errorCode:settlement.error_code} : {}) } } : {}) } };
    });
  }
  async saveCall(turn: StoredTurn, record: AgentCallRecord): Promise<void> {
    if (!record || record.attemptId !== turn.attempt || typeof record.id !== 'string' || !record.id || record.id.length > 200
      || !agentKeys.includes(record.agent) || !['running','completed','failed','cancelled','reused'].includes(record.status)
      || typeof record.model !== 'string' || record.model.length > 200 || !Number.isFinite(Date.parse(record.startedAt))) throw new ServiceError('TRACE_INVALID', '调用记录格式无效。', 422);
    // Provider credentials are never part of a trace, even if an adapter accidentally includes them.
    const serialized = JSON.stringify(record, (key, value) => /^(authorization|api[-_]?key|access[-_]?token|password|secret)$/i.test(key) ? '[REDACTED]' : value);
    if (serialized.length > 80_000) throw new ServiceError('TRACE_INVALID', '调用记录超过大小限制。', 422);
    await this.transaction(async q => {
      await this.scopedWorld(q, turn.ownerId, turn.worldId, true);
      const current = await this.row(q, "SELECT id FROM turns WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE", [turn.id, turn.ownerId, turn.attempt]);
      if (!current) throw new ServiceError('TURN_LEASE_LOST', '本轮执行已结束或过期。');
      const inserted = await q.query("INSERT INTO agent_calls(turn_id,attempt,id,owner_id,world_id,session_id,record) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(turn_id,attempt,id) DO UPDATE SET record=EXCLUDED.record,updated_at=clock_timestamp() WHERE agent_calls.record->>'status'='running' OR agent_calls.record=EXCLUDED.record RETURNING id", [turn.id, turn.attempt, record.id, turn.ownerId, turn.worldId, turn.sessionId, serialized]);
      if (inserted.rowCount !== 1) throw new ServiceError('TRACE_ALREADY_COMPLETED', '此调用记录已结束。');
      if (record.status === 'running') {
        const phase = { main: 'planning', opening: 'planning', pulse: 'planning', actor: 'responding', updater: 'settling', arbiter: 'settling' }[record.agent];
        await q.query('UPDATE turns SET phase=$4,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND attempt=$3', [turn.id, turn.ownerId, turn.attempt, phase]);
      }
    });
  }
  async saveCheckpoint(turn: StoredTurn, checkpoint: ActorCheckpoint): Promise<void> {
    if (!checkpoint || typeof checkpoint.text !== 'string' || (!checkpoint.living && !checkpoint.text.trim()) || checkpoint.text.length > 36000 || JSON.stringify(checkpoint).length > 200000
      || !checkpoint.plan || typeof checkpoint.plan.updateWorld !== 'boolean' || typeof checkpoint.mainCallId !== 'string' || typeof checkpoint.actorCallId !== 'string') throw new ServiceError('CHECKPOINT_INVALID', '回复保存点格式无效。', 422);
    const counts: TurnUsage = {}; const actor = usage(checkpoint.usage); const main = usage(checkpoint.mainUsage);
    if (actor) counts.actor = actor; if (main) counts.main = main;
    const result = await this.pool.query("UPDATE turns SET runtime_checkpoint=$4,actor_draft=$5,phase=$7,usage=usage || $6::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND lease_expires_at>clock_timestamp()", [turn.id, turn.ownerId, turn.attempt, checkpoint, checkpoint.text || null, JSON.stringify(counts), checkpoint.text ? 'settling' : 'planning']);
    if (result.rowCount !== 1) throw new ServiceError('TURN_LEASE_LOST', '本轮执行已结束或过期。');
  }
  private promptView(row: Row): PromptVersion { return { key: row.agent_key, version: row.version, content: row.content, createdAt: iso(row.created_at) }; }
  private validatePrompt(key: AgentKey, content: string): void {
    if (!agentKeys.includes(key) || typeof content !== 'string' || !content.trim() || content.length > 12000) throw new ServiceError('PROMPT_INVALID', 'Prompt 不能为空或超过 12000 字符。', 422);
  }
  async getPrompts(q: Query = this.pool): Promise<PromptVersion[]> {
    return (await q.query('SELECT DISTINCT ON(agent_key) * FROM agent_prompt_versions ORDER BY agent_key,version DESC')).rows.map(row => this.promptView(row));
  }
  async listPromptVersions(key: AgentKey, limit = 10): Promise<PromptVersion[]> {
    if (!agentKeys.includes(key) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new ServiceError('PROMPT_INVALID', 'Prompt 查询格式无效。', 422);
    return (await this.pool.query('SELECT * FROM agent_prompt_versions WHERE agent_key=$1 ORDER BY version DESC LIMIT $2', [key, limit])).rows.map(row => this.promptView(row));
  }
  async savePrompt(key: AgentKey, content: string, expectedVersion: number): Promise<PromptVersion> {
    this.validatePrompt(key, content);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new ServiceError('PROMPT_INVALID', 'Prompt 版本无效。', 422);
    return this.transaction(async q => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':prompt:' || $1,0))", [key]);
      const current = await this.row(q, 'SELECT version FROM agent_prompt_versions WHERE agent_key=$1 ORDER BY version DESC LIMIT 1', [key]);
      if ((current?.version ?? 0) !== expectedVersion) throw new ServiceError('PROMPT_VERSION_CONFLICT', 'Prompt 已被更新，请刷新后再保存。');
      const row = (await q.query('INSERT INTO agent_prompt_versions(agent_key,version,content) VALUES($1,$2,$3) RETURNING *', [key, expectedVersion + 1, content])).rows[0];
      return this.promptView(row);
    });
  }
  async ensurePromptDefaults(defaults: Partial<Record<AgentKey, string>>): Promise<PromptVersion[]> {
    const keys = Object.keys(defaults).sort() as AgentKey[];
    for (const key of keys) this.validatePrompt(key, defaults[key]!);
    return this.transaction(async q => {
      for (const key of keys) {
        await q.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':prompt:' || $1,0))", [key]);
        if (!await this.row(q, 'SELECT version FROM agent_prompt_versions WHERE agent_key=$1 LIMIT 1', [key])) await q.query('INSERT INTO agent_prompt_versions(agent_key,version,content) VALUES($1,1,$2)', [key, defaults[key]]);
      }
      return this.getPrompts(q);
    });
  }
  async storedTurn(ownerId: string, id: string): Promise<StoredTurn> { return this.stored(await this.scopedTurn(this.pool, ownerId, id), true); }
}
