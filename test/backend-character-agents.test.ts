import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { postgresFixture } from './pg-helper.ts';
import { importLegacyCharacters, parseLegacyCharacterCopy } from '../scripts/import-legacy-characters.ts';
import type { AgentCallRecord } from '../shared/contracts.ts';
import type { StoredTurn } from '../server/store.ts';

const defaults = { main:'主调度规则', actor:'角色回复规则', updater:'世界更新规则' };
function stable(value: any): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function legacyCopy() {
  const card = { id:'legacy-card',title:'旧角色',thumbnail_url:'https://example.com/avatar.webp',cover_url:null,language:'zh-CN',category_id:null,legacy_metadata:JSON.stringify({translation:{translatedFromCharacterCardId:'original'}}),legacy_raw:JSON.stringify({initPrompt:'完整设定\n保留制表符\t与反斜杠\\',customRecoveryField:'保留'}),current_version_id:'42',created_at:'2026-01-01',updated_at:'2026-01-02' };
  const snapshot = { definition:'完整设定\n保留制表符\t与反斜杠\\',description:'简短简介',initPrompt:'完整设定\n保留制表符\t与反斜杠\\',welcomeMessage:'欢迎\n来到这里',preferredModelId:'legacy/model',modelParameters:{temperature:0.7} };
  const version = { id:'42',character_card_id:card.id,version:'3',definition:snapshot.definition,description:snapshot.description,init_prompt:snapshot.initPrompt,welcome_message:snapshot.welcomeMessage,preferred_model_id:snapshot.preferredModelId,model_parameters:JSON.stringify(snapshot.modelParameters),checksum:createHash('sha256').update(stable(snapshot)).digest('hex'),status:'published',created_by:'legacy',created_at:'2026-01-02',published_by:'legacy',published_at:'2026-01-02' };
  const copy = (name: string, row: Record<string,string|null>) => `COPY public.${name} (${Object.keys(row).join(', ')}) FROM stdin;\n${Object.values(row).map(value => value === null ? '\\N' : value.replaceAll('\\','\\\\').replaceAll('\t','\\t').replaceAll('\n','\\n')).join('\t')}\n\\.\n`;
  return copy('character_cards',card)+copy('character_card_versions',version);
}
function call(turn: StoredTurn, agent: AgentCallRecord['agent']='main', id='call-1'): AgentCallRecord { return { id,parentId:null,attemptId:turn.attempt,agent,status:'running',model:'fake-model',startedAt:new Date().toISOString(),input:{question:'test'} }; }

test('legacy COPY import preserves recovery fields and exact persona, is idempotent, and never executes dump SQL', async () => {
  const f = await postgresFixture();
  try {
    const copy = legacyCopy(); const cards = parseLegacyCharacterCopy('DROP TABLE characters;\n'+copy,1);
    assert.throws(() => parseLegacyCharacterCopy(copy.replace('简短简介','改过的简介'),1), /checksum/);
    assert.deepEqual(await importLegacyCharacters(f.migrationPool,cards), {total:1,inserted:1,unchanged:0,sourcePreserved:true});
    assert.deepEqual(await importLegacyCharacters(f.migrationPool,cards), {total:1,inserted:0,unchanged:1,sourcePreserved:true});
    const catalog = await f.store.listCharacters(); assert.equal(catalog.length,4); assert.equal(catalog[0].source,'legacy'); assert.equal(catalog[0].thumbnailUrl,'https://example.com/avatar.webp');
    assert(!('definition' in catalog[0])); assert(!JSON.stringify(catalog).includes('customRecoveryField'));
    const saved = (await f.migrationPool.query('SELECT * FROM characters WHERE id=$1',[cards[0].id])).rows[0];
    assert.equal(saved.source.card.legacy_raw.customRecoveryField,'保留'); assert.equal(saved.source.versions[0].model_parameters.temperature,0.7);
    const session = await f.store.createSession('alice',cards[0].id); const input = await f.store.previewInput('alice',session.session.id,'你好');
    assert.equal(input.character.definition,cards[0].definition); assert.equal(input.character.greeting,cards[0].greeting);
    await assert.rejects(importLegacyCharacters(f.migrationPool,[{...cards[0],checksum:'changed'}]),/conflicts/);
    assert.equal((await f.migrationPool.query('SELECT count(*) FROM characters')).rows[0].count,'4');
  } finally { await f.cleanup(); }
});

test('scene is shared, revision-checked, blocked during turns, and preview writes no business rows', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const session = await store.createSession('alice','lin-wan'); assert.deepEqual(session.world.scene?.presentCharacterIds,['lin-wan']);
    const other = await store.createSession('alice','shen-yan',session.world.id); assert.equal(other.world.revision,1);
    assert.deepEqual((await store.getSession('alice',session.session.id)).world.scene?.presentCharacterIds,['lin-wan','shen-yan']);
    await assert.rejects(store.setScene('alice',session.world.id,0,{location:'海滩',presentCharacterIds:['lin-wan']}),{code:'WORLD_CHANGED'});
    const world = await store.setScene('alice',session.world.id,1,{location:'海滩',presentCharacterIds:['lin-wan','shen-yan']}); assert.equal(world.revision,2);
    const counts = async () => (await store.pool.query('SELECT (SELECT count(*) FROM worlds) AS worlds,(SELECT count(*) FROM sessions) AS sessions,(SELECT count(*) FROM turns) AS turns,(SELECT count(*) FROM messages) AS messages,(SELECT count(*) FROM events) AS events')).rows[0];
    const before = await counts(); const preview = await store.previewInput('alice',session.session.id,'只试跑'); assert.deepEqual(await counts(),before);
    assert.equal(preview.scene?.location,'海滩'); assert.equal(preview.availableCharacters?.length,2); assert(preview.availableCharacters?.every(character => Object.keys(character).sort().join(',')==='id,name'));
    const turn = await store.beginTurn('alice',session.session.id,'stable','正文');
    await assert.rejects(store.setScene('alice',session.world.id,2,{location:'图书馆',presentCharacterIds:['lin-wan']}),{code:'WORLD_BUSY'});
    await assert.rejects(store.createSession('alice','xu-zhiyao',session.world.id),{code:'WORLD_BUSY'});
    await store.commit(turn,'回复',[],{scene:{location:'图书馆',presentCharacterIds:['lin-wan','shen-yan']},usage:{main:{totalTokens:3},actor:{totalTokens:5},updater:{totalTokens:2}}});
    assert.equal((await store.getWorld('alice',session.world.id)).scene?.location,'图书馆');
    assert.deepEqual((await store.storedTurn('alice',turn.id)).usage,{main:{totalTokens:3},actor:{totalTokens:5},updater:{totalTokens:2}});
    await store.setScene('alice',session.world.id,3,{location:null,presentCharacterIds:['shen-yan']});
    await assert.rejects(store.previewInput('alice',session.session.id,'你好'),{code:'CHARACTER_NOT_PRESENT'});
    await assert.rejects(store.beginTurn('alice',session.session.id,'absent','你好'),{code:'CHARACTER_NOT_PRESENT'});
    await assert.rejects(store.setScene('bob',session.world.id,4,{location:null,presentCharacterIds:[]}),{code:'WORLD_NOT_FOUND'});
    await assert.rejects(store.setScene('alice',session.world.id,4,{location:null,presentCharacterIds:['shen-yan','shen-yan']}),{code:'SCENE_INVALID'});
    await assert.rejects(store.setScene('alice',session.world.id,4,{location:null,presentCharacterIds:['missing']}),{code:'CHARACTER_NOT_FOUND'});
  } finally { await f.cleanup(); }
});

test('scene commit rolls back with the reply when a database event constraint fails', async () => {
  const f = await postgresFixture();
  try {
    const session = await f.store.createSession('alice','lin-wan'); const turn = await f.store.beginTurn('alice',session.session.id,'one','正文');
    await f.migrationPool.query("ALTER TABLE events ADD CONSTRAINT fixture_event_rejection CHECK(text<>'正文')");
    await assert.rejects(f.store.commit(turn,'回复',[{kind:'fact',text:'正文',visibility:'private',characterId:'lin-wan',evidence:{source:'user',turnId:turn.id}}],{scene:{location:'不应提交',presentCharacterIds:['lin-wan']}}),{code:'23514'});
    const current = await f.store.getSession('alice',session.session.id); assert.equal(current.world.scene?.location,null); assert.equal(current.world.revision,0); assert.equal(current.messages.length,2);
  } finally { await f.cleanup(); }
});

test('full legacy-sized opening/persona and 8000-character input fit the budget; ongoing context retires the opening', async () => {
  const f = await postgresFixture();
  try {
    const definition = '设'.repeat(6535), greeting = '迎'.repeat(3575), description = '简'.repeat(937);
    await f.migrationPool.query("UPDATE characters SET definition=$1,greeting=$2,description=$3 WHERE id='lin-wan'",[definition,greeting,description]);
    const session = await f.store.createSession('alice','lin-wan');
    const userText = '用'.repeat(8000);
    const fresh = await f.store.previewInput('alice',session.session.id,userText);
    assert(JSON.stringify(fresh).length<=23000);
    assert.equal(fresh.userText,userText); assert.equal(fresh.character.definition,definition); assert.equal(fresh.character.greeting,greeting);
    assert.equal(session.messages[0].content,greeting, 'a fresh static world must retain the complete welcome');
    for (let index=0;index<8;index++) {
      const turn = await f.store.beginTurn('alice',session.session.id,`history-${index}`,`用户${index}`+'中'.repeat(496));
      await f.store.commit(turn,`回复${index}`+'文'.repeat(496),[{kind:'fact',text:'ignored summary',visibility:'public',characterId:'lin-wan',evidence:{source:'user',turnId:turn.id}}]);
    }
    const input = await f.store.previewInput('alice',session.session.id,userText);
    assert(JSON.stringify(input).length<=23000); assert.equal(input.userText,userText); assert.equal(input.character.definition,definition); assert.equal(input.character.greeting,'', 'after committed interactions, the initial welcome must not reset the scene');
    assert(input.history.every(message=>message.content!==greeting));
    assert.equal((await f.store.getSession('alice',session.session.id)).messages[0].content,greeting, 'retiring the opening from active context must not rewrite the archive');
    assert.equal(input.history.length%2,0); for (let index=0;index<input.history.length;index+=2) { assert.equal(input.history[index].role,'user'); assert.equal(input.history[index+1].role,'assistant'); }
    if (input.history.length) assert(input.history.at(-1)?.content.startsWith('回复7'));
    for (const event of input.world.events) assert.equal(event.text.length,499);
    await f.migrationPool.query("UPDATE characters SET definition=$1,greeting=$1,description=$1 WHERE id='lin-wan'",['大'.repeat(12000)]);
    await assert.rejects(f.store.previewInput('alice',session.session.id,'x'),{code:'INPUT_TOO_LARGE'});
  } finally { await f.cleanup(); }
});

test('real call records track phases, redact credentials, preserve terminals and isolate owners and attempts', async () => {
  const f = await postgresFixture(); const { store } = f;
  try {
    const session = await store.createSession('alice','lin-wan'); const turn = await store.beginTurn('alice',session.session.id,'stable','正文',{orchestration:'main-v1'});
    assert.equal(turn.phase,'planning'); const main = {...call(turn),input:{apiKey:'fake-private-key',messages:[{content:'原始输入'}]}};
    await store.saveCall(turn,main); await store.saveCall(turn,{...main,status:'completed',output:{updateWorld:true},completedAt:new Date().toISOString()});
    await assert.rejects(store.saveCall(turn,main),{code:'TRACE_ALREADY_COMPLETED'});
    const actor = call(turn,'actor','actor-1'); await store.saveCall(turn,actor); assert.equal((await store.getTurn('alice',turn.id)).phase,'responding');
    const trace = await store.getTrace('alice',turn.id); assert.equal(trace.calls.length,2); assert.equal((trace.calls[0].input as any).apiKey,'[REDACTED]');
    await assert.rejects(store.getTrace('bob',turn.id),{code:'TURN_NOT_FOUND'});
    await store.cancelTurn('alice',turn.id); const cancelled = await store.getTrace('alice',turn.id); assert.equal(cancelled.calls[0].status,'completed'); assert.equal(cancelled.calls[1].status,'cancelled');
    const retry = await store.beginTurn('alice',session.session.id,'stable','正文',{orchestration:'main-v1'});
    await assert.rejects(store.saveCall(turn,{...actor,status:'completed'}),{code:'TURN_LEASE_LOST'});
    await store.saveCall(retry,call(retry)); assert.equal((await store.getTrace('alice',turn.id)).calls.length,3);
    await store.finish(retry,'failed','FIXTURE','失败'); assert.equal((await store.getTrace('alice',turn.id)).calls.at(-1)?.status,'failed');
  } finally { await f.cleanup(); }
});

test('durable checkpoint survives an expired attempt while trace recovery closes abandoned calls', async () => {
  const f = await postgresFixture(); const peer = f.peer();
  try {
    const session = await f.store.createSession('alice','lin-wan'); const turn = await f.store.beginTurn('alice',session.session.id,'stable','正文');
    const checkpoint = {text:'完整正文',usage:{totalTokens:8},plan:{updateWorld:true},mainUsage:{totalTokens:3},mainCallId:'main',actorCallId:'actor'};
    await f.store.saveCheckpoint(turn,checkpoint); await f.store.saveCall(turn,call(turn,'updater','updater'));
    await f.store.pool.query("UPDATE turns SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[turn.id]);
    assert.equal((await peer.getTrace('alice',turn.id)).calls[0].status,'failed');
    const retry = await peer.beginTurn('alice',session.session.id,'stable','正文'); assert.deepEqual(retry.checkpoint,checkpoint); assert.equal(retry.draft,'完整正文');
    assert.deepEqual(retry.usage,{main:{totalTokens:3},actor:{totalTokens:8}});
    await assert.rejects(f.store.saveCheckpoint(turn,{...checkpoint,text:'迟到正文'}),{code:'TURN_LEASE_LOST'});
    await peer.commit(retry,retry.draft!,[],{usage:{updater:{totalTokens:2}}});
    assert.deepEqual((await peer.storedTurn('alice',turn.id)).usage,{main:{totalTokens:3},actor:{totalTokens:8},updater:{totalTokens:2}});
  } finally { await f.cleanup(); }
});

test('prompts seed only when requested; immutable versions and CAS prevent concurrent overwrites', async () => {
  const f = await postgresFixture(); const peer = f.peer();
  try {
    assert.deepEqual(await f.store.getPrompts(),[]);
    await Promise.all([f.store.ensurePromptDefaults(defaults),peer.ensurePromptDefaults(defaults)]);
    assert.equal((await f.store.getPrompts()).length,3);
    const outcomes = await Promise.allSettled([f.store.savePrompt('actor','修改一',1),peer.savePrompt('actor','修改二',1)]);
    assert.equal(outcomes.filter(outcome => outcome.status==='fulfilled').length,1);
    assert.equal((outcomes.find(outcome=>outcome.status==='rejected') as PromiseRejectedResult).reason.code,'PROMPT_VERSION_CONFLICT');
    const history = await f.store.listPromptVersions('actor'); assert.deepEqual(history.map(version=>version.version),[2,1]);
    await f.store.ensurePromptDefaults({...defaults,actor:'不应覆盖'}); assert.equal((await f.store.listPromptVersions('actor'))[0].content,history[0].content);
    await assert.rejects(f.store.pool.query("UPDATE agent_prompt_versions SET content='bad' WHERE agent_key='actor'"),{code:'42501'});
    await assert.rejects(f.migrationPool.query("DELETE FROM agent_prompt_versions WHERE agent_key='actor'"),{code:'55000'});
    await assert.rejects(f.store.savePrompt('actor','x'.repeat(12001),2),{code:'PROMPT_INVALID'});
  } finally { await f.cleanup(); }
});
