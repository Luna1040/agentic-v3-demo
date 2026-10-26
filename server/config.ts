import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadLocalEnvironment() {
  const path = resolve(projectRoot, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
function integer(value: string | undefined, fallback: number, name: string, min: number, max: number) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} 超出允许范围。`);
  return number;
}
function databaseUrl(value: unknown, label: string) {
  if (typeof value !== 'string' || !value) throw new Error(`缺少 ${label}，请先运行 npm run db:setup 或配置数据库连接。`);
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error();
  } catch { throw new Error(`${label} 必须是有效 PostgreSQL URL。`); }
  return value;
}
export function databaseSettings(env: NodeJS.ProcessEnv = process.env) {
  const path = resolve(projectRoot, env.LOCAL_PG_CONFIG_PATH || '.local/postgres/credentials.json');
  let local: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { local = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('本地 PostgreSQL 连接文件无效。'); }
  }
  return {
    connectionString: databaseUrl(env.DATABASE_URL || local.databaseUrl, 'DATABASE_URL'),
    migrationConnectionString: () => databaseUrl(env.MIGRATION_DATABASE_URL || local.migrationDatabaseUrl, 'MIGRATION_DATABASE_URL'),
    testConnectionString: () => databaseUrl(env.TEST_DATABASE_URL || local.testDatabaseUrl, 'TEST_DATABASE_URL'),
    testMigrationConnectionString: () => databaseUrl(env.TEST_MIGRATION_DATABASE_URL || local.testMigrationDatabaseUrl, 'TEST_MIGRATION_DATABASE_URL'),
    max: integer(env.DB_POOL_MAX, 10, 'DB_POOL_MAX', 1, 50),
  };
}
export function runtimeSettings(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.MODEL_MODE ?? 'live';
  if (mode !== 'live' && mode !== 'demo') throw new Error('MODEL_MODE 必须为 live 或 demo。');
  if (mode === 'live' && (!env.KAON_API_KEY?.trim() || !env.KAON_MODEL?.trim())) throw new Error('真实聊天需要 KAON_API_KEY 和 KAON_MODEL。');
  return {
    mode: mode as 'live' | 'demo',
    model: env.KAON_MODEL,
    mainModel: env.KAON_MAIN_MODEL || env.KAON_MODEL,
    updaterModel: env.KAON_UPDATER_MODEL || env.KAON_MODEL,
    baseUrl: env.KAON_BASE_URL || 'https://kaon-router.kaonai.com/v1',
    apiKey: env.KAON_API_KEY,
    timeoutMs: integer(env.KAON_TIMEOUT_MS, 90_000, 'KAON_TIMEOUT_MS', 1000, 180_000),
    delayMs: mode === 'demo' ? 12 : undefined,
  };
}
export function serverSettings(env: NodeJS.ProcessEnv = process.env) {
  return { port: integer(env.PORT, 7633, 'PORT', 1, 65535),
    harnessPath: env.HARNESS_MODULE_PATH || resolve(env.HARNESS_ROOT || resolve(projectRoot, '../../roleplay-harness'), 'dist/apps/agentic-v3/index.js') };
}
