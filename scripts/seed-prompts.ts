import { loadLocalEnvironment, databaseSettings } from '../server/config.ts';
import { createPool } from '../server/database.ts';
import { StoryStore } from '../server/store.ts';
import { loadRuntime } from '../server/load-runtime.ts';

loadLocalEnvironment();
const pool = createPool(databaseSettings().migrationConnectionString(), { max: 1 });
const store = new StoryStore(pool);
try {
  const runtime = await loadRuntime();
  if (!runtime.prompts) throw new Error('Harness prompt definitions missing.');
  await store.ensurePromptDefaults(runtime.prompts);
  console.log('Agent prompt defaults initialized; existing published versions preserved.');
} catch { console.error('Prompt 初始化失败，请先完成 Harness 构建和数据库迁移。'); process.exitCode = 1; }
finally { await store.close(); }
