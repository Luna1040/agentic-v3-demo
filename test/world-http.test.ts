import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import type { StoryRuntime, ActorInput } from '../server/runtime.ts';
import type { AgentCallRecord, TurnEvent } from '../shared/contracts.ts';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';

test('world HTTP opening is durable and idempotent, streams real speaker identities, and keeps NPCs scoped', async () => {
  const db = await postgresFixture();
  const npcId = randomUUID();
  let executions = 0;
  const received: ActorInput[] = [];
  const runtime: StoryRuntime = {
    status: { provider: 'demo', model: 'test-only', harness: { loaded: true, version: 'test' }, offlineSimulation: true },
    actor: async () => ({ text: 'unused' }), updateWorld: async () => ({ changes: [] }),
    runWorldTurn: async (input, options) => {
      executions++; received.push(input);
      const opening = input.operation === 'opening';
      const speakers = opening ? [{ id: input.character.id, name: input.character.name }, { id: npcId, name: '岑雨' }] : [input.character];
      const replies = [];
      for (const speaker of speakers) {
        const callId = randomUUID();
        const text = speaker.id === npcId ? '岑雨收起湿伞：“我在修复隔壁的旧钟，想借一页防潮纸。”' : '“纸鹤我收下，但私下见面的提议我没有答应。”';
        const record: AgentCallRecord = { id: callId, parentId: null, attemptId: options.attemptId, agent: 'actor', status: 'running', model: 'test-only', startedAt: new Date().toISOString(), input: { character: speaker } };
        await options.onCall(record);
        options.onTextDelta(text, { characterId: speaker.id, characterName: speaker.name, messageId: callId });
        await options.onCall({ ...record, status: 'completed', completedAt: new Date().toISOString(), output: { text } });
        replies.push({ characterId: speaker.id, characterName: speaker.name, text, callId });
      }
      return { text: replies.map(reply => reply.text).join('\n\n'), replies, changes: [], activities: [], usage: {},
        scene: { location: '雨夜书店', presentCharacterIds: speakers.map(speaker => speaker.id), mode: 'ensemble' },
        entityChanges: opening ? [{ op: 'create', entity: { id: npcId, kind: 'npc', name: '岑雨', description: '在隔壁修复旧钟的邻居，因借防潮纸而来到书店。', state: { definition: '岑雨，认真寡言的钟表修复师。', greeting: '', origin: '修复旧钟时来借纸', initial: '岑', color: 'blue' } } }] : [],
      };
    },
  };
  const app = createApp({ store: db.store, runtime, authenticate: req => req.get('x-owner') || 'alice' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function request(path: string, method = 'GET', body?: unknown, owner = 'alice') {
    return fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-owner': owner }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function opening(sessionId: string) {
    const response = await request(`/sessions/${sessionId}/opening`, 'POST', { clientTurnId: 'caller-cannot-create-second-opening' });
    assert.equal(response.status, 200);
    return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as TurnEvent);
  }
  try {
    const created = await request('/sessions', 'POST', { characterId: 'lin-wan', dynamicOpening: true, scene: { location: '雨夜书店', presentCharacterIds: ['lin-wan'], mode: 'ensemble', situation: '一位来借纸的邻居敲门' } });
    assert.equal(created.status, 201);
    const initial = await created.json();
    assert.equal(initial.messages.length, 0, 'dynamic opening must not insert a static greeting first');
    const events = await opening(initial.session.id);
    const final = events.at(-1);
    assert.equal(final?.type, 'committed');
    if (final?.type !== 'committed') throw new Error(JSON.stringify(final));
    assert.equal(final.messages?.length, 2);
    assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.characterId), ['lin-wan', npcId]);
    assert.equal(final.world.entities?.filter(entity => entity.kind === 'npc' && entity.name === '岑雨').length, 1);
    const duplicate = (await opening(initial.session.id)).at(-1);
    assert.equal(duplicate?.type, 'committed');
    if (duplicate?.type !== 'committed') throw new Error('Expected replay');
    assert.deepEqual(duplicate.messages?.map(message => message.id), final.messages?.map(message => message.id));
    assert.equal(executions, 1, 'reopening the same scene cannot call models again');

    const focus = await request('/sessions', 'POST', { characterId: npcId, worldId: initial.world.id, dynamicOpening: true, scene: { location: '雨夜书店', presentCharacterIds: [npcId], mode: 'direct' }, expectedRevision: final.world.revision });
    assert.equal(focus.status, 201, 'a generated NPC is reusable as a later scene focus');
    const followup = await focus.json();
    assert.equal(followup.session.characterId, npcId);
    const preview = await db.store.previewInput('alice', followup.session.id, '记得刚才吗？');
    assert((await readPastDialogue(db.store,'alice',followup.session.id,npcId)).some(episode=>episode.replies.some(reply=>reply.text.includes('没有答应'))), 'witnessed NPC response survives another session with its speaker');
    assert.equal((await request(`/worlds/${initial.world.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await request('/sessions', 'POST', { characterId: npcId, dynamicOpening: true })).status, 404, 'generated identity cannot seed another world');
    const fresh = await (await request('/sessions', 'POST', { characterId: 'lin-wan', dynamicOpening: true })).json();
    assert(!fresh.world.entities?.some((entity: { id: string }) => entity.id === npcId));
    assert.equal(received[0].operation, 'opening');
  } finally {
    await app.locals.shutdown(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done())); await db.cleanup();
  }
});
