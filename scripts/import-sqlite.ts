import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadLocalEnvironment, databaseSettings, projectRoot } from '../server/config.ts';
import { createPool } from '../server/database.ts';

// Import only this new demo's previous SQLite database. Never import the old V3 dump or overwrite PG rows.
loadLocalEnvironment();
const sourcePath = resolve(projectRoot, process.argv[2] || 'data/story.sqlite');
if (!existsSync(sourcePath)) throw new Error('SQLite source file not found.');
const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const pool = createPool(databaseSettings().migrationConnectionString(), { max: 1 });
const client = await pool.connect();
type Row = Record<string, any>;
const counts: Record<string, number> = {};
async function insert(table: string, columns: string[], values: unknown[]) {
  // Identifiers below are fixed by this script, never external input.
  const result = await client.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${values.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT(id) DO NOTHING`, values);
  counts[table] = (counts[table] || 0) + (result.rowCount || 0);
}
try {
  sqlite.exec('BEGIN');
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentic-v3-sqlite-import',0))");
  const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
  const worlds = rows('worlds'), sessions = rows('sessions'), turns = rows('turns');
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  for (const world of worlds) {
    // The old demo had no scene. Seed only a newly imported world's latest speaker;
    // never overwrite an existing PG scene when the import is repeated.
    const latestSession = sessions.filter(session => session.world_id === world.id)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || sessions.indexOf(b) - sessions.indexOf(a))[0];
    const rootSession = sessions.find(session => session.world_id === world.id);
    const imported: Row = { ...world, scene: { location: null, presentCharacterIds: latestSession ? [latestSession.character_id] : [] }, root_character_id: rootSession?.character_id ?? null };
    const columns = ['id', 'owner_id', 'title', 'revision', 'created_at', 'scene', 'root_character_id'];
    await insert('worlds', columns, columns.map(key => imported[key]));
  }
  for (const session of sessions) {
    // A world NPC is an instance of the imported template; never alter the global catalog.
    // Reruns preserve subsequent PG persona/knowledge changes in the existing instance.
    const entity = await client.query(`INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids)
      SELECT $1,$2,c.id,'npc',c.name,c.description,jsonb_build_object('definition',c.definition,'greeting',c.greeting,'initial',c.initial,'color',c.color,'origin','seed','rootCharacterId',w.root_character_id),ARRAY[c.id]
      FROM characters c JOIN worlds w ON w.id=$2 AND w.owner_id=$1 WHERE c.id=$3 ON CONFLICT(world_id,id) DO NOTHING`, [session.owner_id, session.world_id, session.character_id]);
    counts.world_entities = (counts.world_entities || 0) + (entity.rowCount || 0);
    const columns = ['id', 'owner_id', 'world_id', 'character_id', 'title', 'created_at', 'updated_at'];
    await insert('sessions', columns, columns.map(key => session[key]));
  }
  for (const turn of turns) {
    const session = sessionById.get(turn.session_id);
    if (!session) throw new Error('Source turn refers to missing session.');
    const input = JSON.parse(turn.input_json);
    const imported: Row = { ...turn, character_id: session.character_id,
      status: turn.status === 'running' ? 'failed' : turn.status,
      input_json: input, runtime_metadata: { importedFrom: 'sqlite-v1' }, usage: {},
      episode_scene: input.scene ?? { location: null, presentCharacterIds: [session.character_id] }, episode_participant_ids: [session.character_id],
      lease_expires_at: new Date(0),
      error_code: turn.status === 'running' ? 'RUN_INTERRUPTED' : turn.error_code,
      error_message: turn.status === 'running' ? '本轮在数据库迁移前中断，请作为新消息发送。' : turn.error_message };
    const columns = ['id','owner_id','world_id','session_id','character_id','client_turn_id','content_hash','status','phase','base_revision','input_json','runtime_metadata','usage','actor_draft','attempt','lease_expires_at','error_code','error_message','created_at','updated_at','episode_scene','episode_participant_ids'];
    await insert('turns', columns, columns.map(key => imported[key]));
  }
  for (const message of rows('messages')) {
    const session = sessionById.get(message.session_id);
    if (!session) throw new Error('Source message refers to missing session.');
    const entity = message.role === 'assistant' ? (await client.query('SELECT name FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3', [session.owner_id, session.world_id, session.character_id])).rows[0] : null;
    const imported: Row = { ...message, world_id: session.world_id, character_id: entity ? session.character_id : null, character_name: entity?.name ?? null };
    const columns = ['id','owner_id','world_id','session_id','turn_id','role','content','created_at','character_id','character_name'];
    await insert('messages', columns, columns.map(key => imported[key]));
  }
  for (const event of rows('events')) {
    const columns = ['id','owner_id','world_id','kind','text','visibility','character_id','source_turn_id','created_at'];
    await insert('events', columns, columns.map(key => event[key]));
  }
  await client.query('COMMIT');
  sqlite.exec('COMMIT');
  console.log(JSON.stringify({ imported: counts, sourcePreserved: true }));
} catch {
  await client.query('ROLLBACK');
  try { sqlite.exec('ROLLBACK'); } catch { /* Read transaction may already be closed. */ }
  console.error('SQLite导入失败，PG事务已回滚，原文件未改动。请检查迁移结构与源数据一致性。');
  process.exitCode = 1;
} finally { sqlite.close(); client.release(); await pool.end(); }
