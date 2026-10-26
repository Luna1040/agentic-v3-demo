import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadLocalEnvironment, databaseSettings, projectRoot } from '../server/config.ts';

loadLocalEnvironment();
const label = process.argv[2] || 'manual';
if (!/^[a-z0-9-]{1,60}$/.test(label)) throw new Error('Backup label must use lowercase letters, numbers and hyphens.');
const connection = new URL(databaseSettings().migrationConnectionString());
const directory = resolve(projectRoot,'.local/backups'); mkdirSync(directory,{recursive:true});
const file = resolve(directory,`${label}-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`);
const result = spawnSync(resolve(projectRoot,'.local/postgres/pgsql/bin/pg_dump.exe'), ['-Fc','--no-owner','--no-privileges','-f',file], {
  env:{...process.env,PGHOST:connection.hostname,PGPORT:connection.port,PGUSER:decodeURIComponent(connection.username),PGPASSWORD:decodeURIComponent(connection.password),PGDATABASE:decodeURIComponent(connection.pathname.slice(1))},
  encoding:'utf8',windowsHide:true,timeout:60_000,
});
if (result.error || result.status !== 0) { console.error('Database backup failed.'); process.exitCode=1; }
else console.log(JSON.stringify({file,bytes:statSync(file).size,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}));
