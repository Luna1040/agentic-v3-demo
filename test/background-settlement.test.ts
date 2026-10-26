import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { postgresFixture } from './pg-helper.ts';
import type { ActorInput, StoryRuntime, WorldTurnResult } from '../server/runtime.ts';
import type { TurnEvent } from '../shared/contracts.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('Settlement did not reach expected state');
}
test('HTTP stream commits before settlement; next turn sees saved replies; failure/retry never regenerates dialogue', async () => {
  const db = await postgresFixture({ livingWorld: true });
  const held = gate(); const started = gate(); const secondActor = gate(); const secondStarted = gate();
  let actorCalls = 0, settleCalls = 0, injectFailure = true;
  const inputs: ActorInput[] = [];
  const runtime: StoryRuntime = {
    status: { provider: 'demo', model: 'fixture', harness: { loaded: true, version: 'split-test' }, offlineSimulation: true },
    metadata: { runtimeFingerprint: 'split-test' },
    actor: async () => { throw new Error('unexpected legacy actor'); }, updateWorld: async () => { throw new Error('unexpected legacy updater'); },
    runWorldTurn: async (input, options) => {
      assert.equal(options.deferWorldUpdate, true); inputs.push(input); actorCalls++;
      if (actorCalls === 2) { secondStarted.resolve(); await secondActor.promise; }
      const text = `林晚把第${actorCalls}张纸放在桌上。`;
      options.onTextDelta(text, { characterId: input.character.id, characterName: input.character.name });
      return { text, replies: [{ characterId: input.character.id, characterName: input.character.name, text }], changes: [], entityChanges: [], activities: [], observations: { [input.character.id]: input.userText }, scene: input.scene, usage: {} };
    },
    settleWorldTurn: async (input, dialogue) => {
      settleCalls++; started.resolve(); await held.promise;
      if (injectFailure) throw new Error('provider-key-must-not-leak');
      return { ...dialogue, scene: undefined, activities: [], changes: [{ kind: 'fact', text: input.userText, visibility: 'private', characterId: input.character.id, evidence: { source: 'user', turnId: input.turnId } }] } as WorldTurnResult;
    },
  };
  const app = createApp({ store: db.store, runtime, authenticate: () => 'alice' });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const session = await db.store.createSession('alice', 'lin-wan');
    const send = async (id: string) => {
      const response = await fetch(`${base}/api/sessions/${session.session.id}/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientTurnId: id, content: id }), signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      return (await response.text()).split('\n\n').filter(b => b.startsWith('event:')).map(b => JSON.parse(b.split('\ndata: ')[1]) as TurnEvent);
    };
    const first = await send('第一句');
    assert.equal(first.at(-1)?.type, 'committed');
    await started.promise; // WorldOps is still held; SSE already ended.
    const before = await db.store.getSession('alice', session.session.id);
    assert.equal(before.messages.filter(m => m.role === 'assistant').length, 2);
    const second = send('第二句'); await secondStarted.promise;
    assert.deepEqual(inputs[1].episodes,[]);
    assert((await db.store.readDialogue('alice',{worldId:inputs[1].world.id,sourceTurnId:inputs[1].turnId,characterId:inputs[1].character.id})).episodes.some(e=>e.replies.some(r=>r.text.includes('第1张纸'))));
    held.resolve();
    await until(async () => (await db.store.getWorld('alice', session.world.id)).settlements?.some(s => s.status === 'pending' || s.status === 'failed') ?? false);
    assert.equal((await db.store.getTurn('alice', first[0].turnId)).status, 'committed');
    secondActor.resolve(); assert.equal((await second).at(-1)?.type, 'committed');
    injectFailure = false;
    await db.store.retrySettlements('alice', session.world.id); app.locals.turns.settlement.wake();
    await until(async () => (await db.store.getWorld('alice', session.world.id)).events.length === 2);
    const after = await db.store.getSession('alice', session.session.id);
    assert.equal(actorCalls, 2); assert(settleCalls >= 3);
    assert.equal(after.messages.filter(m => m.role === 'assistant').length, 3);
    assert.equal(after.world.events.length, 2);
    assert(!JSON.stringify(after.world.settlements).includes('provider-key'));
    assert.equal((await send('第一句')).at(-1)?.type, 'committed'); assert.equal(actorCalls, 2);
  } finally {
    held.resolve(); secondActor.resolve(); await app.locals.shutdown(); server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r())); await db.cleanup();
  }
});
