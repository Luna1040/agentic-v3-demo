import express, { type Request, type Response, type NextFunction } from 'express';
import type { Bootstrap, ChatType, TurnEvent } from '../shared/contracts.ts';
import { ServiceError, type OperationRuntimeResolver, type StoryRuntime } from './runtime.ts';
import { StoryStore } from './store.ts';
import { TurnService } from './turn-service.ts';
import { mountDeveloper, type DeveloperOptions } from './developer.ts';

export interface AppOptions {
  store: StoryStore;
  runtime: StoryRuntime;
  /** Trusted official-app authentication adapter. The default is a loopback-only local demo identity. */
  authenticate?: (request: Request) => string | Promise<string>;
  resolveRuntime?: () => Promise<StoryRuntime>;
  /** Builds one isolated runtime for a chat-operation turn. Plain chat never uses
   * it; tests inject a recording fake, production defaults to the forked runtime. */
  resolveOperationRuntime?: OperationRuntimeResolver;
  developer?: DeveloperOptions;
}
const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ServiceError('INPUT_INVALID', `${field}格式无效。`, 422);
  return value;
}
function owner(res: Response): string { return res.locals.ownerId as string; }
function id(req: Request, key: string): string { return text(req.params[key], key, 100); }

/** The HTTP boundary accepts the frozen user-facing PascalCase signal and the
 * internal lowercase one; every other value is rejected instead of defaulting. */
const chatTypeAliases: Readonly<Record<string, ChatType>> = Object.freeze({
  Chat: 'chat', chat: 'chat', Continue: 'continue', continue: 'continue',
  Regenerate: 'regenerate', regenerate: 'regenerate', EditRegenerate: 'edit_regenerate', edit_regenerate: 'edit_regenerate',
});
const uuidValue = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Same literal/field shape as server/chat-operations.ts operationTurnMetadata, kept
 * local so the HTTP boundary does not depend on the prompt module's build order. */
function operationTurnMetadata(chatType: ChatType, targetTurnId: string | null): Record<string, unknown> {
  return chatType === 'chat' ? {} : { chatOperation: { version: 'chat-operations-v1', chatType, targetTurnId } };
}
/** Strict, server-authoritative chat-operation request. Unknown body fields never
 * influence the turn; forged question/previousResponse/ownerId are ignored because
 * they are simply not read. */
function turnRequest(body: Record<string, unknown> | undefined): { request: { clientTurnId: string; chatType: ChatType; content?: string; targetTurnId?: string }; chatType: ChatType; targetTurnId: string | null } {
  const clientTurnId = text(body?.clientTurnId, '请求编号', 100);
  const raw = body?.chatType;
  let chatType: ChatType;
  if (raw === undefined) chatType = 'chat';
  else if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(chatTypeAliases, raw)) chatType = chatTypeAliases[raw];
  else throw new ServiceError('CHAT_TYPE_INVALID', '聊天类型无效。', 422);
  const hasContent = body?.content !== undefined;
  const content = hasContent ? body.content : undefined;
  if (hasContent && typeof content !== 'string') throw new ServiceError('INPUT_INVALID', '消息格式无效。', 422);
  const rawTarget = body?.targetTurnId;
  if (rawTarget !== undefined && (typeof rawTarget !== 'string' || !rawTarget.trim() || rawTarget.length > 100 || !uuidValue(rawTarget))) throw new ServiceError('TARGET_INVALID', '重写目标无效。', 422);
  const targetTurnId = rawTarget as string | undefined;
  if (chatType === 'chat') {
    if (targetTurnId !== undefined) throw new ServiceError('CHAT_TYPE_CONFLICT', '普通聊天不能指定重写目标。', 422);
    if (!hasContent || !(content as string).trim() || (content as string).length > 8000) throw new ServiceError('INPUT_INVALID', '消息格式无效。', 422);
    return { request: { clientTurnId, chatType, content: content as string }, chatType, targetTurnId: null };
  }
  if (chatType === 'continue') {
    if ((hasContent && content !== '') || targetTurnId !== undefined) throw new ServiceError('CHAT_TYPE_CONFLICT', '继续操作不能携带新的玩家消息或目标。', 422);
    return { request: { clientTurnId, chatType, content: '' }, chatType, targetTurnId: null };
  }
  if (!targetTurnId) throw new ServiceError('TARGET_INVALID', chatType === 'regenerate' ? '重新生成需要指定目标消息。' : '编辑并重写需要指定目标消息。', 422);
  if (chatType === 'regenerate') {
    if (hasContent && content !== '') throw new ServiceError('CHAT_TYPE_CONFLICT', '重新生成不能携带新的玩家消息。', 422);
    return { request: { clientTurnId, chatType, targetTurnId, content: '' }, chatType, targetTurnId };
  }
  if (!hasContent || !(content as string).trim() || (content as string).length > 8000) throw new ServiceError('INPUT_INVALID', '消息格式无效。', 422);
  return { request: { clientTurnId, chatType, content: content as string, targetTurnId }, chatType, targetTurnId };
}

export function createApp({ store, runtime, authenticate = () => 'local', resolveRuntime = async () => runtime, resolveOperationRuntime, developer }: AppOptions) {
  const app = express();
  const turns = new TurnService(store, runtime, resolveRuntime, resolveOperationRuntime);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (req, res, next) => {
    Promise.resolve().then(() => authenticate(req)).then((ownerId) => {
      if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) throw new ServiceError('AUTH_REQUIRED', '请先登录。', 401);
      res.locals.ownerId = ownerId;
      next();
    }).catch(next);
  });
  app.locals.turns = turns;
  const stopTests = developer ? mountDeveloper(app, store, developer) : () => {};
  app.locals.shutdown = () => { stopTests(); return turns.shutdown(); };

  app.get('/api/bootstrap', route(async (req, res) => {
    await store.ensureSeed(owner(res));
    const [characters, sessions, worlds] = await Promise.all([store.listCharacters(), store.listSessions(owner(res)), store.listWorlds(owner(res))]);
    const result: Bootstrap = { characters, sessions, worlds, status: { ...runtime.status, developerTools: developer ? await developer.authorize(req) : false } };
    res.json(result);
  }));
  app.post('/api/sessions', route(async (req, res) => {
    const characterId = text(req.body?.characterId, '角色', 100);
    const worldId = req.body?.worldId === undefined ? undefined : text(req.body.worldId, '故事', 100);
    if (req.body?.dynamicOpening !== undefined && typeof req.body.dynamicOpening !== 'boolean') throw new ServiceError('INPUT_INVALID', '开场选项无效。', 422);
    if (req.body?.expectedRevision !== undefined && (!Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 0)) throw new ServiceError('INPUT_INVALID', '故事版本无效。', 422);
    if (req.body?.dynamicOpening && !runtime.runWorldTurn) throw new ServiceError('OPENING_UNAVAILABLE', '当前运行时尚未提供动态开场。', 503);
    const playerProfileId = req.body?.playerProfileId;
    if(playerProfileId !== undefined && playerProfileId !== null) text(playerProfileId,'玩家身份',100);
    res.status(201).json(await store.createSession(owner(res), characterId, worldId, {
      ...(req.body?.dynamicOpening !== undefined ? { dynamicOpening: req.body.dynamicOpening } : {}),
      ...(req.body?.scene !== undefined ? { scene: req.body.scene } : {}),
      ...(req.body?.expectedRevision !== undefined ? { expectedRevision: req.body.expectedRevision } : {}),
      ...(playerProfileId !== undefined ? { playerProfileId } : {}),
    }));
  }));
  app.get('/api/player-profiles',route(async (_req,res)=>res.json({profiles:await store.listPlayerProfiles(owner(res))})));
  app.post('/api/player-profiles',route(async (req,res)=>res.status(201).json(await store.savePlayerProfile(owner(res),null,req.body))));
  app.put('/api/player-profiles/:id',route(async (req,res)=>res.json(await store.savePlayerProfile(owner(res),id(req,'id'),req.body))));
  app.delete('/api/player-profiles/:id',route(async (req,res)=>{
    if(!Number.isSafeInteger(req.body?.expectedVersion)||req.body.expectedVersion<1) throw new ServiceError('INPUT_INVALID','身份版本无效。',422);
    await store.deletePlayerProfile(owner(res),id(req,'id'),req.body.expectedVersion);res.status(204).end();
  }));
  app.patch('/api/worlds/:id/player-profile',route(async (req,res)=>{
    if(!Number.isSafeInteger(req.body?.expectedRevision)||req.body.expectedRevision<0) throw new ServiceError('INPUT_INVALID','故事版本无效。',422);
    const profileId=req.body?.profileId;
    if(profileId!==null) text(profileId,'玩家身份',100);
    res.json(await store.setPlayerProfile(owner(res),id(req,'id'),profileId,req.body.expectedRevision));
  }));
  app.get('/api/worlds/:id', route(async (req, res) => res.json(await store.getWorld(owner(res), id(req, 'id')))));
  app.get('/api/worlds/:id/runtime-audit',route(async(req,res)=>{
    if(!developer)throw new ServiceError('NOT_FOUND','此入口未启用。',404);
    if(!await developer.authorize(req))throw new ServiceError('DEVELOPER_REQUIRED','此入口需要开发调试权限。',403);
    if(req.query.includeCalls!==undefined&&req.query.includeCalls!=='1'&&req.query.includeCalls!=='0')throw new ServiceError('INPUT_INVALID','调用导出选项无效。',422);
    res.json(await store.runtimeAudit(owner(res),id(req,'id'),req.query.captureId===undefined?undefined:text(req.query.captureId,'观测批次',100),req.query.includeCalls==='1'));
  }));
  app.post('/api/worlds/:id/runtime-audit/capture',route(async(req,res)=>{
    if(!developer)throw new ServiceError('NOT_FOUND','此入口未启用。',404);
    if(!await developer.authorize(req))throw new ServiceError('DEVELOPER_REQUIRED','此入口需要开发调试权限。',403);
    if(req.body&&Object.keys(req.body).some(key=>key!=='expectedTurns'))throw new ServiceError('INPUT_INVALID','观测选项无效。',422);
    res.status(201).json(await store.startRuntimeCapture(owner(res),id(req,'id'),req.body?.expectedTurns??7));
  }));
  app.post('/api/worlds/:id/settlements/retry', route(async (req, res) => {
    const world = await store.retrySettlements(owner(res), id(req, 'id'));
    turns.settlement.wake();
    res.json(world);
  }));
  app.patch('/api/worlds/:id/clock', route(async (req, res) => {
    if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 0) throw new ServiceError('INPUT_INVALID', '故事版本无效。', 422);
    res.json(await store.setWorldClock(owner(res), id(req, 'id'), req.body.expectedRevision, { mode: req.body?.mode, rate: req.body?.rate }));
  }));
  app.get('/api/sessions/:id', route(async (req, res) => res.json(await store.getSession(owner(res), id(req, 'id')))));
  app.get('/api/sessions/:id/messages', route(async (req, res) => {
    const before = req.query.before === undefined ? undefined : text(req.query.before, '分页位置', 100);
    res.json(await store.messagePage(owner(res), id(req, 'id'), before));
  }));
  app.get('/api/turns/:id', route(async (req, res) => res.json(await store.getTurn(owner(res), id(req, 'id')))));
  app.get('/api/turns/:id/trace', route(async (req, res) => {
    if (!developer || !await developer.authorize(req)) throw new ServiceError('DEVELOPER_REQUIRED', '此入口需要开发调试权限。', 403);
    res.json(await store.getTrace(owner(res), id(req, 'id')));
  }));
  app.patch('/api/worlds/:id/scene', route(async (req, res) => {
    const revision = req.body?.expectedRevision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ServiceError('INPUT_INVALID', '故事版本无效。', 422);
    const sessionId = req.body?.sessionId === undefined ? undefined : text(req.body.sessionId, '会话', 100);
    res.json(await store.setScene(owner(res), id(req, 'id'), revision, req.body?.scene, sessionId));
  }));
  app.patch('/api/worlds/:id/events/:eventId', route(async (req, res) => {
    const revision = req.body?.expectedRevision;
    const status = req.body?.status;
    if (!Number.isSafeInteger(revision) || revision < 0 || !['active', 'retracted'].includes(status)) throw new ServiceError('INPUT_INVALID', '记忆状态或故事版本无效。', 422);
    res.json(await store.setMemoryStatus(owner(res), id(req, 'id'), id(req, 'eventId'), revision, status));
  }));
  app.post('/api/turns/:id/cancel', route(async (req, res) => res.json(await turns.cancel(owner(res), id(req, 'id')))));
  const executeTurn = (opening: boolean) => route(async (req, res) => {
    const sessionId = id(req, 'id');
    const selectedRuntime = await resolveRuntime();
    let turn;
    if (opening) {
      const clientTurnId = `opening:${sessionId}`;
      const content = '为当前场景生成连贯的第一幕，保留玩家选择。';
      if (!selectedRuntime.runWorldTurn) throw new ServiceError('OPENING_UNAVAILABLE', '当前运行时尚未提供动态开场。', 503);
      turn = await store.beginTurn(owner(res), sessionId, clientTurnId, content, selectedRuntime.metadata, { operation: 'opening' });
    } else {
      const { request, chatType, targetTurnId } = turnRequest(req.body as Record<string, unknown> | undefined);
      // The frozen strategy identity joins the runtime metadata so a retry of the
      // same operation turn keeps the same recovery fingerprint.
      const metadata = { ...(selectedRuntime.metadata ?? {}), ...operationTurnMetadata(chatType, targetTurnId) };
      turn = await store.beginTurn(owner(res), sessionId, request, metadata);
    }
    // PostgreSQL may have waited for a world lock while this connection disappeared.
    // Persist cancellation before any model execution, even if no SSE headers were sent.
    if (res.destroyed || req.aborted) {
      if (turn.status !== 'committed') await turns.cancel(turn.ownerId, turn.id, turn.attempt);
      return;
    }
    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const onClose = () => { if (!res.writableEnded) void turns.cancel(turn.ownerId, turn.id, turn.attempt).catch(() => {}); };
    res.once('close', onClose);
    res.flushHeaders();
    const emit = (event: TurnEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    const current = await store.getTurn(owner(res), turn.id);
    if (res.destroyed || req.aborted) {
      if (turn.status !== 'committed') await turns.cancel(turn.ownerId, turn.id, turn.attempt);
      return;
    }
    emit({ type: 'accepted', turnId: turn.id, userMessage: current.userMessage, replayed: turn.replayed });
    if (turn.status === 'committed') {
      emit({ type: 'committed', turnId: turn.id, message: current.assistantMessage!, messages: current.assistantMessages, world: (await store.getSession(owner(res), turn.sessionId)).world });
      res.end(); return;
    }
    const keepalive = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15_000);
    keepalive.unref();
    try { await turns.run(turn, emit, selectedRuntime); }
    finally { clearInterval(keepalive); res.off('close', onClose); if (!res.destroyed) res.end(); }
  });
  app.post('/api/sessions/:id/turns', executeTurn(false));
  app.post('/api/sessions/:id/opening', executeTurn(true));
  app.use('/api', (_req, _res, next) => next(new ServiceError('NOT_FOUND', '接口不存在。', 404)));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const status = error instanceof ServiceError ? error.status : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: { code: error instanceof ServiceError ? error.code : status === 400 ? 'INPUT_INVALID' : 'INTERNAL_ERROR', message: error instanceof ServiceError ? error.message : status === 400 ? '请求格式无效。' : '服务暂时不可用，请重试。' } });
  });
  return app;
}
