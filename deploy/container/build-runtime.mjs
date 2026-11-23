import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const provenance = JSON.parse(readFileSync('/build/provenance.json', 'utf8'));
if (process.env.APP_COMMIT !== provenance.app.sourceCommit || process.env.HARNESS_COMMIT !== provenance.harness.sourceCommit)
  throw new Error('Image revision arguments do not match the exported sources.');
const lock = JSON.parse(readFileSync('/app/harness-runtime.lock.json', 'utf8'));
const hash = createHash('sha256');
function hashSources(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) hashSources(resolve(directory, entry.name), relative + '/');
    else if (/\.(ts|json)$/.test(entry.name)) hash.update(relative).update('\0').update(readFileSync(resolve(directory, entry.name))).update('\0');
  }
}
hashSources('/runtime/apps/agentic-v3');
const appSourceHash = hash.digest('hex');
if (provenance.harness.sourceCommit !== lock.sourceCommit || appSourceHash !== lock.appSourceHash)
  throw new Error('Compiled Harness source does not match the host lock.');
const artifact = { sourceCommit: provenance.harness.sourceCommit, appSourceHash, workingTreeChanges: false, builtAt: new Date().toISOString() };
writeFileSync('/runtime/dist/apps/agentic-v3/build.json', JSON.stringify(artifact, null, 2) + '\n');
mkdirSync('/app/.harness-contract', { recursive: true });
for (const name of readdirSync('/runtime/dist/apps/agentic-v3')) {
  if (name.endsWith('.d.ts') || name === 'story-time.js')
    copyFileSync(resolve('/runtime/dist/apps/agentic-v3', name), resolve('/app/.harness-contract', name));
}
writeFileSync('/app/.harness-contract/build.json', JSON.stringify(artifact, null, 2) + '\n');
copyFileSync('/build/provenance.json', '/app/build-provenance.json');
console.log(JSON.stringify({ artifact, provenance: '/app/build-provenance.json' }));
