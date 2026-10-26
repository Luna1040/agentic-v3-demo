import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { postgresFixture } from './pg-helper.ts';
import type { StoryRuntime } from '../server/runtime.ts';
import { createApiClient } from '../web/api.ts';
import type { TurnEvent } from '../shared/contracts.ts';

test('actual browser client → HTTP/SSE → PostgreSQL → Harness Agent/Pi preserves memory scope across sessions', async () => {
  const modulePath = process.env.HARNESS_MODULE_PATH || resolve(process.env.HARNESS_ROOT || '../../roleplay-harness', 'dist/apps/agentic-v3/index.js');
  const { createStoryRuntime } = await import(pathToFileURL(modulePath).href);
  const harness = createStoryRuntime({ mode: 'demo', delayMs: 0 });
  assert.equal(harness.status.execution, 'harness-agent/pi');
  const runtime: StoryRuntime = {
    actor: (input, options) => harness.actor(input, options),
    updateWorld: (input, options) => harness.updateWorld(input, options),
    runTurn: (input, options) => harness.runTurn(input, options),
    metadata: harness.metadata,
    status: { provider: 'demo', model: harness.status.model, harness: { loaded: true, version: harness.status.harnessVersion }, offlineSimulation: false },
  };
  const fixture = await postgresFixture();
  const app = createApp({ store: fixture.store, runtime });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const api = createApiClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` });
  async function turn(sessionId: string, text: string, key: string = crypto.randomUUID()) {
    const events: TurnEvent[] = [];
    await api.stream(sessionId, { clientTurnId: key, content: text }, event => events.push(event));
    const committed = events.at(-1);
    const failureTrace = committed && 'turnId' in committed && committed.type !== 'committed' ? await fixture.store.getTrace('local', committed.turnId) : undefined;
    assert.equal(committed?.type, 'committed', JSON.stringify({ terminal: committed, failures: failureTrace?.calls.filter(call => call.error).map(call => ({ agent:call.agent,error:call.error })) }));
    if (committed?.type !== 'committed') throw new Error('Missing terminal commit');
    return committed;
  }
  try {
    const initial = await api.bootstrap();
    const original = initial.sessions[0];
    const secret = '银色书签藏在旧钟里';
    const first = await turn(original.id, `秘密：${secret}`, 'stable-request');
    assert.equal(first.world.events[0].visibility, 'private');
    const trace = await fixture.store.getTrace('local', first.turnId);
    const main = trace.calls.find(call => call.agent === 'main');
    assert.equal(main?.status, 'completed');
    assert.equal(trace.calls.find(call => call.agent === 'actor')?.parentId, main?.id);
    assert.equal(trace.calls.find(call => call.agent === 'updater')?.parentId, main?.id);
    const replay = await turn(original.id, `秘密：${secret}`, 'stable-request');
    assert.equal(first.message.id, replay.message.id);
    assert.equal((await api.session(original.id)).messages.length, 3);

    const continued = await api.createSession({ characterId: original.characterId, worldId: original.worldId });
    const recalled = await turn(continued.session.id, '你还记得我告诉过你的秘密吗？');
    assert.match(recalled.message.content, new RegExp(secret));

    const other = await api.createSession({ characterId: 'shen-yan', worldId: original.worldId });
    const unknown = await turn(other.session.id, '你还记得我告诉过你的秘密吗？');
    assert.doesNotMatch(unknown.message.content, new RegExp(secret));

    const requestedPublic = await turn(original.id, '公开记录：我希望明天在广场读书');
    assert.equal(requestedPublic.world.events.at(-1)?.visibility, 'private');
    const notAutomaticallyShared = await turn(other.session.id, '你记得之前的事吗？');
    assert.doesNotMatch(notAutomaticallyShared.message.content, /广场读书/);
    // Only a trusted host fixture can establish public visibility; chat text cannot share memory.
    await fixture.store.pool.query("UPDATE events SET visibility='public' WHERE owner_id='local' AND world_id=$1 AND source_turn_id=$2", [original.worldId, requestedPublic.turnId]);
    const known = await turn(other.session.id, '你记得之前的事吗？');
    assert.match(known.message.content, /广场读书/);
    assert.doesNotMatch(known.message.content, new RegExp(secret));

    const independent = await api.createSession({ characterId: original.characterId });
    const fresh = await turn(independent.session.id, '你还记得我告诉过你的秘密吗？');
    assert.doesNotMatch(fresh.message.content, new RegExp(secret));
    assert.equal(fresh.world.events.length, 0);
  } finally {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await fixture.cleanup();
  }
});
