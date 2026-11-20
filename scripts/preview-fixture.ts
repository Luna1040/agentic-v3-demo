import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceError, type PromptSet, type StoryRuntime } from '../server/runtime.ts';
import type { StoryStore } from '../server/store.ts';
import type { AgentCallRecord, AgentKey, Character, Message, PlayerProfile, PromptVersion, SceneState, Session, TurnStatus, TurnView, WorldView } from '../shared/contracts.ts';

// shortcut: 内存/确定性仅用于界面预览，真实验收需匹配 Harness/PG。
export function createPreviewFixture() {
  const now = () => new Date().toISOString();
  const copy = <T>(value: T): T => structuredClone(value);
  const defaultPrompts: PromptSet = {
    main: '【本地界面预览】这是 Main 编辑器的示例 Prompt，不调用模型，也不执行真实调度。',
    actor: '【本地界面预览】这是 Actor 编辑器的示例 Prompt。回复由固定模板生成，修改只保存在内存。',
    updater: '【本地界面预览】这是 WorldOps 编辑器的示例 Prompt，不运行后台归档。',
    opening: '【本地界面预览】开场示例 Prompt，使用固定文本。',
    pulse: '【本地界面预览】离线结算示例 Prompt，不推进世界时间。',
    arbiter: '【本地界面预览】审查示例 Prompt，不调用真实裁决模型。',
  };
  const characters: Character[] = [
    { id: 'preview-lin', name: '林晚', subtitle: '晨雾书店的守夜人 · 演示角色', description: '安静而敏锐的书店主人，喜欢旧书、雨声和未完的故事。', initial: '晚', color: 'sage', greeting: '【本地演示】门上的风铃响了。林晚从书页间抬头：“来得正好。想先喝杯茶，还是看看这封没有署名的信？”', source: 'legacy' },
    { id: 'preview-xu', name: '许知遥', subtitle: '山顶天文台的观星者 · 演示角色', description: '热情的观星者，习惯把复杂的星象讲成轻松的小故事。', initial: '遥', color: 'blue', greeting: '【本地演示】许知遥把望远镜让给你：“今天的天空很清楚。你想找哪颗星星？”', source: 'legacy' },
  ];
  type SessionRow = { ownerId: string; session: Session; messages: Message[] };
  type WorldRow = { ownerId: string; view: WorldView };
  type Input = ReturnType<typeof input>;
  type Turn = { id: string; ownerId: string; sessionId: string; worldId: string; clientTurnId: string; content: string;
    status: TurnStatus; phase: TurnView['phase']; attempt: string; draft: string | null; checkpoint: unknown;
    input: Input; replayed: boolean; runtimeMetadata: Record<string, unknown>; usage: {}; calls: AgentCallRecord[]; error?: { code: string; message: string } };
  const sessions = new Map<string, SessionRow>();
  const worlds = new Map<string, WorldRow>();
  const turns = new Map<string, Turn>();
  const profiles = new Map<string, { ownerId: string; profile: PlayerProfile }>();
  const prompts = new Map<AgentKey, PromptVersion[]>(Object.entries(defaultPrompts).map(([key, content]) => [key as AgentKey, [{ key: key as AgentKey, version: 1, content, createdAt: now() }]]));
  const seeded = new Set<string>();
  function requireOwned<T extends { ownerId: string }>(rows: Map<string, T>, ownerId: string, id: string): T {
    const row = rows.get(id);
    if (!row || row.ownerId !== ownerId) throw new ServiceError('NOT_FOUND', '预览记录不存在。', 404);
    return row;
  }
  function body(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('INPUT_INVALID', '预览输入无效。', 422);
    return value as Record<string, unknown>;
  }
  function text(value: unknown, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ServiceError('INPUT_INVALID', '文本为空或过长。', 422);
    return value.trim();
  }
  function worldForEdit(ownerId: string, id: string, revision: number) {
    const world = requireOwned(worlds, ownerId, id).view;
    if (world.revision !== revision) throw new ServiceError('WORLD_CHANGED', '预览世界已更新，请刷新。');
    if ([...turns.values()].some(turn => turn.worldId === id && turn.status === 'running')) throw new ServiceError('WORLD_BUSY', '请先等待当前预览回复结束。');
    return world;
  }
  function scene(value: unknown, world: WorldView): SceneState {
    const raw = body(value), ids = raw.presentCharacterIds;
    if (!(raw.location === null || typeof raw.location === 'string' && raw.location.length <= 120)
      || !Array.isArray(ids) || ids.length < 1 || ids.length > 6 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !world.entities?.some(entity => entity.kind === 'npc' && entity.id === id))
      || raw.mode !== undefined && !['direct', 'ensemble', 'observe'].includes(String(raw.mode))
      || raw.playerPresent !== undefined && typeof raw.playerPresent !== 'boolean'
      || raw.situation !== undefined && (typeof raw.situation !== 'string' || raw.situation.length > 1200)) throw new ServiceError('INPUT_INVALID', '预览场景无效。', 422);
    return { location: raw.location as string | null, presentCharacterIds: [...ids], mode: (raw.mode ?? 'direct') as SceneState['mode'],
      ...(typeof raw.situation === 'string' ? { situation: raw.situation } : {}), ...(typeof raw.playerPresent === 'boolean' ? { playerPresent: raw.playerPresent } : {}), updatedAt: now() };
  }
  function detail(ownerId: string, id: string) {
    const row = requireOwned(sessions, ownerId, id);
    return copy({ session: row.session, messages: row.messages, world: requireOwned(worlds, ownerId, row.session.worldId).view, hasMore: false, nextBefore: null });
  }
  function input(ownerId: string, sessionId: string, userText: string, turnId = randomUUID(), operation: 'chat' | 'opening' = 'chat') {
    const row = requireOwned(sessions, ownerId, sessionId), world = requireOwned(worlds, ownerId, row.session.worldId).view;
    const card = characters.find(character => character.id === row.session.characterId)!;
    return copy({ turnId, operation, character: { ...card, definition: `【预览隐藏设定】${card.name}仅用于展示普通端与管理端的隔离。` },
      history: row.messages.slice(-12).map(message => ({ role: message.role, content: message.content })),
      world: { id: world.id, revision: world.revision, events: world.events }, scene: world.scene,
      playerProfile: world.playerProfile ?? undefined, userText });
  }
  function createSession(ownerId: string, characterId: string, worldId?: string, options: { dynamicOpening?: boolean; scene?: unknown; expectedRevision?: number; playerProfileId?: string | null } = {}) {
    const card = characters.find(character => character.id === characterId);
    if (!card) throw new ServiceError('NOT_FOUND', '演示角色不存在。', 404);
    const createdAt = now(), id = randomUUID();
    let world: WorldView;
    if (worldId) {
      world = requireOwned(worlds, ownerId, worldId).view;
      worldForEdit(ownerId, worldId, options.expectedRevision ?? world.revision);
      if (!world.entities?.some(entity => entity.id === characterId && entity.kind === 'npc')) throw new ServiceError('NOT_FOUND', '角色不属于这个预览世界。', 404);
    } else {
      const id = randomUUID(), locationId = randomUUID();
      world = { id, title: `【演示】与${card.name}的故事`, revision: 0, createdAt, events: [],
        scene: { location: characterId === 'preview-lin' ? '晨雾书店' : '山顶天文台', presentCharacterIds: [characterId], mode: 'direct', playerPresent: true },
        entities: [
          { id: characterId, kind: 'npc', name: card.name, description: card.description, state: { initial: card.initial, color: card.color, definition: `【预览隐藏设定】${card.name}的示例私有人物资料。`, locationId }, knownByCharacterIds: [characterId], sourceTurnId: 'seed', createdAt, updatedAt: createdAt, version: 1 },
          { id: locationId, kind: 'location', name: characterId === 'preview-lin' ? '晨雾书店' : '山顶天文台', description: '仅用于界面预览的初始地点。', state: {}, knownByCharacterIds: [characterId], sourceTurnId: 'seed', createdAt, updatedAt: createdAt, version: 1 },
          { id: randomUUID(), kind: 'item', name: '蓝色书签', description: '夹在故事开头的一张演示书签。', state: { holderCharacterId: characterId }, knownByCharacterIds: [characterId], sourceTurnId: 'seed', createdAt, updatedAt: createdAt, version: 1 },
        ], playerProfile: null, settlementBacklog: { pendingTurns: 0, failedTurns: 0, oldestPendingAt: null },
      };
      if (options.playerProfileId) world.playerProfile = copy(requireOwned(profiles, ownerId, options.playerProfileId).profile);
    }
    if (options.scene) { world.scene = scene(options.scene, world); world.revision++; }
    if (!worldId) worlds.set(world.id, { ownerId, view: world });
    const session: Session = { id, worldId: world.id, characterId, title: `【演示】${card.name}`, createdAt, updatedAt: createdAt, dynamicOpening: !!options.dynamicOpening };
    const messages: Message[] = worldId || options.dynamicOpening ? [] : [{ id: randomUUID(), turnId: null, sessionId: id, role: 'assistant', content: card.greeting, createdAt, status: 'committed', characterId, characterName: card.name }];
    sessions.set(id, { ownerId, session, messages });
    return detail(ownerId, id);
  }
  function view(turn: Turn): TurnView {
    const messages = requireOwned(sessions, turn.ownerId, turn.sessionId).messages.filter(message => message.turnId === turn.id);
    const assistant = messages.find(message => message.role === 'assistant');
    return copy({ id: turn.id, worldId: turn.worldId, sessionId: turn.sessionId, status: turn.status, phase: turn.phase,
      userMessage: messages.find(message => message.role === 'user')!, ...(assistant ? { assistantMessage: assistant, assistantMessages: [assistant] } : {}), ...(turn.error ? { error: turn.error } : {}) });
  }
  function active(reference: { id: string; attempt: string }) {
    const turn = turns.get(reference.id);
    if (!turn || turn.attempt !== reference.attempt || turn.status !== 'running') throw new ServiceError('TURN_LEASE_LOST', '本次预览已结束。');
    return turn;
  }
  function begin(ownerId: string, sessionId: string, clientTurnId: string, content: string, metadata: Record<string, unknown> = {}, options: { operation?: string } = {}) {
    const row = requireOwned(sessions, ownerId, sessionId);
    const prior = [...turns.values()].find(turn => turn.sessionId === sessionId && turn.clientTurnId === clientTurnId);
    if (prior) {
      if (prior.content !== content) throw new ServiceError('CLIENT_TURN_CONFLICT', '预览请求编号已被使用。');
      if (prior.status === 'committed') return { ...copy(prior), replayed: true };
      if (prior.status === 'running') throw new ServiceError('TURN_RUNNING', '预览正在生成。');
      if ([...turns.values()].some(turn => turn.worldId === row.session.worldId && turn.status === 'running')) throw new ServiceError('WORLD_BUSY', '预览正在生成。');
      prior.status = 'running'; prior.attempt = randomUUID(); delete prior.error;
      row.messages.find(message => message.turnId === prior.id && message.role === 'user')!.status = 'pending';
      return { ...copy(prior), replayed: true };
    }
    if ([...turns.values()].some(turn => turn.worldId === row.session.worldId && turn.status === 'running')) throw new ServiceError('WORLD_BUSY', '预览正在生成。');
    const id = randomUUID();
    const turn: Turn = { id, ownerId, sessionId, worldId: row.session.worldId, clientTurnId, content, status: 'running', phase: 'responding',
      attempt: randomUUID(), draft: null, checkpoint: null, input: input(ownerId, sessionId, content, id, options.operation === 'opening' ? 'opening' : 'chat'), replayed: false, runtimeMetadata: metadata, usage: {}, calls: [] };
    turns.set(id, turn);
    row.messages.push({ id: randomUUID(), turnId: id, sessionId, role: 'user', content, kind: options.operation === 'opening' ? 'operation' : 'dialogue', createdAt: now(), status: 'pending' });
    return copy(turn);
  }
  function commit(reference: { id: string; attempt: string }, content: string) {
    const turn = active(reference), row = sessions.get(turn.sessionId)!, world = worlds.get(turn.worldId)!.view;
    const message: Message = { id: randomUUID(), turnId: turn.id, sessionId: turn.sessionId, role: 'assistant', content, createdAt: now(), status: 'committed', characterId: row.session.characterId, characterName: turn.input.character.name };
    row.messages.push(message); row.messages.find(message => message.turnId === turn.id && message.role === 'user')!.status = 'committed';
    row.session.updatedAt = now(); world.revision++; turn.status = 'committed'; turn.draft = null;
    return copy({ message, messages: [message], world });
  }
  function seed(ownerId: string) {
    if (seeded.has(ownerId)) return;
    seeded.add(ownerId);
    const id = randomUUID(); profiles.set(id, { ownerId, profile: { id, name: '旅人', persona: '【演示身份】喜欢书店与旅行的访客。', version: 1 } });
    const session = createSession(ownerId, characters[0].id, undefined, { playerProfileId: id });
    const turn = begin(ownerId, session.session.id, 'preview-seed', '我们从哪里开始？', { preview: true });
    const response = '【本地演示】林晚把蓝色书签放在桌上：“先从这里开始吧。你可以发送消息、切换角色，或者打开世界档案看看。”\n\n这条回复来自固定示例，没有调用模型。';
    commit(turn, response);
    turns.get(turn.id)!.calls.push({ id: randomUUID(), parentId: null, attemptId: turn.attempt, agent: 'actor', status: 'completed', model: 'preview-template-no-model', startedAt: now(), completedAt: now(), input: { preview: true, systemPrompt: defaultPrompts.actor, userText: turn.content }, output: { preview: true, text: response } });
  }
  const currentPrompts = () => Object.fromEntries([...prompts].map(([key, versions]) => [key, versions.at(-1)!.content])) as PromptSet;
  const buildRuntime = (overrides?: PromptSet): StoryRuntime => {
    const effective = () => overrides ?? currentPrompts();
    const reply = (packet: Input) => `【本地演示 · 无模型调用】${packet.character.name}轻轻点头：“${packet.operation === 'opening' ? '故事从这里开始，我们慢慢聊。' : '我听到了：' + packet.userText.slice(0, 100)}”\n\n这是用于检查聊天、流式显示与管理端隔离的固定回复。页面修改仅保存在本次进程内。`;
    const run: NonNullable<StoryRuntime['runTurn']> = async (packet, options) => {
      options.signal.throwIfAborted();
      const call: AgentCallRecord = { id: randomUUID(), parentId: null, attemptId: options.attemptId, agent: 'actor', status: 'running', model: 'preview-template-no-model', startedAt: now(), input: { preview: true, systemPrompt: effective().actor, character: packet.character, userText: packet.userText } };
      await options.onCall?.(call);
      const content = reply(packet);
      for (let index = 0; index < content.length; index += 10) { await delay(25, undefined, { signal: options.signal }); options.onTextDelta(content.slice(index, index + 10)); }
      await options.onCall?.({ ...call, status: 'completed', completedAt: now(), output: { preview: true, text: content } });
      return { text: content, changes: [], usage: {}, scene: packet.scene };
    };
    return { prompts: effective(), metadata: { preview: true, storage: 'in-memory', provider: 'deterministic-template', modelCalls: 0 },
      status: { provider: 'demo', model: 'preview-template-no-model', harness: { loaded: false, version: 'not-loaded-local-preview' }, offlineSimulation: false, modelRouter: 'fixture' },
      actor: async (packet, options) => { options.signal.throwIfAborted(); const content = reply(packet); options.onTextDelta(content); return { text: content }; },
      testAgent: async (key, packet, options) => {
        options.signal.throwIfAborted();
        const output = key === 'actor' ? { preview: true, text: reply(packet) } : { preview: true, notice: '本地界面预览：未调用模型，未执行世界更新。', commands: [] };
        const call: AgentCallRecord = { id: randomUUID(), parentId: null, attemptId: options.attemptId, agent: key, model: 'preview-template-no-model', startedAt: now(), status: 'running', input: { preview: true, systemPrompt: effective()[key as AgentKey], userText: packet.userText } };
        await options.onCall?.(call); await options.onCall?.({ ...call, status: 'completed', completedAt: now(), output });
        return { output };
      },
      updateWorld: async (_packet, options) => { options.signal.throwIfAborted(); return { changes: [] }; }, runTurn: run,
      runWorldTurn: async (packet, options) => ({ ...await run(packet, options), replies: [{ characterId: packet.character.id, characterName: packet.character.name, text: reply(packet) }], entityChanges: [], activities: [], observations: {} }),
    };
  };
  const fixtureStore = {
    leaseMs: 30_000, livingWorld: false, close: async () => {},
    pool: { query: async (sql: string) => { if (!sql.includes('legacy_agent_catalog')) throw new ServiceError('PREVIEW_UNAVAILABLE', '本地预览没有数据库。', 501); return { rows: [] }; } },
    ensureSeed: async (ownerId: string) => seed(ownerId), listCharacters: async () => copy(characters),
    listSessions: async (ownerId: string) => copy([...sessions.values()].filter(row => row.ownerId === ownerId).map(row => row.session).reverse()),
    listWorlds: async (ownerId: string) => copy([...worlds.values()].filter(row => row.ownerId === ownerId).map(row => row.view).reverse()),
    createSession: async (...args: Parameters<typeof createSession>) => createSession(...args),
    getSession: async (ownerId: string, id: string) => detail(ownerId, id),
    getWorld: async (ownerId: string, id: string) => copy(requireOwned(worlds, ownerId, id).view),
    messagePage: async (ownerId: string, id: string) => ({ messages: detail(ownerId, id).messages, hasMore: false, nextBefore: null }),
    previewInput: async (ownerId: string, id: string, content: string) => ({ ...input(ownerId, id, content), worldContext: { entities: detail(ownerId, id).world.entities, actorInputs: {} } }),
    beginTurn: async (...args: Parameters<typeof begin>) => begin(...args),
    storedTurn: async (ownerId: string, id: string) => copy(requireOwned(turns, ownerId, id)),
    getTurn: async (ownerId: string, id: string) => view(requireOwned(turns, ownerId, id)),
    renewAttempt: async (reference: { id: string; attempt: string }) => { active(reference); return true; },
    saveDraft: async (reference: { id: string; attempt: string }, content: string) => { active(reference).draft = content; },
    saveCheckpoint: async (reference: { id: string; attempt: string }, checkpoint: unknown) => { active(reference).checkpoint = copy(checkpoint); },
    saveCall: async (reference: { id: string; attempt: string }, record: AgentCallRecord) => { const calls = active(reference).calls; const index = calls.findIndex(call => call.id === record.id); if (index < 0) calls.push(copy(record)); else calls[index] = copy(record); },
    commit: async (...args: Parameters<typeof commit>) => commit(...args),
    finish: async (reference: { id: string; attempt: string }, status: 'failed' | 'cancelled', code: string, message: string) => {
      const turn = active(reference); turn.status = status; turn.error = { code, message };
      sessions.get(turn.sessionId)!.messages.find(message => message.turnId === turn.id && message.role === 'user')!.status = status;
      return true;
    },
    cancelTurn: async (ownerId: string, id: string, attempt?: string) => {
      const turn = requireOwned(turns, ownerId, id);
      if (turn.status === 'running' && (!attempt || attempt === turn.attempt)) {
        turn.status = 'cancelled'; turn.error = { code: 'TURN_CANCELLED', message: '已停止预览回复。' };
        sessions.get(turn.sessionId)!.messages.find(message => message.turnId === id && message.role === 'user')!.status = 'cancelled';
        for (const call of turn.calls) if (call.status === 'running') { call.status = 'cancelled'; call.completedAt = now(); }
      }
      return { view: view(turn), attempt: turn.attempt };
    },
    getTrace: async (ownerId: string, id: string) => { const turn = requireOwned(turns, ownerId, id); return copy({ turnId: id, status: turn.status, calls: turn.calls, metadata: { ...turn.runtimeMetadata, preview: true, modelCalls: 0 } }); },
    setScene: async (ownerId: string, id: string, revision: number, value: unknown, sessionId?: string) => {
      const world = worldForEdit(ownerId, id, revision); if (sessionId && requireOwned(sessions, ownerId, sessionId).session.worldId !== id) throw new ServiceError('NOT_FOUND', '会话不属于该世界。', 404);
      world.scene = scene(value, world); world.revision++; return copy(world);
    },
    setWorldClock: async (ownerId: string, id: string, revision: number) => { const world = worldForEdit(ownerId, id, revision); throw new ServiceError('PREVIEW_UNAVAILABLE', `本地预览不推进“${world.title}”的真实时间。`, 501); },
    setMemoryStatus: async (ownerId: string, id: string, eventId: string, revision: number, status: 'active' | 'retracted') => { const world = worldForEdit(ownerId, id, revision), event = world.events.find(row => row.id === eventId); if (!event) throw new ServiceError('NOT_FOUND', '预览记忆不存在。', 404); event.status = status; world.revision++; return copy(world); },
    retrySettlements: async (ownerId: string, id: string) => copy(requireOwned(worlds, ownerId, id).view),
    listPlayerProfiles: async (ownerId: string) => copy([...profiles.values()].filter(row => row.ownerId === ownerId).map(row => row.profile)),
    savePlayerProfile: async (ownerId: string, id: string | null, value: unknown) => {
      const raw = body(value), previous = id ? requireOwned(profiles, ownerId, id).profile : undefined;
      if (previous && raw.expectedVersion !== previous.version) throw new ServiceError('PROFILE_CHANGED', '预览身份版本已更新。');
      if (typeof raw.persona !== 'string' || raw.persona.length > 3000) throw new ServiceError('INPUT_INVALID', '身份描述最多 3000 字。', 422);
      const profile: PlayerProfile = { id: id ?? randomUUID(), name: text(raw.name, 80), persona: raw.persona.trim(), version: (previous?.version ?? 0) + 1 };
      profiles.set(profile.id, { ownerId, profile }); return copy(profile);
    },
    deletePlayerProfile: async (ownerId: string, id: string, version: number) => { const row = requireOwned(profiles, ownerId, id); if (row.profile.version !== version) throw new ServiceError('PROFILE_CHANGED', '预览身份版本已更新。'); profiles.delete(id); },
    setPlayerProfile: async (ownerId: string, id: string, profileId: string | null, revision: number) => { const world = worldForEdit(ownerId, id, revision); world.playerProfile = profileId ? copy(requireOwned(profiles, ownerId, profileId).profile) : null; world.revision++; return copy(world); },
    getPrompts: async () => copy([...prompts.values()].map(versions => versions.at(-1)!)),
    listPromptVersions: async (key: AgentKey) => copy([...(prompts.get(key) ?? [])].reverse()),
    savePrompt: async (key: AgentKey, content: string, expectedVersion: number) => { const versions = prompts.get(key); if (!versions) throw new ServiceError('NOT_FOUND', '预览 Prompt 不存在。', 404); if (versions.at(-1)!.version !== expectedVersion) throw new ServiceError('REVISION_CONFLICT', '预览 Prompt 版本已更新。'); const row = { key, version: expectedVersion + 1, content: text(content, 12000), createdAt: now() }; versions.push(row); return copy(row); },
    runtimeAudit: async (ownerId: string, id: string) => { const world = requireOwned(worlds, ownerId, id).view; return copy({ preview: true, notice: '本地界面预览未运行真实归档或审计任务。', capture: null, turns: [], events: [], backlog: { pendingTurns: 0, failedTurns: 0 }, worldRevision: world.revision, world: { id, title: world.title, revision: world.revision, capturedAt: now(), scene: world.scene, entities: world.entities }, calls: [], truncated: false }); },
    startRuntimeCapture: async () => { throw new ServiceError('PREVIEW_UNAVAILABLE', '本地界面预览没有真实归档任务，不能开始审计录制。', 501); },
  };
  seed('local');
  return { store: fixtureStore as unknown as StoryStore, runtime: buildRuntime(), defaultPrompts, buildRuntime: async (overrides?: PromptSet) => buildRuntime(overrides) };
}
