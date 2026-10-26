import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from '../server/database.ts';
import { databaseSettings, loadLocalEnvironment, projectRoot } from '../server/config.ts';

type CopyRow = Record<string, string | null>;
export interface LegacyCharacter {
  id: string; name: string; description: string; definition: string; greeting: string;
  thumbnailUrl: string | null; coverUrl: string | null; language: string;
  checksum: string; source: Record<string, unknown>;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function decode(value: string): string | null {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-f]{1,2}|.)/gi, (_match, code: string) => {
    const controls: Record<string,string> = { t:'\t', n:'\n', r:'\r', b:'\b', f:'\f', v:'\v', '\\':'\\' };
    return controls[code] ?? (/^[0-7]/.test(code) ? String.fromCharCode(parseInt(code,8)) : code[0] === 'x' ? String.fromCharCode(parseInt(code.slice(1),16)) : code);
  });
}
function json(row: CopyRow, key: string): Record<string, unknown> {
  const value: unknown = JSON.parse(row[key] ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Legacy JSON field is invalid.');
  return value as Record<string, unknown>;
}
/** Parses COPY text as data. No statement from the dump is ever sent to PostgreSQL. */
export function parseLegacyCharacterCopy(sql: string, expectedCount = 106): LegacyCharacter[] {
  const tables: Record<string, CopyRow[]> = { character_cards: [], character_card_versions: [] };
  let table: string | null = null; let columns: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const header = /^COPY public\.(character_cards|character_card_versions) \(([^)]+)\) FROM stdin;$/.exec(line);
    if (header) { if (table) throw new Error('Malformed COPY data.'); table = header[1]; columns = header[2].split(', '); continue; }
    if (line === '\\.') { table = null; continue; }
    if (!table) continue;
    const values = line.split('\t').map(decode);
    if (values.length !== columns.length) throw new Error('Legacy COPY column count mismatch.');
    tables[table].push(Object.fromEntries(columns.map((key, index) => [key, values[index]])));
  }
  if (table) throw new Error('Incomplete COPY section.');
  const cards = tables.character_cards; const versions = tables.character_card_versions;
  if (cards.length !== expectedCount || new Set(cards.map(card => card.id)).size !== cards.length || new Set(versions.map(version => version.id)).size !== versions.length) throw new Error('Legacy character count or uniqueness check failed.');
  for (const version of versions) {
    const snapshot = { definition: version.definition, description: version.description, initPrompt: version.init_prompt, welcomeMessage: version.welcome_message, preferredModelId: version.preferred_model_id, modelParameters: json(version, 'model_parameters') };
    if (hash(snapshot) !== version.checksum) throw new Error('Legacy character version checksum mismatch.');
  }
  return cards.map(card => {
    const allVersions = versions.filter(version => version.character_card_id === card.id);
    const current = allVersions.find(version => version.id === card.current_version_id);
    if (!current || current.status !== 'published') throw new Error('Legacy current published version is missing.');
    const stringField = (value: string | null, max: number) => {
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Legacy character field is empty or too large.');
      return value;
    };
    const media = (value: string | null) => {
      if (value === null) return null;
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Legacy media URL is invalid.');
      return value;
    };
    const sourceCard = { ...card, legacy_metadata: json(card,'legacy_metadata'), legacy_raw: json(card,'legacy_raw') };
    const sourceVersions = allVersions.map(version => ({ ...version, model_parameters: json(version,'model_parameters') }));
    const checksum = hash({ card: sourceCard, versions: sourceVersions });
    return {
      id: stringField(card.id,100), name: stringField(card.title,300), description: stringField(current.description,12000),
      definition: stringField(current.init_prompt,12000), greeting: stringField(current.welcome_message,12000),
      thumbnailUrl: media(card.thumbnail_url), coverUrl: media(card.cover_url), language: card.language || 'und', checksum,
      source: { format: 'agentic-v3-character-v1', checksum, currentVersionChecksum: current.checksum, card: sourceCard, versions: sourceVersions },
    };
  });
}
export function extractLegacyCharacters(dumpPath: string, restorePath?: string): LegacyCharacter[] {
  const bundled = resolve(projectRoot, '.local/postgres/pgsql/bin/pg_restore.exe');
  const executable = restorePath ?? process.env.PG_RESTORE_PATH ?? (existsSync(bundled) ? bundled : 'pg_restore');
  const result = spawnSync(executable, ['--data-only','--no-owner','--no-privileges','--schema=public','--table=character_cards','--table=character_card_versions','--file=-', resolve(dumpPath)], { encoding:'utf8', maxBuffer:16*1024*1024, timeout:30_000, windowsHide:true });
  if (result.error || result.status !== 0) throw new Error('Unable to extract the two character tables with pg_restore.');
  return parseLegacyCharacterCopy(result.stdout);
}
export async function importLegacyCharacters(pool: Pool, characters: LegacyCharacter[]) {
  const client = await pool.connect(); let inserted = 0; let unchanged = 0;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':legacy-character-import',0))");
    let order = Number((await client.query('SELECT COALESCE(max(sort_order),-1)+1 AS next FROM characters')).rows[0].next);
    for (const card of characters) {
      const existing = (await client.query('SELECT source_kind,source FROM characters WHERE id=$1', [card.id])).rows[0];
      if (existing) {
        if (existing.source_kind !== 'legacy' || existing.source.checksum !== card.checksum) throw new Error('Legacy import conflicts with an existing character; nothing was changed.');
        unchanged++; continue;
      }
      await client.query("INSERT INTO characters(id,name,subtitle,description,definition,initial,color,greeting,sort_order,thumbnail_url,cover_url,language,source_kind,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'legacy',$13)", [card.id,card.name,card.description.slice(0,72),card.description,card.definition,Array.from(card.name)[0],['sage','blue','peach'][order%3],card.greeting,order++,card.thumbnailUrl,card.coverUrl,card.language,card.source]);
      inserted++;
    }
    await client.query('COMMIT');
    return { total: characters.length, inserted, unchanged, sourcePreserved: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadLocalEnvironment();
  const dumpPath = resolve(process.argv[2] || resolve(projectRoot,'../agentic_v3_db.dump'));
  let pool: Pool | undefined;
  try {
    const characters = extractLegacyCharacters(dumpPath);
    // Hashing is local; neither original SQL nor connection credentials are printed.
    const archiveSha256 = createHash('sha256').update(readFileSync(dumpPath)).digest('hex');
    pool = createPool(databaseSettings().migrationConnectionString(), { max:1 });
    console.log(JSON.stringify({ ...await importLegacyCharacters(pool,characters), archiveSha256 }));
  } catch { console.error('旧角色卡导入失败，事务已回滚；请检查备份校验、002迁移和迁移账号。原备份未改动。'); process.exitCode = 1; }
  finally { await pool?.end(); }
}
