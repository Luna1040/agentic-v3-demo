import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { databaseSettings, loadLocalEnvironment, projectRoot, serverSettings } from '../server/config.ts';
import { createPool } from '../server/database.ts';
import { characterSeeds } from '../server/characters.ts';

loadLocalEnvironment();
const expected = JSON.parse(readFileSync(resolve(projectRoot, 'harness-runtime.lock.json'), 'utf8'));
const bridge = JSON.parse(readFileSync(resolve(projectRoot, '.harness-contract/build.json'), 'utf8'));
const runtime = JSON.parse(readFileSync(resolve(serverSettings().harnessPath, '../build.json'), 'utf8'));
for (const field of ['sourceCommit', 'appSourceHash']) {
  if (typeof expected[field] !== 'string' || expected[field] !== bridge[field] || expected[field] !== runtime[field]) {
    console.error('Harness version differs from the committed lock; deploy matching Harness artifacts first.');
    process.exit(1);
  }
}
const pool = createPool(databaseSettings().connectionString, { max: 1 });
try {
  // Validate existing migration bytes before stopping the live service. Git EOL
  // conversion must never silently change an already applied SQL checksum.
  const directory = resolve(projectRoot, 'server/migrations');
  const files = new Map(readdirSync(directory).filter(name => /^\d{3}_.+\.sql$/.test(name)).map(name => [Number(name.slice(0, 3)), name]));
  const applied = await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version');
  for (const migration of applied.rows) {
    const file = files.get(migration.version);
    if (!file) throw new Error(`Applied migration ${migration.version} is missing from the candidate.`);
    const hash = createHash('sha256').update(readFileSync(resolve(directory, file), 'utf8'));
    if (migration.version === 1) hash.update(JSON.stringify(characterSeeds));
    if (hash.digest('hex') !== migration.checksum) throw new Error(`Migration ${file} checksum differs from the database; candidate rejected before shutdown.`);
  }
  const result = (await pool.query(`SELECT
    (SELECT count(*)::int FROM turns WHERE status='running' AND lease_expires_at>clock_timestamp()) AS dialogue,
    (SELECT count(*)::int FROM world_settlements WHERE status='running' AND lease_expires_at>clock_timestamp()) AS settlement,
    (SELECT count(*)::int FROM world_directions WHERE status='running' AND lease_expires_at>clock_timestamp()) AS director`)).rows[0];
  console.log(JSON.stringify({ activeJobs: result }));
  if (Object.values(result).some(value => Number(value) > 0)) process.exitCode = 2;
} finally { await pool.end(); }
