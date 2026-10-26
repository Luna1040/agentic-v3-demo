import express, { type Request, type Response, type NextFunction } from 'express';
import type { Bootstrap, TurnEvent } from '../shared/contracts.ts';
import { ServiceError, type StoryRuntime } from './runtime.ts';
import { StoryStore } from './store.ts';
import { TurnService } from './turn-service.ts';
import { mountDeveloper, type DeveloperOptions } from './developer.ts';

export interface AppOptions {
  store: StoryStore;
  runtime: StoryRuntime;
  /** Trusted official-app authentication adapter. The default is a loopback-only local demo identity. */
  authenticate?: (request: Request) => string | Promise<string>;
  resolveRuntime?: () => Promise<StoryRuntime>;
  developer?: DeveloperOptions;
}
const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ServiceError('INPUT_INVALID', `${field}格式无效。`, 422);
  return value;
}
function owner(res: Response): string { return res.locals.ownerId as string; }
function id(req: Request, key: string): string { return text(req.params[key], key, 100); }

export function createApp({ store, runtime, authenticate = () => 'local', resolveRuntime = async () => runtime, developer }: AppOptions) {
  const app = express();
  const turns = new TurnService(store, runtime, resolveRuntime);
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
    const clientTurnId = opening ? `opening:${sessionId}` : text(req.body?.clientTurnId, '请求编号', 100);
    const content = opening ? '为当前场景生成连贯的第一幕，保留玩家选择。' : text(req.body?.content, '消息', 8000);
    const selectedRuntime = await resolveRuntime();
    if (opening && !selectedRuntime.runWorldTurn) throw new ServiceError('OPENING_UNAVAILABLE', '当前运行时尚未提供动态开场。', 503);
    const turn = await store.beginTurn(owner(res), sessionId, clientTurnId, content, selectedRuntime.metadata, { operation: opening ? 'opening' : 'chat' });
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
