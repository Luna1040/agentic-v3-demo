import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseLegacyAgents, importLegacyAgents } from '../scripts/import-legacy-agents.ts';
import { legacyAgentCatalog } from '../server/legacy-agents.ts';
import { postgresFixture } from './pg-helper.ts';

function archive(content = '你是旧版 Actor。\n保持角色一致性。') {
  const checksum = createHash('sha256').update(content).digest('hex');
  const encoded = content.replaceAll('\\','\\\\').replaceAll('\n','\\n').replaceAll('\t','\\t');
  return `COPY public.agent_definitions (id, key, name, responsibility, enabled, current_version_id) FROM stdin;
a1\tcharacter_actor\t角色演出\t角色职责\tt\tav1
\\.
COPY public.agent_versions (id, agent_definition_id, version, status, prompt_key) FROM stdin;
av1\ta1\t3\tpublished\tactor_prompt
\\.
COPY public.prompt_definitions (id, key) FROM stdin;
p1\tactor_prompt
\\.
COPY public.prompt_versions (id, prompt_definition_id, version, status, content, checksum, created_at) FROM stdin;
pv1\tp1\t2\tpublished\t${encoded}\t${checksum}\t2026-01-01
\\.
COPY public.prompt_deployments (id, environment, prompt_definition_id, prompt_version_id, active) FROM stdin;
pd1\tproduction\tp1\tpv1\tt
\\.
SELECT this_untrusted_sql_must_never_execute();`;
}
test('legacy catalog preserves prompt content and rejects tampered checksums', () => {
  const rows = parseLegacyAgents(archive(),1);
  assert.equal(rows[0].prompt,'你是旧版 Actor。\n保持角色一致性。');
  assert.equal(rows[0].currentVersion,3);
  assert.equal(rows[0].versions[0].version,2);
  assert.throws(() => parseLegacyAgents(archive().replace('保持角色一致性','篡改'),1),/checksum/);
  assert.throws(() => parseLegacyAgents(archive(),16),/count/);
});
test('legacy catalog imports once, stays read-only to app, and maps to executable agent', async () => {
  const db = await postgresFixture();
  try {
    const agents = parseLegacyAgents(archive(),1);
    assert.deepEqual(await importLegacyAgents(db.migrationPool,agents),{total:1,inserted:1,unchanged:0});
    assert.deepEqual(await importLegacyAgents(db.migrationPool,agents),{total:1,inserted:0,unchanged:1});
    const rows = await legacyAgentCatalog(db.store.pool);
    assert.deepEqual(rows[0].executionKeys,['actor']);
    assert.equal(rows[0].prompt,agents[0].prompt);
    await assert.rejects(db.store.pool.query("DELETE FROM legacy_agent_catalog"),/permission denied/);
    await assert.rejects(importLegacyAgents(db.migrationPool,parseLegacyAgents(archive('修改后的内容'),1)),/conflicts/);
    assert.equal((await legacyAgentCatalog(db.store.pool))[0].prompt,agents[0].prompt);
  } finally { await db.cleanup(); }
});
