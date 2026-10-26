import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.ts';
import { StoryStore } from './store.ts';
import { databaseSettings, loadLocalEnvironment, projectRoot, serverSettings } from './config.ts';
import { createPool } from './database.ts';
import { loadRuntime } from './load-runtime.ts';
import { promptSnapshot } from './developer.ts';

async function main() {
  loadLocalEnvironment();
  const settings = databaseSettings();
  const pool = createPool(settings.connectionString, { max: settings.max });
  const store = new StoryStore(pool, { livingWorld: true });
  let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
  try {
    // Internal capability bridge: source/world/actor are frozen by Harness, not model arguments.
    const readDialogue: NonNullable<Parameters<typeof loadRuntime>[0]>['readDialogue'] = request => store.readDialogueForSource(request);
    const runtime = await loadRuntime({readDialogue});
    // Startup checks the schema using the restricted application role; migrations are a separate command.
    await pool.query('SELECT id FROM characters LIMIT 1');
    const publishedPrompts = await store.getPrompts();
    if (!runtime.prompts || Object.keys(runtime.prompts).some(key => !publishedPrompts.some(row => row.key === key))) throw new Error('请先运行 db:seed-prompts 初始化 Agent Prompt。');
    const defaults = { ...runtime.prompts };
    const app = createApp({ store, runtime,
      resolveRuntime: async () => { const snapshot = await promptSnapshot(store, defaults); return loadRuntime({ prompts: snapshot.prompts, promptVersions: snapshot.versions, readDialogue }); },
      developer: { authorize: () => process.env.ENABLE_DEVELOPER_TOOLS !== 'false', defaultPrompts: defaults,
        buildRuntime: (prompts, promptVersions) => loadRuntime({ prompts, promptVersions, readDialogue }) },
    });
    app.get('/health/live', (_req, res) => res.json({ ok: true }));
    app.get('/health/ready', async (_req, res) => {
      try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'postgresql', harness: true }); }
      catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
    });
    const production = process.argv.includes('--production');
    if (production) {
      const dist = resolve(projectRoot, 'dist');
      if (!existsSync(resolve(dist, 'index.html'))) throw new Error('前端构建缺失');
      app.use(express.static(dist));
      app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
    } else {
      const { createServer } = await import('vite');
      vite = await createServer({ configFile: resolve(projectRoot, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
    }
    const { port } = serverSettings();
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((done, reject) => { server.once('listening', done); server.once('error', reject); });
    console.log('续章: http://127.0.0.1:' + port + ' (' + runtime.status.provider + '; PostgreSQL; ' + runtime.status.modelRouter + '; ' + runtime.status.model + ')');
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await app.locals.shutdown();
      server.closeAllConnections();
      await vite?.close();
      await store.close();
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) { await vite?.close(); await store.close(); throw error; }
}
main().catch((error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ' (' + code + ')' : '';
  console.error('启动失败' + safeCode + '。请检查后端配置、数据库连接，并运行 db:migrate、harness:build、build。');
  process.exitCode = 1;
});
