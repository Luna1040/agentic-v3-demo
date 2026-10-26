import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { databaseSettings, loadLocalEnvironment, projectRoot, serverSettings } from '../server/config.ts';
import { createPool } from '../server/database.ts';

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
  const result = (await pool.query(`SELECT
    (SELECT count(*)::int FROM turns WHERE status='running' AND lease_expires_at>clock_timestamp()) AS dialogue,
    (SELECT count(*)::int FROM world_settlements WHERE status='running' AND lease_expires_at>clock_timestamp()) AS settlement,
    (SELECT count(*)::int FROM world_directions WHERE status='running' AND lease_expires_at>clock_timestamp()) AS director`)).rows[0];
  console.log(JSON.stringify({ activeJobs: result }));
  if (Object.values(result).some(value => Number(value) > 0)) process.exitCode = 2;
} finally { await pool.end(); }
