import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const privateMarkers = [
  '/dev/', '/trace', '/runtime-audit', 'prompt-drafts:v1',
  'agentic-v3-enabled-prompts', 'agentic-v3-runtime-prompts',
  'PROMPT DEVELOPMENT STUDIO', 'ACTUAL AGENT CALLS',
  'savePrompt', 'testAgent', 'agentCatalog', 'captureRuntimeAudit',
  'mainlinePlan', 'deferredCommands', 'defaultContent',
  'av-trace-', 'av-prompt-', 'av-audit-', 'sourceMappingURL',
];
export async function checkConsumerBuild(directory = resolve('dist')) {
  const root = resolve(directory);
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Consumer artifact contains a symlink: ' + relative(root, path));
      if (entry.isDirectory()) { await visit(path); continue; }
      const name = relative(root, path).replaceAll('\\', '/');
      if (!(name === 'index.html' || /^assets\/[\w.-]+\.(js|css|png|jpe?g|svg|webp|woff2?)$/.test(name))) throw new Error('Unexpected consumer artifact: ' + name);
      if (/\.(js|css|html)$/.test(name)) {
        const content = await readFile(path, 'utf8');
        const found = privateMarkers.find(marker => content.includes(marker));
        if (found) throw new Error('Private marker in consumer artifact ' + name + ': ' + found);
      }
      files.push(name);
    }
  }
  await visit(root);
  if (!files.includes('index.html') || !files.some(name => name.endsWith('.js'))) throw new Error('Consumer build is incomplete');
  return files;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await checkConsumerBuild(process.argv[2]);
  console.log(`Consumer artifact boundary passed (${files.length} files).`);
}
