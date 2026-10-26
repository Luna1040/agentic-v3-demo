import { randomUUID } from 'node:crypto';
import { databaseSettings, loadLocalEnvironment } from '../server/config.ts';
import { createPool } from '../server/database.ts';
import { migrate } from '../server/migrations/index.ts';
import { StoryStore, type StoreOptions } from '../server/store.ts';

/** Real PostgreSQL, fake models, disposable schemas in the dedicated test database. */
export async function postgresFixture(options: StoreOptions = {}) {
  loadLocalEnvironment();
  const settings = databaseSettings();
  const appUrl = settings.testConnectionString();
  const migrationUrl = settings.testMigrationConnectionString();
  const testDb = new URL(appUrl); const migrateDb = new URL(migrationUrl); const production = new URL(settings.connectionString);
  if (testDb.pathname === production.pathname || migrateDb.pathname !== testDb.pathname || migrateDb.host !== testDb.host) {
    throw new Error('Tests require a dedicated database and matching test migration connection.');
  }
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(migrationUrl, { max: 2 });
  const migrationPool = createPool(migrationUrl, { schema, max: 2 });
  const stores: StoryStore[] = [];
  const peer = () => { const store = new StoryStore(createPool(appUrl, { schema, max: 5 }), options); stores.push(store); return store; };
  const cleanup = async () => {
    await Promise.allSettled(stores.map((store) => store.close()));
    await migrationPool.end();
    // schema comes solely from the generated UUID above, never user input or a production name.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const appRole = decodeURIComponent(testDb.username);
    await migrate(migrationPool, { appRole });
    return { store: peer(), peer, migrationPool, schema, appRole, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
/** Exercise on-demand retrieval through a real frozen turn, then cancel the probe. */
export async function readPastDialogue(store:StoryStore,ownerId:string,sessionId:string,characterId?:string,turnIds?:string[]) {
  const source=await store.beginTurn(ownerId,sessionId,randomUUID(),'读取过去原文');
  try {return (await store.readDialogue(ownerId,{worldId:source.worldId,sourceTurnId:source.id,characterId:characterId ?? source.input.character.id,...(turnIds?{turnIds}:{})})).episodes;}
  finally {await store.finish(source,'cancelled','TEST_READ_ONLY','只读测试结束。');}
}
