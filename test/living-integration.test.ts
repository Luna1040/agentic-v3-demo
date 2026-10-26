import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import type { StoryRuntime } from '../server/runtime.ts';
import { createApiClient } from '../web/api.ts';
import type { TurnEvent } from '../shared/contracts.ts';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';

test('living world browser client → HTTP → PG → real Harness/Pi tool execution commits one scene message and attributed cross-session memory', async () => {
  const modulePath = process.env.HARNESS_MODULE_PATH || resolve(process.env.HARNESS_ROOT || '../../roleplay-harness','dist/apps/agentic-v3/index.js');
  const { createStoryRuntime } = await import(pathToFileURL(modulePath).href);
  const fixture = await postgresFixture({livingWorld:true});
  const harness = createStoryRuntime({mode:'demo',delayMs:0,readDialogue:(request:any)=>fixture.store.readDialogueForSource(request)});
  const runtime: StoryRuntime = { ...harness, status:{ provider:'demo',model:harness.status.model,harness:{loaded:true,version:harness.status.harnessVersion},offlineSimulation:true } };
  assert.equal(typeof runtime.runWorldTurn,'function');
  const app = createApp({store:fixture.store,runtime});
  const server = app.listen(0,'127.0.0.1');
  await new Promise<void>(done => server.once('listening',done));
  const api = createApiClient({baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`});
  try {
    const initial = await api.createSession({characterId:'lin-wan',dynamicOpening:true,scene:{location:'旧书店',presentCharacterIds:['lin-wan'],mode:'ensemble',situation:'入口有人值守。'}});
    const events: TurnEvent[] = [];
    await api.opening(initial.session.id,{clientTurnId:`opening:${initial.session.id}`},event => events.push(event));
    const opening = events.at(-1);
    const trace = opening && 'turnId' in opening ? await fixture.store.getTrace('local',opening.turnId) : undefined;
    assert.equal(opening?.type,'committed',JSON.stringify({terminal:opening,failures:trace?.calls.filter(call => call.error)}));
    if (opening?.type !== 'committed') throw new Error('Opening failed');
    assert.equal(opening.messages?.length,1);
    const npc = opening.world.entities?.find(entity => entity.kind === 'npc' && entity.id === 'lin-wan');
    assert(npc);
    const actor = trace!.calls.find(call => call.agent === 'actor');
    assert.equal(actor?.status,'completed');
    assert.equal(trace!.calls.filter(call => call.agent === 'actor').length,1);
    assert(!trace!.calls.some(call=>call.agent==='main'||call.agent==='opening'));
    // Dialogue commits first; the host schedules WorldOps as a separate durable
    // attempt, not as an unfinished child holding the foreground Main open.
    for (let n = 0; n < 100; n++) {
      const jobs = (await fixture.store.getWorld('local', initial.world.id)).settlements;
      if (jobs?.find(job => job.turnId === opening.turnId)?.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const settled = await fixture.store.getWorld('local', initial.world.id);
    assert.equal(settled.settlements?.find(job => job.turnId === opening.turnId)?.status, 'completed');
    const settledTrace = await fixture.store.getTrace('local', opening.turnId);
    const updater = settledTrace.calls.find(call => call.agent === 'updater');
    assert.equal(updater?.status, 'completed');
    assert.notEqual(updater?.attemptId, actor?.attemptId);
    assert(!settledTrace.calls.some(call => call.attemptId === updater?.attemptId && call.agent === 'actor'));
    assert.equal(Object.keys((actor?.input as any)?.worldContext?.actorInputs??{}).length,0);
    const next = await api.createSession({characterId:npc.id,worldId:initial.world.id,dynamicOpening:true,scene:{location:'旧书店',presentCharacterIds:[npc.id],mode:'direct'},expectedRevision:settled.revision});
    const packet = await fixture.store.previewInput('local',next.session.id,'刚才你说了什么？');
    assert((await readPastDialogue(fixture.store,'local',next.session.id,npc.id)).some(episode=>episode.replies.some(reply=>reply.characterId===npc.id)));
    await assert.rejects(api.createSession({characterId:'shen-yan',worldId:initial.world.id,dynamicOpening:false}),/只能选择这个世界/);
  } finally {
    await app.locals.shutdown(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done())); await fixture.cleanup();
  }
});
