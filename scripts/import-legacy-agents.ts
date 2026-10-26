import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from '../server/database.ts';
import { databaseSettings, loadLocalEnvironment, projectRoot } from '../server/config.ts';

type Row = Record<string, string | null>;
const tableNames = ['agent_definitions', 'agent_versions', 'prompt_definitions', 'prompt_versions', 'prompt_deployments'];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function decode(value: string): string | null {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-f]{1,2}|.)/gi, (_match, code: string) => {
    const controls: Record<string,string> = { t:'\t', n:'\n', r:'\r', b:'\b', f:'\f', v:'\v', '\\':'\\' };
    return controls[code] ?? (/^[0-7]/.test(code) ? String.fromCharCode(parseInt(code,8)) : code[0] === 'x' ? String.fromCharCode(parseInt(code.slice(1),16)) : code);
  });
}
/** Decode COPY data only. Never execute SQL from the original archive. */
export function parseLegacyAgents(sql: string, expectedCount = 16) {
  const tables = Object.fromEntries(tableNames.map(name => [name, [] as Row[]]));
  let active: string | undefined; let columns: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const header = /^COPY public\.(\w+) \(([^)]+)\) FROM stdin;$/.exec(line);
    if (header) {
      if (active || !tableNames.includes(header[1])) throw new Error('Unexpected COPY section.');
      active = header[1]; columns = header[2].split(', '); continue;
    }
    if (line === '\\.') { active = undefined; continue; }
    if (!active) continue;
    const values = line.split('\t').map(decode);
    if (values.length !== columns.length) throw new Error('COPY column mismatch.');
    tables[active].push(Object.fromEntries(columns.map((name, i) => [name, values[i]])));
  }
  if (active || tables.agent_definitions.length !== expectedCount || new Set(tables.agent_definitions.map(row => row.key)).size !== expectedCount) throw new Error('Agent catalog count mismatch.');
  for (const row of tables.prompt_versions) if (!row.content || digest(row.content) !== row.checksum) throw new Error('Legacy prompt checksum mismatch.');
  return tables.agent_definitions.map(definition => {
    const versions = tables.agent_versions.filter(row => row.agent_definition_id === definition.id);
    const current = versions.find(row => row.id === definition.current_version_id);
    if (!current || current.status !== 'published') throw new Error('Published agent version missing.');
    const promptDefinition = tables.prompt_definitions.find(row => row.key === current.prompt_key);
    if (!promptDefinition) throw new Error('Prompt definition missing.');
    const promptVersions = tables.prompt_versions.filter(row => row.prompt_definition_id === promptDefinition.id).sort((a,b) => Number(b.version)-Number(a.version));
    const deployments = tables.prompt_deployments.filter(row => row.prompt_definition_id === promptDefinition.id && row.active === 't');
    const deployment = deployments.find(row => row.environment === 'production') ?? deployments.find(row => row.environment === 'development') ?? deployments[0];
    const prompt = deployment ? promptVersions.find(row => row.id === deployment.prompt_version_id) : promptVersions.find(row => row.status === 'published');
    if (!prompt?.content) throw new Error('Published prompt missing.');
    const source = { definition, versions, promptDefinition, promptVersions, deployments };
    return { key: definition.key!, name: definition.name!, responsibility: definition.responsibility!, enabled: definition.enabled === 't',
      currentVersion: Number(current.version), prompt: prompt.content,
      versions: promptVersions.map(row => ({ version:Number(row.version),status:row.status,prompt:row.content,createdAt:row.created_at })),
      source, checksum:digest(JSON.stringify(source)),
    };
  });
}
export function extractLegacyAgents(dumpPath: string) {
  const executable = process.env.PG_RESTORE_PATH || resolve(projectRoot,'.local/postgres/pgsql/bin/pg_restore.exe');
  const result = spawnSync(executable, ['--data-only','--no-owner','--no-privileges','--schema=public',...tableNames.map(name => `--table=${name}`),'--file=-',resolve(dumpPath)], { encoding:'utf8', maxBuffer:16*1024*1024, timeout:30_000, windowsHide:true });
  if (result.error || result.status !== 0) throw new Error('Cannot read archived agent tables.');
  return parseLegacyAgents(result.stdout);
}
export async function importLegacyAgents(pool: Pool, agents: ReturnType<typeof parseLegacyAgents>) {
  const client = await pool.connect(); let inserted = 0; let unchanged = 0;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':legacy-agent-import',0))");
    for (const agent of agents) {
      const previous = (await client.query('SELECT checksum FROM legacy_agent_catalog WHERE key=$1',[agent.key])).rows[0];
      if (previous) { if (previous.checksum !== agent.checksum) throw new Error('Archive conflicts with an existing catalog.'); unchanged++; continue; }
      await client.query('INSERT INTO legacy_agent_catalog(key,name,responsibility,enabled,current_version,prompt,versions,source,checksum) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [agent.key,agent.name,agent.responsibility,agent.enabled,agent.currentVersion,agent.prompt,JSON.stringify(agent.versions),JSON.stringify(agent.source),agent.checksum]);
      inserted++;
    }
    await client.query('COMMIT'); return { total:agents.length,inserted,unchanged };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadLocalEnvironment();
  const pool = createPool(databaseSettings().migrationConnectionString(),{max:1});
  try { console.log(JSON.stringify(await importLegacyAgents(pool,extractLegacyAgents(process.argv[2] || resolve(projectRoot,'../agentic_v3_db.dump'))))); }
  catch { console.error('Agent 目录导入失败，事务已回滚；请检查 005 迁移、备份校验和迁移账户。'); process.exitCode=1; }
  finally { await pool.end(); }
}
