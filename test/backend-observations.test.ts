import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';
import type { ActorInput } from '../server/runtime.ts';
import { observationText, validObservation } from '../server/observations.ts';

const actorPacket = (input: ActorInput, id = 'lin-wan') => input.worldContext!.actorInputs[id];

test('observation fragments must be exact, ordered, nonoverlapping and bounded', () => {
  const source = '点头。（心里想密码是 0837。）我说：明早见。';
  const parts = ['点头。', '我说：明早见。'];
  assert(validObservation(parts, source)); assert.equal(observationText(parts), '点头。\n我说：明早见。');
  assert(validObservation('', source)); assert(validObservation(source, source));
  for (const value of [parts.join('\n'), [...parts].reverse(), [parts[0], parts[0]], [], [''], [' '], ['改写了原文'], Array(9).fill('点')]) assert.equal(validObservation(value, source), false);
  assert.equal(validObservation(['abcd', 'cdef'], 'abcdef'), false);
  assert.equal(validObservation(['a'.repeat(4000), 'b'.repeat(4000)], 'a'.repeat(4000) + 'b'.repeat(4000)), false, 'joining separator counts against the limit');
});
async function sceneFixture() {
  const f = await postgresFixture({ livingWorld: true });
  const session = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true });
  const opening = await f.store.beginTurn('alice', session.session.id, `opening:${session.session.id}`, '开场', {}, { operation: 'opening' });
  const other = randomUUID(), place = randomUUID();
  await f.store.commit(opening, '林晚翻开登记本。', [], {
    scene: { location: '钟楼值班室', presentCharacterIds: ['lin-wan', other], mode: 'ensemble', playerPresent: true },
    observations: { 'lin-wan': '', [other]: '' },
    entityChanges: [
      { op: 'create', entity: { id: other, kind: 'npc', name: '程叶', description: '在另一张桌上整理名册的人。' } },
      { op: 'create', entity: { id: place, kind: 'location', name: '钟楼值班室', description: '有两个桌子。' } },
    ],
  });
  return { ...f, session: session.session, other, place };
}

test('per-NPC observations persist through episodes and active memory without exposing private narration', async () => {
  const f = await sceneFixture();
  try {
    const spoken = '明天六点半在门口见。';
    const secret = '心里想着保险箱密码是 0837';
    const content = `我靠近林晚小声说：“${spoken}”（${secret}，没有说出口。）`;
    const turn = await f.store.beginTurn('alice', f.session.id, 'mixed', content);
    assert.equal(turn.input.userText, content, 'Main still adjudicates the complete player input');
    assert.equal(actorPacket(turn.input).userText, '');
    assert.equal(actorPacket(turn.input, f.other).userText, '');
    const item = randomUUID();
    const saved = await f.store.commit(turn, '林晚点头，把铜钥匙放进自己的抽屉。', [
      { kind: 'event', text: content, visibility: 'private', characterId: 'lin-wan', evidence: { source: 'user', turnId: turn.id } },
    ], { observations: { 'lin-wan': spoken, [f.other]: '' }, scene: { ...turn.input.scene!, situation: secret }, entityChanges: [
      { op: 'create', entity: { id: item, kind: 'item', name: '铜钥匙', description: '由林晚保管在抽屉内。', state: { holderCharacterId: 'lin-wan', status: '收在抽屉中' }, knownByCharacterIds: ['lin-wan'] } },
    ] });
    assert.equal(saved.world.events[0].text, spoken);
    assert.equal(saved.world.scene!.situation, undefined, 'shared scene prose cannot bypass partial observations');
    const next = await f.store.previewInput('alice', f.session.id, '嗯。');
    const own = actorPacket(next), other = actorPacket(next, f.other);
    const read=await readPastDialogue(f.store,'alice',f.session.id,'lin-wan',[turn.id]);
    assert(read.some(row=>row.turnId===turn.id && row.userText===spoken));
    assert.deepEqual(own.world.events,[]); assert(!JSON.stringify(read).includes(secret));
    assert(!JSON.stringify(own).includes(secret)); assert(!JSON.stringify(other).includes(secret));
    assert(!JSON.stringify(other).includes(spoken));
    assert(!own.episodes!.some(row => 'observations' in row));
    assert(!other.worldContext!.entities.some(row => row.id === item));
    const archive = await f.store.getWorld('alice', f.session.worldId);
    assert.equal(archive.episodes!.find(row => row.turnId === turn.id)!.userText, content);
    assert.equal(archive.episodes!.find(row => row.turnId === turn.id)!.observations?.['lin-wan'], spoken);
    assert.equal(archive.episodes!.find(row => row.turnId === turn.id)!.scene.situation, undefined);
    const detail = await f.store.getSession('alice', f.session.id);
    assert(detail.messages.some(row => row.content === content));
  } finally { await f.cleanup(); }
});

test('absent player and departed NPC receive no new observation and no departed-scene episode', async () => {
  const f = await sceneFixture();
  try {
    const privateAction = '回家后我把闹钟设成 06:10，关灯睡下。';
    const turn = await f.store.beginTurn('alice', f.session.id, 'leave', privateAction);
    const scene = { location: '钟楼值班室', presentCharacterIds: ['lin-wan'], mode: 'ensemble' as const, playerPresent: false, situation: '林晚继续整理值班记录。' };
    await assert.rejects(f.store.commit(turn, '林晚合上登记本。', [], { scene, observations: { 'lin-wan': privateAction } }), { code: 'OBSERVATION_INVALID' });
    await f.store.commit(turn, '林晚合上登记本，去检查门锁。', [], { scene, observations: { 'lin-wan': '' } });
    const next = await f.store.previewInput('alice', f.session.id, '我推开门回来了。');
    assert.equal(next.scene!.playerPresent, false);
    assert.equal(next.userText, '我推开门回来了。', 'Main can detect an actual return');
    assert.equal(actorPacket(next).userText, '');
    assert(!JSON.stringify(actorPacket(next)).includes('06:10'));
    assert(!actorPacket(next, f.other).episodes!.some(row => row.turnId === turn.id));
    assert.equal((await f.store.getSession('alice', f.session.id)).world.scene!.playerPresent, false);
    const resumed = await f.store.createSession('alice', 'lin-wan', f.session.worldId, { dynamicOpening: true });
    assert.equal(resumed.world.scene!.playerPresent, false, 'opening a session alone does not physically return the player');
  } finally { await f.cleanup(); }
});

test('legacy unpartitioned living narration is retained in the archive but not silently granted to actors', async () => {
  const f = await sceneFixture();
  try {
    const secret = '我的私人暗号是夜雨。';
    const turn = await f.store.beginTurn('alice', f.session.id, 'legacy', secret);
    await f.store.commit(turn, '林晚继续整理名册。', [], { observations: { 'lin-wan': '', [f.other]: '' } });
    await f.store.pool.query('UPDATE turns SET episode_observations=NULL WHERE id=$1', [turn.id]);
    const next = await f.store.previewInput('alice', f.session.id, '继续。');
    assert(!JSON.stringify(actorPacket(next)).includes('夜雨'));
    assert((await f.store.getWorld('alice', f.session.worldId)).episodes!.some(row => row.userText === secret));
  } finally { await f.cleanup(); }
});

test('confirmed state survives the recent window while a fresh session recalls its related source', async () => {
  const f = await sceneFixture();
  try {
    const item = randomUUID(), quest = randomUUID();
    const turn = await f.store.beginTurn('alice', f.session.id, 'plan', '好，明天六点半见。');
    await f.store.commit(turn, '林晚将铜钥匙锁进抽屉：“明天六点半在门口等你。”', [], {
      observations: { 'lin-wan': turn.input.userText, [f.other]: '' },
      entityChanges: [
        { op: 'create', entity: { id: item, kind: 'item', name: '铜钥匙', description: '已经由林晚收妥，不能回到桌上重收。', state: { holderCharacterId: 'lin-wan', locationId: f.place, status: '锁在抽屉里' }, knownByCharacterIds: ['lin-wan'] } },
        { op: 'create', entity: { id: quest, kind: 'quest', name: '门口会面', description: '双方已接受明天六点半在门口会面。', state: { status: 'active', ownerCharacterId: 'lin-wan' }, knownByCharacterIds: ['lin-wan'] } },
      ],
    });
    for (let i = 0; i < 10; i++) {
      const next = await f.store.beginTurn('alice', f.session.id, `later-${i}`, `今天第${i + 1}页也看完了。`);
      await f.store.commit(next, `林晚检查第${i + 1}页的记录并继续下一页。`, [], { observations: { 'lin-wan': next.input.userText, [f.other]: '' } });
    }
    const fresh = await f.store.createSession('alice', 'lin-wan', f.session.worldId, { dynamicOpening: true });
    const next = await f.store.previewInput('alice', fresh.session.id, '早上好。');
    const packet = actorPacket(next);
    assert.equal(packet.character.greeting, ''); assert.deepEqual(packet.history, []);
    assert.equal(packet.worldContext!.entities.find(row => row.id === item)!.state.status, '锁在抽屉里');
    assert.equal(packet.worldContext!.entities.find(row => row.id === quest)!.state.status, 'active');
    assert.equal(packet.worldContext!.entities.find(row => row.id === 'lin-wan')!.state.locationId, f.place);
    const related=(await readPastDialogue(f.store,'alice',fresh.session.id,'lin-wan',[turn.id])).find(row=>row.turnId===turn.id)!;
    assert(related);assert.equal(related.userText,'好，明天六点半见。');
    assert(related.replies.some(reply=>reply.text.includes('铜钥匙')));
    assert.deepEqual(packet.episodes,[]);
    assert((await f.store.getWorld('alice', f.session.worldId)).episodes!.some(row => row.turnId === turn.id));
    const transfer = await f.store.beginTurn('alice', fresh.session.id, 'transfer', '谢谢。');
    await f.store.commit(transfer, '林晚取出铜钥匙，交到你手里。', [], { observations: { 'lin-wan': '谢谢。' }, entityChanges: [
      { op: 'update', entity: { id: item, kind: 'item', name: '铜钥匙', description: '已经交给玩家。', state: { holderCharacterId: '$player', locationId: null, status: '玩家持有' }, knownByCharacterIds: ['lin-wan'] } },
    ] });
    const delivered = (await f.store.getWorld('alice', f.session.worldId)).entities!.find(row => row.id === item)!;
    assert.equal(delivered.state.holderCharacterId, '$player'); assert.equal(delivered.state.locationId, null); assert.equal(delivered.state.status, '玩家持有');
    const current = actorPacket(await f.store.previewInput('alice', fresh.session.id, '我把钥匙收好。'));
    assert.equal(current.worldContext!.entities.find(row => row.id === item)!.state.status, '玩家持有');
    assert.equal(current.worldContext!.entities.find(row => row.id === item)!.state.holderCharacterId, '$player');
  } finally { await f.cleanup(); }
});

test('separated observations retain source fragments while event and actor text omit the private gap', async () => {
  const f = await sceneFixture();
  try {
    const parts = ['我向林晚点头。', '我说：明早六点半门口见。'];
    const content = `${parts[0]}（我在心里反复念着私人暗号夜雨，没有说出口。）${parts[1]}`;
    const turn = await f.store.beginTurn('alice', f.session.id, 'segments', content);
    for (const invalid of [[...parts].reverse(), [parts[0], parts[0]], parts.join('\n'), []]) {
      await assert.rejects(f.store.commit(turn, '林晚答应明早见。', [], { observations: { 'lin-wan': invalid } }), { code: 'OBSERVATION_INVALID' });
    }
    const saved = await f.store.commit(turn, '林晚点头：“明早见。”', [{ kind: 'event', text: '保存约定', visibility: 'private', characterId: 'lin-wan', evidence: { source: 'user', turnId: turn.id } }], {
      observations: { 'lin-wan': parts, [f.other]: '' }, scene: { ...turn.input.scene!, situation: '不能泄露夜雨暗号' },
    });
    const event = saved.world.events[0]!;
    assert.equal(event.text, parts.join('\n'));
    const packet = actorPacket(await f.store.previewInput('alice', f.session.id, '早上好。'));
    assert.deepEqual(packet.world.events,[]);
    assert.equal((await readPastDialogue(f.store,'alice',f.session.id,'lin-wan',[turn.id])).find(row=>row.turnId===turn.id)!.userText,parts.join('\n'));
    assert(!JSON.stringify(packet).includes('夜雨'));
    const archive = await f.store.getWorld('alice', f.session.worldId);
    assert.deepEqual(archive.episodes!.find(row => row.turnId === turn.id)!.observations?.['lin-wan'], parts);
    assert.equal(archive.episodes!.find(row => row.turnId === turn.id)!.userText, content);
    const retracted = await f.store.setMemoryStatus('alice', f.session.worldId, event.id, archive.revision, 'retracted');
    await f.store.setMemoryStatus('alice', f.session.worldId, event.id, retracted.revision, 'active');
    // Independent SQL validation must reject a fabricated reordered source even when
    // the event text is changed to match its joined form and each piece exists alone.
    const reversed = [...parts].reverse();
    await f.store.pool.query('UPDATE turns SET episode_observations=$2 WHERE id=$1', [turn.id, { 'lin-wan': reversed, [f.other]: '' }]);
    await f.store.pool.query('UPDATE events SET text=$2 WHERE id=$1', [event.id, reversed.join('\n')]);
    const tampered = actorPacket(await f.store.previewInput('alice', f.session.id, '继续。'));
    assert.equal(tampered.world.events.length, 0);
    assert.equal((await readPastDialogue(f.store,'alice',f.session.id,'lin-wan',[turn.id])).find(row=>row.turnId===turn.id)!.userText,'');
  } finally { await f.cleanup(); }
});
