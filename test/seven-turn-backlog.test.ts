import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { postgresFixture } from './pg-helper.ts';
import type { ActorInput, StoryRuntime, WorldTurnResult } from '../server/runtime.ts';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Seven-turn background queue did not drain');
}

// Real HTTP, SSE, PostgreSQL and production worker. Only model output/latency is
// controlled here; this gate is never installed in the running application.
test('seven rapid completed replies remain usable while a held worker drains immutable FIFO batches', async () => {
  const db = await postgresFixture({ livingWorld: true });
  const held = gate(), started = gate();
  const itemId = randomUUID();
  const batches: string[][] = [];
  let actorCalls = 0;
  const runtime: StoryRuntime = {
    status: { provider: 'demo', model: 'controlled-fixture', harness: { loaded: true, version: 'seven-turn' }, offlineSimulation: true },
    metadata: { runtimeFingerprint: 'seven-turn' },
    actor: async () => { throw new Error('Unexpected legacy actor'); },
    updateWorld: async () => { throw new Error('Unexpected legacy updater'); },
    streamDialogue: async (input, options) => {
      actorCalls++;
      const text = `林晚把信封放到第${actorCalls}个格子。`;
      options.onTextDelta(text, { characterId: input.character.id, characterName: input.character.name });
      return { text, replies: [{ characterId: input.character.id, characterName: input.character.name, text }], changes: [], entityChanges: [], activities: [], observations: { [input.character.id]: input.userText }, scene: input.scene, usage: {} };
    },
    settleWorldTurn: async (input, dialogue) => (await settle([{ input, dialogue }]))[0],
    settleWorldBatch: async entries => settle(entries),
  };
  async function settle(entries: Array<{ input: ActorInput; dialogue: WorldTurnResult }>): Promise<WorldTurnResult[]> {
    batches.push(entries.map(entry => entry.input.turnId));
    if (batches.length === 1) { started.release(); await held.promise; }
    return entries.map(({ input, dialogue }) => {
      const step = Number(input.userText.match(/\d+/u)![0]);
      const item = input.worldContext!.entities.find(entity => entity.id === itemId)!;
      return { ...dialogue, scene: undefined, changes: [{ kind: 'fact', text: input.userText, characterId: 'lin-wan', visibility: 'private', evidence: { source: 'user', turnId: input.turnId } }],
        entityChanges: [{ op: 'update', baseVersion: item.version, entity: { id: itemId, kind: 'item', name: '信封', description: '连续交谈中的同一封信', state: { step } } }] };
    });
  }
  const app = createApp({ store: db.store, runtime, authenticate: () => 'alice', developer: { authorize: () => true, defaultPrompts: { actor: 'test', main: 'test', updater: 'test' }, buildRuntime: async () => runtime } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const session = await db.store.createSession('alice', 'lin-wan');
    await db.migrationPool.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids) VALUES('alice',$1,$2,'item','信封','连续交谈中的同一封信',$3,$4)", [session.world.id, itemId, { step: 0, nested: { keep: '此前已知信息' } }, ['lin-wan']]);
    await db.migrationPool.query("INSERT INTO world_entity_knowledge(owner_id,world_id,character_id,entity_id,version,snapshot,observed_at,source_turn_id) SELECT owner_id,world_id,'lin-wan',id,version,to_jsonb(e),clock_timestamp(),NULL FROM world_entities e WHERE world_id=$1 AND id=$2", [session.world.id, itemId]);
    const captureResponse = await fetch(`${base}/api/worlds/${session.world.id}/runtime-audit/capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedTurns: 7 }) });
    assert.equal(captureResponse.status, 201);
    const sourceIds: string[] = [];
    for (let step = 1; step <= 7; step++) {
      const response = await fetch(`${base}/api/sessions/${session.session.id}/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientTurnId: randomUUID(), content: `处理信封第${step}步` }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const events = (await response.text()).split('\n\n').filter(block => block.startsWith('event:')).map(block => JSON.parse(block.split('\ndata: ')[1]));
      assert(events.some(event => event.type === 'delta'));
      assert.equal(events.at(-1).type, 'committed');
      sourceIds.push(events.at(-1).turnId);
      if (step === 1) await started.promise;
    }
    const pending = await db.store.getWorld('alice', session.world.id);
    assert.equal(pending.settlementBacklog?.pendingTurns, 7);
    assert.equal(actorCalls, 7);
    assert.equal(batches.length, 1);
    held.release();
    try { await until(async () => (await db.store.getWorld('alice', session.world.id)).settlements?.filter(row => row.status === 'completed').length === 7); }
    catch (error) { throw new Error(JSON.stringify({ settlements: (await db.store.getWorld('alice', session.world.id)).settlements, batches }), { cause: error }); }
    assert.deepEqual(batches, [sourceIds.slice(0, 1), sourceIds.slice(1, 4), sourceIds.slice(4, 7)]);
    const world = await db.store.getWorld('alice', session.world.id);
    const item = world.entities!.find(entity => entity.id === itemId)!;
    assert.equal(item.state.step, 7); assert.equal(item.version, 8);
    assert.deepEqual(item.state.nested, { keep: '此前已知信息' });
    assert.equal(world.events.length, 7);
    assert.equal(world.settlementBacklog?.pendingTurns, 0);
    for (const sourceId of sourceIds) assert.equal((await db.store.getTurn('alice', sourceId)).assistantMessages?.length, 1);
    const auditResponse = await fetch(`${base}/api/worlds/${session.world.id}/runtime-audit`);
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.equal(audit.turns.length, 7);
    assert.equal(audit.events.filter((event: any) => event.kind === 'queued').length, 7);
    const committed = audit.events.filter((event: any) => event.kind === 'committed');
    assert.equal(committed.length, 7);
    assert.deepEqual(committed.map((event: any) => event.turnId), sourceIds);
    assert.deepEqual(committed.map((event: any) => event.data.entityChanges.find((change: any) => change.id === itemId).after.state.step), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(committed.map((event: any) => event.data.entityChanges.find((change: any) => change.id === itemId).before.version), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(audit.truncated, false);
    assert.equal(audit.world.entities.find((entity: any) => entity.id === itemId).state.step, 7);
  } finally {
    held.release(); await app.locals.shutdown(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await db.cleanup();
  }
});
