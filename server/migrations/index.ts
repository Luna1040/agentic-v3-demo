import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { characterSeeds } from '../characters.ts';

/** Run explicitly with a migration role. Application startup never performs DDL. */
export async function migrate(pool: Pool, options: { appRole?: string } = {}): Promise<void> {
  const sql = await readFile(new URL('./001_initial.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).update(JSON.stringify(characterSeeds)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':agentic-migrations',0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const previous = await client.query('SELECT checksum FROM schema_migrations WHERE version=1');
    if (previous.rows[0]) {
      if (previous.rows[0].checksum !== checksum) throw new Error('Migration 001 checksum mismatch; create a new migration instead of editing an applied migration.');
    } else {
      await client.query(sql);
      for (const [order, character] of characterSeeds.entries()) await client.query(
        'INSERT INTO characters(id,name,subtitle,description,initial,color,greeting,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [character.id, character.name, character.subtitle, character.description, character.initial, character.color, character.greeting, order],
      );
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)', [checksum]);
    }
    const nextSql = await readFile(new URL('./002_characters_scene_agents.sql', import.meta.url), 'utf8');
    const nextChecksum = createHash('sha256').update(nextSql).digest('hex');
    const next = await client.query('SELECT checksum FROM schema_migrations WHERE version=2');
    if (next.rows[0]) {
      if (next.rows[0].checksum !== nextChecksum) throw new Error('Migration 002 checksum mismatch; create a new migration instead of editing an applied migration.');
    } else {
      await client.query(nextSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(2,$1)', [nextChecksum]);
    }
    const memorySql = await readFile(new URL('./003_memory_evidence.sql', import.meta.url), 'utf8');
    const memoryChecksum = createHash('sha256').update(memorySql).digest('hex');
    const memory = await client.query('SELECT checksum FROM schema_migrations WHERE version=3');
    if (memory.rows[0]) {
      if (memory.rows[0].checksum !== memoryChecksum) throw new Error('Migration 003 checksum mismatch; create a new migration instead of editing an applied migration.');
    } else {
      await client.query(memorySql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(3,$1)', [memoryChecksum]);
    }
    const livingSql = await readFile(new URL('./004_living_world.sql', import.meta.url), 'utf8');
    const livingChecksum = createHash('sha256').update(livingSql).digest('hex');
    const living = await client.query('SELECT checksum FROM schema_migrations WHERE version=4');
    if (living.rows[0]) {
      if (living.rows[0].checksum !== livingChecksum) throw new Error('Migration 004 checksum mismatch; create a new migration instead of editing an applied migration.');
    } else {
      await client.query(livingSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(4,$1)', [livingChecksum]);
    }
    const catalogSql = await readFile(new URL('./005_agent_catalog.sql', import.meta.url), 'utf8');
    const catalogChecksum = createHash('sha256').update(catalogSql).digest('hex');
    const catalog = await client.query('SELECT checksum FROM schema_migrations WHERE version=5');
    if (catalog.rows[0]) {
      if (catalog.rows[0].checksum !== catalogChecksum) throw new Error('Migration 005 checksum mismatch.');
    } else {
      await client.query(catalogSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(5,$1)', [catalogChecksum]);
    }
    const observationsSql = await readFile(new URL('./006_episode_observations.sql', import.meta.url), 'utf8');
    const observationsChecksum = createHash('sha256').update(observationsSql).digest('hex');
    const observations = await client.query('SELECT checksum FROM schema_migrations WHERE version=6');
    if (observations.rows[0]) {
      if (observations.rows[0].checksum !== observationsChecksum) throw new Error('Migration 006 checksum mismatch.');
    } else {
      await client.query(observationsSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(6,$1)', [observationsChecksum]);
    }
    const temporalSql = await readFile(new URL('./007_story_time_entity_knowledge.sql', import.meta.url), 'utf8');
    const temporalChecksum = createHash('sha256').update(temporalSql).digest('hex');
    const temporal = await client.query('SELECT checksum FROM schema_migrations WHERE version=7');
    if (temporal.rows[0]) {
      if (temporal.rows[0].checksum !== temporalChecksum) throw new Error('Migration 007 checksum mismatch.');
    } else {
      await client.query(temporalSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(7,$1)', [temporalChecksum]);
    }
    const profileSql = await readFile(new URL('./008_player_profiles.sql', import.meta.url), 'utf8');
    const profileChecksum = createHash('sha256').update(profileSql).digest('hex');
    const profileMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=8');
    if (profileMigration.rows[0]) {
      if (profileMigration.rows[0].checksum !== profileChecksum) throw new Error('Migration 008 checksum mismatch.');
    } else {
      await client.query(profileSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(8,$1)', [profileChecksum]);
    }
    const messageNamesSql = await readFile(new URL('./009_message_player_name.sql', import.meta.url), 'utf8');
    const messageNamesChecksum = createHash('sha256').update(messageNamesSql).digest('hex');
    const messageNames = await client.query('SELECT checksum FROM schema_migrations WHERE version=9');
    if (messageNames.rows[0]) {
      if (messageNames.rows[0].checksum !== messageNamesChecksum) throw new Error('Migration 009 checksum mismatch.');
    } else {
      await client.query(messageNamesSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(9,$1)', [messageNamesChecksum]);
    }
    const settlementSql = await readFile(new URL('./010_world_settlements.sql', import.meta.url), 'utf8');
    const settlementChecksum = createHash('sha256').update(settlementSql).digest('hex');
    const settlementMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=10');
    if (settlementMigration.rows[0]) {
      if (settlementMigration.rows[0].checksum !== settlementChecksum) throw new Error('Migration 010 checksum mismatch.');
    } else {
      await client.query(settlementSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(10,$1)', [settlementChecksum]);
    }
    const evidenceSql = await readFile(new URL('./011_event_evidence_length.sql', import.meta.url), 'utf8');
    const evidenceChecksum = createHash('sha256').update(evidenceSql).digest('hex');
    const evidenceMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=11');
    if (evidenceMigration.rows[0]) {
      if (evidenceMigration.rows[0].checksum !== evidenceChecksum) throw new Error('Migration 011 checksum mismatch.');
    } else {
      await client.query(evidenceSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(11,$1)', [evidenceChecksum]);
    }
    const batchSql = await readFile(new URL('./012_settlement_batches.sql', import.meta.url), 'utf8');
    const batchChecksum = createHash('sha256').update(batchSql).digest('hex');
    const batchMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=12');
    if (batchMigration.rows[0]) {
      if (batchMigration.rows[0].checksum !== batchChecksum) throw new Error('Migration 012 checksum mismatch.');
    } else {
      await client.query(batchSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(12,$1)', [batchChecksum]);
    }
    const directorSql = await readFile(new URL('./013_background_director.sql', import.meta.url), 'utf8');
    const directorChecksum = createHash('sha256').update(directorSql).digest('hex');
    const directorMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=13');
    if (directorMigration.rows[0]) {
      if (directorMigration.rows[0].checksum !== directorChecksum) throw new Error('Migration 013 checksum mismatch.');
    } else {
      await client.query(directorSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(13,$1)', [directorChecksum]);
    }
    const snapshotSql = await readFile(new URL('./014_memory_snapshots_events.sql', import.meta.url), 'utf8');
    const snapshotChecksum = createHash('sha256').update(snapshotSql).digest('hex');
    const snapshotMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=14');
    if (snapshotMigration.rows[0]) {
      if(snapshotMigration.rows[0].checksum !== snapshotChecksum) throw new Error('Migration 014 checksum mismatch.');
    } else {
      await client.query(snapshotSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(14,$1)',[snapshotChecksum]);
    }
    const receiptSql = await readFile(new URL('./015_offline_receipt.sql', import.meta.url), 'utf8');
    const receiptChecksum = createHash('sha256').update(receiptSql).digest('hex');
    const receiptMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=15');
    if(receiptMigration.rows[0]) {
      if(receiptMigration.rows[0].checksum!==receiptChecksum)throw new Error('Migration 015 checksum mismatch.');
    } else {
      await client.query(receiptSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(15,$1)',[receiptChecksum]);
    }
    const runtimeHistorySql = await readFile(new URL('./016_turn_runtime_history.sql', import.meta.url), 'utf8');
    const runtimeHistoryChecksum = createHash('sha256').update(runtimeHistorySql).digest('hex');
    const runtimeHistoryMigration = await client.query('SELECT checksum FROM schema_migrations WHERE version=16');
    if(runtimeHistoryMigration.rows[0]) {
      if(runtimeHistoryMigration.rows[0].checksum!==runtimeHistoryChecksum)throw new Error('Migration 016 checksum mismatch.');
    } else {
      await client.query(runtimeHistorySql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(16,$1)',[runtimeHistoryChecksum]);
    }
    const auditSql=await readFile(new URL('./017_world_runtime_audit.sql',import.meta.url),'utf8');
    const auditChecksum=createHash('sha256').update(auditSql).digest('hex');
    const auditMigration=await client.query('SELECT checksum FROM schema_migrations WHERE version=17');
    if(auditMigration.rows[0]){
      if(auditMigration.rows[0].checksum!==auditChecksum)throw new Error('Migration 017 checksum mismatch.');
    }else{
      await client.query(auditSql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(17,$1)',[auditChecksum]);
    }
    if (options.appRole) {
      const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
      const schema = quote((await client.query('SELECT current_schema() AS name')).rows[0].name);
      const role = quote(options.appRole);
      await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON player_profiles,world_settlements,world_directions,world_memory_snapshots,world_story_events TO ${role}`);
      // Explicit revocation also repairs older default grants on these two tables.
      await client.query(`REVOKE ALL ON characters,schema_migrations,worlds,sessions,turns,messages,events FROM ${role}`);
      await client.query(`GRANT SELECT ON characters,schema_migrations TO ${role}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON worlds,sessions,turns,messages,events TO ${role}`);
      await client.query(`REVOKE ALL ON world_entities FROM ${role}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON world_entities TO ${role}`);
      await client.query(`REVOKE ALL ON world_entity_knowledge FROM ${role}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON world_entity_knowledge TO ${role}`);
      await client.query(`REVOKE ALL ON agent_calls,agent_prompt_versions FROM ${role}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON agent_calls TO ${role}`);
      await client.query(`GRANT SELECT,INSERT ON agent_prompt_versions TO ${role}`);
      await client.query(`REVOKE ALL ON legacy_agent_catalog FROM ${role}`);
      await client.query(`GRANT SELECT ON legacy_agent_catalog TO ${role}`);
      await client.query(`REVOKE ALL ON world_runtime_audit FROM ${role}`);
      await client.query(`GRANT SELECT,INSERT ON world_runtime_audit TO ${role}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
