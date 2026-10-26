import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeSettings, serverSettings } from './config.ts';
import { MEMORY_POLICY, ServiceError, type StoryRuntime, type PromptSet, type DialogueReader } from './runtime.ts';
import type { AgentKey } from '../shared/contracts.ts';
import type { StoryRuntime as HarnessRuntime, RuntimeConfig } from '../shared/harness.ts';

// Node caches this module and its dependencies. A rebuilt manifest must never label
// already-loaded code as the new build; a deployment restart is the safe boundary.
const loadedBuilds = new Map<string, string>();

export async function loadRuntime(overrides: { prompts?: PromptSet; promptVersions?: Partial<Record<AgentKey, number>>; readDialogue?: DialogueReader } = {}): Promise<StoryRuntime> {
  const { harnessPath } = serverSettings();
  if (!existsSync(harnessPath)) throw new Error('请先运行 npm run harness:build，生成 Harness 应用。');
  const buildPath = resolve(dirname(harnessPath), 'build.json');
  if (!existsSync(buildPath)) throw new Error('Harness 构建身份缺失，请重新执行 npm run harness:build。');
  const build = JSON.parse(readFileSync(buildPath, 'utf8')) as Record<string, unknown>;
  if (typeof build.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(build.sourceCommit)
    || typeof build.appSourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(build.appSourceHash)) throw new Error('Harness 构建身份无效。');
  const buildIdentity = `${build.sourceCommit}:${build.appSourceHash}`;
  const previousBuild = loadedBuilds.get(harnessPath);
  if (previousBuild && previousBuild !== buildIdentity) throw new ServiceError('HARNESS_RESTART_REQUIRED', 'Harness 构建已更新，请重启业务服务后再发起新回合。', 503);
  loadedBuilds.set(harnessPath, buildIdentity);
  let loaded;
  try { loaded = await import(pathToFileURL(harnessPath).href); }
  catch (error) { if (!previousBuild) loadedBuilds.delete(harnessPath); throw error; }
  const createStoryRuntime = loaded.createStoryRuntime as (config: RuntimeConfig) => HarnessRuntime;
  const config = runtimeSettings();
  const underlying = createStoryRuntime({ ...config, ...(overrides.readDialogue ? {readDialogue:overrides.readDialogue}: {}), ...(overrides.prompts ? { prompts: overrides.prompts } : {}) });
  const identity = { ...underlying.metadata, memoryPolicy: MEMORY_POLICY, contextPolicy: 'context-pack-on-demand-v1', sourceCommit: build.sourceCommit, appSourceHash: build.appSourceHash, ...(overrides.promptVersions ? { promptVersions: overrides.promptVersions } : {}) };
  const metadata = Object.freeze({ ...identity, runtimeFingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex') });
  return {
    ...('streamDialogue' in underlying ? { streamDialogue: (input: Parameters<NonNullable<StoryRuntime['streamDialogue']>>[0], options: Parameters<NonNullable<StoryRuntime['streamDialogue']>>[1]) => (underlying as HarnessRuntime & {streamDialogue: NonNullable<StoryRuntime['streamDialogue']>}).streamDialogue(input, options) } : {}),
    actor: (input, options) => underlying.actor(input, options),
    updateWorld: (input, options) => underlying.updateWorld(input, options),
    ...(underlying.planNextScene ? { planNextScene: ((input, options) => underlying.planNextScene(input, options)) as NonNullable<StoryRuntime['planNextScene']> } : {}),
    ...(underlying.settleOfflineTurn ? { settleOfflineTurn: ((input, options) => underlying.settleOfflineTurn(input, options)) as NonNullable<StoryRuntime['settleOfflineTurn']> } : {}),
    ...(underlying.settleWorldBatch ? { settleWorldBatch: ((entries, options) => underlying.settleWorldBatch(entries.map(entry => ({...entry, dialogue: {...entry.dialogue, discardedChanges: entry.dialogue.discardedChanges ?? []}})), options)) as NonNullable<StoryRuntime['settleWorldBatch']> } : {}),
    ...(underlying.settleWorldTurn ? { settleWorldTurn: ((input, dialogue, options) => underlying.settleWorldTurn(input, {...dialogue, discardedChanges: dialogue.discardedChanges ?? []}, options)) as NonNullable<StoryRuntime['settleWorldTurn']> } : {}),
    runTurn: (input, options) => underlying.runTurn(input, options),
    ...(underlying.runWorldTurn ? { runWorldTurn: (input: Parameters<NonNullable<StoryRuntime['runWorldTurn']>>[0], options: Parameters<NonNullable<StoryRuntime['runWorldTurn']>>[1]) => underlying.runWorldTurn(input, options) } : {}),
    ...(underlying.testAgent ? { testAgent: (key: AgentKey, input: Parameters<NonNullable<StoryRuntime['testAgent']>>[1], options: Parameters<NonNullable<StoryRuntime['testAgent']>>[2]) => underlying.testAgent(key, input, options) } : {}),
    prompts: underlying.prompts,
    metadata,
    status: { provider: config.mode, model: underlying.status.model,
      harness: { loaded: true, version: underlying.status.harnessVersion }, offlineSimulation: !!underlying.runWorldTurn,
      database: 'postgresql', modelRouter: config.mode === 'live' ? 'kaonrouter' : 'fixture' },
  };
}
