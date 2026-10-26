import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const harnessRoot = resolve(process.env.HARNESS_ROOT || resolve(projectRoot, '../../roleplay-harness'));
const tsc = resolve(harnessRoot, 'node_modules/typescript/bin/tsc');
if (!existsSync(tsc)) {
  console.error(`请先在 ${harnessRoot} 执行 npm ci。`);
  process.exit(1);
}
// An unsuccessful build must never leave a valid identity beside stale or partial output.
const buildPath = resolve(harnessRoot, 'dist/apps/agentic-v3/build.json');
rmSync(buildPath, { force: true });
const result = spawnSync(process.execPath, [tsc, '-p', 'apps/agentic-v3/tsconfig.json', '--noEmitOnError'], {
  cwd: harnessRoot, stdio: 'inherit', shell: false,
});
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, encoding: 'utf8', shell: false });
if (revision.status !== 0 || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) {
  console.error('无法确定 Harness 源码提交，构建身份未生成。');
  process.exit(1);
}
const appDir = resolve(harnessRoot, 'apps/agentic-v3');
const hash = createHash('sha256');
function hashSources(directory, prefix = '') {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + item.name;
    if (item.isDirectory()) hashSources(resolve(directory, item.name), relative + '/');
    else if (/\.(ts|json)$/.test(item.name)) hash.update(relative).update('\0').update(readFileSync(resolve(directory, item.name))).update('\0');
  }
}
hashSources(appDir);
const dirty = spawnSync('git', ['status', '--porcelain', '--', 'apps/agentic-v3', 'packages/sdk', 'packages/llm'], { cwd: harnessRoot, encoding: 'utf8', shell: false });
const artifact = { sourceCommit: revision.stdout.trim(), appSourceHash: hash.digest('hex'), workingTreeChanges: Boolean(dirty.stdout.trim()), builtAt: new Date().toISOString() };
writeFileSync(buildPath, JSON.stringify(artifact, null, 2) + '\n');
// Application-private build artifact. Types and pure time rules have one source
// in Harness; the host never maintains a second handwritten implementation.
const contractDir = resolve(projectRoot, '.harness-contract');
mkdirSync(contractDir, { recursive: true });
for (const name of readdirSync(resolve(harnessRoot, 'dist/apps/agentic-v3'))) {
  if (name.endsWith('.d.ts') || name === 'story-time.js')
    copyFileSync(resolve(harnessRoot, 'dist/apps/agentic-v3', name), resolve(contractDir, name));
}
writeFileSync(resolve(contractDir, 'build.json'), JSON.stringify(artifact, null, 2) + '\n');
