import { loadLocalEnvironment, databaseSettings } from '../server/config.ts';
import { createPool } from '../server/database.ts';
import { StoryStore } from '../server/store.ts';
import { loadRuntime } from '../server/load-runtime.ts';
import type { AgentKey } from '../shared/contracts.ts';

// Explicit operator action: append compatible prompts, preserve every old version.
loadLocalEnvironment();
const store = new StoryStore(createPool(databaseSettings().migrationConnectionString(), { max:1 }));
try {
  const runtime = await loadRuntime();
  if (!runtime.runWorldTurn || !runtime.prompts || Object.keys(runtime.prompts).length !== 6) throw new Error('Living world runtime missing.');
  const current = await store.getPrompts();
  for (const [key, content] of Object.entries(runtime.prompts)) {
    const previous = current.find(row => row.key === key);
    if (previous?.content === content) { console.log(`${key}: unchanged v${previous.version}`); continue; }
    await store.savePrompt(key as AgentKey, content, previous?.version ?? 0);
    console.log(`${key}: published v${(previous?.version ?? 0)+1}`);
  }
} catch { console.error('世界运行 Prompt 发布失败；请检查 Harness 构建与迁移，不要使用旧协议 Prompt 启动。'); process.exitCode=1; }
finally { await store.close(); }
