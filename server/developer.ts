import { randomUUID } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { AgentCallRecord, AgentKey, AgentPromptConfig, AgentTestResult, ModelUsage, PromptVersion } from '../shared/contracts.ts';
import { ServiceError, type PromptSet, type StoryRuntime } from './runtime.ts';
import type { StoryStore } from './store.ts';
import { legacyAgentCatalog } from './legacy-agents.ts';

export interface DeveloperOptions {
  authorize: (request: Request) => boolean | Promise<boolean>;
  defaultPrompts: PromptSet;
  buildRuntime: (prompts: PromptSet, versions: Partial<Record<AgentKey, number>>) => Promise<StoryRuntime>;
}
const labels: Record<AgentKey, string> = { main: 'Main · 主线规划', actor: 'Actor · 场景演绎', updater: 'WorldOps · 世界维护', opening: 'Opening Director · 动态开场', pulse: 'World Pulse · 时间结算', arbiter: 'World Arbiter · 冲突审查' };
const keys = Object.keys(labels) as AgentKey[];
const route = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
function agentKey(value: unknown): AgentKey {
  if (typeof value !== 'string' || !keys.includes(value as AgentKey)) throw new ServiceError('AGENT_NOT_FOUND', 'Agent 不存在。', 404);
  return value as AgentKey;
}
function text(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ServiceError('INPUT_INVALID', `${label}不能为空或超过 ${max} 字符。`, 422);
  return value;
}
function testFailure(error: unknown, signal: AbortSignal): { error: { code: string; message: string }; output?: unknown; usage?: ModelUsage } {
  const fallback = { error: { code: signal.aborted ? 'TEST_CANCELLED' : 'AGENT_TEST_FAILED', message: signal.aborted ? '试跑已停止或超时。' : '本次试跑未完成，请检查 Prompt 和输出格式。' } };
  if (signal.aborted || !(error instanceof Error) || error.name !== 'StoryRuntimeError') return fallback;
  const known = error as Error & { code?: unknown; output?: unknown; usage?: ModelUsage };
  const codes = ['PROVIDER_TIMEOUT','PROVIDER_FAILED','PROVIDER_CONTENT_FILTER','PROVIDER_PROTOCOL_ERROR','AGENT_CANCELLED','UPDATER_OUTPUT_INVALID','PULSE_OUTPUT_INVALID','ARBITER_OUTPUT_INVALID','INVALID_MAIN_PLAN','INVALID_SCENE_PLAN','INVALID_AGENT_DATA','CALL_RECORDING_FAILED','CHECKPOINT_FAILED'];
  if (typeof known.code !== 'string' || !codes.includes(known.code)) return fallback;
  const result: ReturnType<typeof testFailure> = { error: { code: known.code, message: known.message.slice(0,1000) } };
  const usage: ModelUsage = {};
  for (const key of ['inputTokens','outputTokens','totalTokens'] as const) if (Number.isSafeInteger(known.usage?.[key]) && known.usage![key]! >= 0) usage[key] = known.usage![key];
  if (Object.keys(usage).length) result.usage = usage;
  // These are completed model candidates, never provider responses, headers or Error objects.
  if (['UPDATER_OUTPUT_INVALID','PULSE_OUTPUT_INVALID','ARBITER_OUTPUT_INVALID','INVALID_SCENE_PLAN'].includes(known.code) && known.output && typeof known.output === 'object') {
    const value = known.output as Record<string, unknown>;
    const candidate = typeof value.text === 'string' ? { text: value.text } : 'candidate' in value ? { candidate: value.candidate } : 'arguments' in value ? { arguments: value.arguments } : undefined;
    if (candidate) {
      try {
        const json = JSON.stringify(candidate, (key,item) => /^(authorization|api[-_]?key|access[-_]?token|password|secret)$/i.test(key) ? '[REDACTED]' : item);
        if (json.length <= 16000) result.output = JSON.parse(json);
      } catch { /* Keep the safe error and usage if a candidate is not serializable. */ }
    }
  }
  return result;
}
function chainUsage(byAgent: Partial<Record<AgentKey, ModelUsage>>, calls: AgentCallRecord[]): ModelUsage | undefined {
  const executed = [...new Set(calls.filter(call => call.status !== 'reused').map(call => call.agent))];
  if (!executed.length) return undefined;
  const total: ModelUsage = {};
  for (const field of ['inputTokens','outputTokens','totalTokens'] as const) {
    const values = executed.map(agent => byAgent[agent]?.[field]);
    if (values.every(value => Number.isSafeInteger(value) && value! >= 0)) {
      const sum = values.reduce<number>((count,value) => count + value!,0);
      if (Number.isSafeInteger(sum)) total[field] = sum;
    }
  }
  return Object.keys(total).length ? total : undefined;
}
export async function promptSnapshot(store: StoryStore, defaults: PromptSet) {
  const rows = await store.getPrompts();
  const prompts = { ...defaults };
  const versions: Partial<Record<AgentKey, number>> = {};
  for (const row of rows) { prompts[row.key] = row.content; versions[row.key] = row.version; }
  return { prompts, versions, rows };
}

/** Official hosts must supply an explicit developer permission check; the default app grants nothing. */
export function mountDeveloper(app: Express, store: StoryStore, options: DeveloperOptions) {
  const pendingTests = new Map<string, AbortController>();
  app.use('/api/dev', (req, res, next) => {
    Promise.resolve(options.authorize(req)).then(allowed => {
      if (!allowed) throw new ServiceError('DEVELOPER_REQUIRED', '此入口需要开发调试权限。', 403);
      next();
    }).catch(next);
  });
  async function config(key: AgentKey): Promise<AgentPromptConfig> {
    const snapshot = await promptSnapshot(store, options.defaultPrompts);
    const content = snapshot.prompts[key];
    if (content === undefined) throw new ServiceError('AGENT_NOT_FOUND', '此部署未接入该 Agent。', 404);
    const row: PromptVersion = snapshot.rows.find(item => item.key === key) ?? { key, version: 0, content, createdAt: new Date(0).toISOString() };
    const runtime = await options.buildRuntime(snapshot.prompts, snapshot.versions);
    const model = ['updater', 'pulse', 'arbiter'].includes(key) ? runtime.metadata?.updaterModel : ['main', 'opening'].includes(key) ? runtime.metadata?.mainModel : runtime.status.model;
    return { ...row, label: labels[key], defaultContent: options.defaultPrompts[key]!, model: typeof model === 'string' ? model : runtime.status.model, history: await store.listPromptVersions(key) };
  }
  const supportedKeys = keys.filter(key => typeof options.defaultPrompts[key] === 'string');
  app.get('/api/dev/agent-catalog', route(async (_req, res) => res.json({ agents: await legacyAgentCatalog(store.pool) })));
  app.get('/api/dev/prompts', route(async (_req, res) => res.json({ prompts: await Promise.all(supportedKeys.map(config)) })));
  app.put('/api/dev/prompts/:key', route(async (req, res) => {
    const key = agentKey(req.params.key);
    if (!supportedKeys.includes(key)) throw new ServiceError('AGENT_NOT_FOUND', '此部署未接入该 Agent。', 404);
    const content = text(req.body?.content, 12_000, 'Prompt');
    const version = req.body?.expectedVersion;
    if (!Number.isSafeInteger(version) || version < 0) throw new ServiceError('INPUT_INVALID', 'Prompt 版本无效。', 422);
    // Validate the effective runtime before publishing a version.
    const snapshot = await promptSnapshot(store, options.defaultPrompts);
    await options.buildRuntime({ ...snapshot.prompts, [key]: content }, snapshot.versions);
    await store.savePrompt(key, content, version);
    res.json(await config(key));
  }));
  app.post('/api/dev/agents/:key/test', route(async (req, res) => {
    const key = agentKey(req.params.key);
    if (!supportedKeys.includes(key)) throw new ServiceError('AGENT_NOT_FOUND', '此部署未接入该 Agent。', 404);
    const owner = res.locals.ownerId as string;
    if (pendingTests.has(owner)) throw new ServiceError('TEST_RUNNING', '已有一次试跑正在进行，请等待或停止它。');
    const prompt = text(req.body?.prompt, 12_000, 'Prompt');
    const sessionId = text(req.body?.sessionId, 100, '会话');
    const userText = text(req.body?.userText, 8000, '测试消息');
    const assistantText = key === 'updater' ? text(req.body?.assistantText, 12_000, '待检查的角色回复') : undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const onClose = () => { if (!res.writableEnded) controller.abort(new DOMException('Test cancelled', 'AbortError')); };
    pendingTests.set(owner, controller);
    res.once('close', onClose);
    const started = Date.now();
    const calls: AgentCallRecord[] = [];
    try {
      const input = await store.previewInput(owner, sessionId, userText);
      const snapshot = await promptSnapshot(store, options.defaultPrompts);
      const runtime = await options.buildRuntime({ ...snapshot.prompts, [key]: prompt }, snapshot.versions);
      signal.throwIfAborted();
      if (res.destroyed || req.aborted) return;
      let output: unknown; let usage: ModelUsage | undefined;
      if (key === 'main') {
        const run = input.worldContext && runtime.runWorldTurn ? runtime.runWorldTurn : runtime.runTurn;
        if (!run) throw new ServiceError('MAIN_UNAVAILABLE', '此运行时尚未提供 Main Agent。', 503);
        const result = await run(input, {
          attemptId: randomUUID(), signal, onTextDelta: () => {}, onCheckpoint: async () => {},
          onCall: async record => { signal.throwIfAborted(); const index = calls.findIndex(call => call.id === record.id); if (index === -1) calls.push(structuredClone(record)); else calls[index] = structuredClone(record); },
        });
        output = result;
        usage = chainUsage(result.usage, calls);
      } else if (runtime.testAgent && input.worldContext) {
        const result = await runtime.testAgent(key, { ...input, ...(assistantText ? { assistantText } : {}) }, {
          signal, attemptId: randomUUID(),
          onCall: async record => { signal.throwIfAborted(); const index = calls.findIndex(call => call.id === record.id); if (index === -1) calls.push(structuredClone(record)); else calls[index] = structuredClone(record); },
        });
        output = result.output; usage = result.usage;
      } else if (key === 'actor' || key === 'updater') {
        const call: AgentCallRecord = { id: randomUUID(), parentId: null, attemptId: randomUUID(), agent: key, status: 'running', model: key === 'updater' && typeof runtime.metadata?.updaterModel === 'string' ? runtime.metadata.updaterModel : runtime.status.model, startedAt: new Date().toISOString(), input: key === 'updater' ? { ...input, assistantText } : input };
        calls.push(call);
        try {
          const result = key === 'actor' ? await runtime.actor(input, { signal, onTextDelta: () => {} }) : await runtime.updateWorld({ ...input, assistantText: assistantText! }, { signal });
          output = result; usage = result.usage;
          Object.assign(call, { status: 'completed', completedAt: new Date().toISOString(), output: result, ...(usage ? { usage } : {}) });
        } catch (error) {
          const diagnostic = testFailure(error, signal);
          usage = diagnostic.usage;
          Object.assign(call, { status: signal.aborted ? 'cancelled' : 'failed', completedAt: new Date().toISOString(), ...diagnostic });
          output = { error: diagnostic.error, ...(diagnostic.output !== undefined ? { details: diagnostic.output } : {}) };
        }
      } else throw new ServiceError('AGENT_UNAVAILABLE', '该 Agent 尚未提供独立试跑接口。', 503);
      signal.throwIfAborted();
      if (!res.destroyed) res.json({ agent: key, calls, output, ...(usage ? { usage } : {}), durationMs: Date.now() - started, committed: false } satisfies AgentTestResult);
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof ServiceError) throw error;
      const diagnostic = testFailure(error, signal);
      res.json({ agent: key, calls, output: { error: diagnostic.error, ...(diagnostic.output !== undefined ? { details: diagnostic.output } : {}) }, ...(diagnostic.usage ? { usage: diagnostic.usage } : {}), durationMs: Date.now() - started, committed: false } satisfies AgentTestResult);
    } finally { res.off('close', onClose); if (pendingTests.get(owner) === controller) pendingTests.delete(owner); }
  }));
  return () => { for (const controller of pendingTests.values()) controller.abort(new DOMException('Service stopped', 'AbortError')); };
}
