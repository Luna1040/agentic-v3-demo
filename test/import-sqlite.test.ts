import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { databaseSettings, projectRoot } from '../server/config.ts';
import { postgresFixture } from './pg-helper.ts';

test('SQLite import after scene migration seeds latest speaker and preserves later PG edits on rerun', async () => {
  const fixture = await postgresFixture();
  const directory = await mkdtemp(join(tmpdir(), 'agentic-sqlite-import-'));
  const source = join(directory, 'source.sqlite');
  const worldId = randomUUID();
  try {
    const sqlite = new DatabaseSync(source);
    try {
      sqlite.exec(`CREATE TABLE worlds(id,owner_id,title,revision,created_at);
        CREATE TABLE sessions(id,owner_id,world_id,character_id,title,created_at,updated_at);
        CREATE TABLE turns(id); CREATE TABLE messages(id); CREATE TABLE events(id);`);
      sqlite.prepare('INSERT INTO worlds VALUES(?,?,?,?,?)').run(worldId, 'alice', 'Imported story', 0, '2026-10-20T00:00:00Z');
      const insert = sqlite.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)');
      insert.run(randomUUID(), 'alice', worldId, 'lin-wan', 'Older', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
      insert.run(randomUUID(), 'alice', worldId, 'shen-yan', 'Latest', '2026-10-20T01:00:00Z', '2026-10-20T01:00:00Z');
    } finally { sqlite.close(); }
    const connection = new URL(databaseSettings().testMigrationConnectionString());
    connection.searchParams.set('options', `-c search_path=${fixture.schema}`);
    const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/import-sqlite.ts', source], {
      cwd: projectRoot, env: { ...process.env, MIGRATION_DATABASE_URL: connection.toString() }, windowsHide: true,
    });
    await run();
    const scene = async () => (await fixture.migrationPool.query('SELECT scene FROM worlds WHERE id=$1', [worldId])).rows[0].scene;
    assert.deepEqual(await scene(), { location: null, presentCharacterIds: ['shen-yan'] });
    await fixture.migrationPool.query("UPDATE worlds SET scene=jsonb_set(scene,'{location}','\"Edited after import\"'::jsonb) WHERE id=$1", [worldId]);
    await run();
    assert.deepEqual(await scene(), { location: 'Edited after import', presentCharacterIds: ['shen-yan'] });
    assert.equal((await fixture.migrationPool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 2);
  } finally { await fixture.cleanup(); await unlink(source); await rmdir(directory); }
});
