import { loadLocalEnvironment, databaseSettings } from '../server/config.ts';
import { createPool } from '../server/database.ts';
import { migrate } from '../server/migrations/index.ts';

loadLocalEnvironment();
const settings = databaseSettings();
const pool = createPool(settings.migrationConnectionString(), { max: 1 });
const appRole = decodeURIComponent(new URL(settings.connectionString).username);
try { await migrate(pool, { appRole }); console.log('PostgreSQL migrations applied.'); }
catch { console.error('数据库迁移失败，请核对迁移账号和数据库状态。'); process.exitCode = 1; }
finally { await pool.end(); }
