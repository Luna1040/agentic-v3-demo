import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';
import { validMovementEvidence } from '../server/movement.ts';
import type { ActorLocation, SpeakerReply } from '../shared/living-world.ts';

test('movement distinguishes an actual final arrival from intentions, speech and an intermediate visit', () => {
  assert(validMovementEvidence('林晚走进器材室。', '林晚走进器材室。', '器材室', '林晚'));
  assert(validMovementEvidence('阿梅莉走进器材室。', '阿梅莉走进器材室。', '器材室', 'Amélie｜阿梅莉'));
  assert.equal(validMovementEvidence('林晚走出阅览室。', '林晚走出阅览室。', null, 'Chief Lin｜馆长林晚'), false);
  assert(validMovementEvidence('林晚走出阅览室。', '林晚走出阅览室。', null, 'Chief Lin｜馆长林晚', '林晚'));
  assert(validMovementEvidence('馆长林晚走出阅览室。', '馆长林晚走出阅览室。', null, 'Chief Lin｜馆长林晚', '林晚'));
  assert.equal(validMovementEvidence('学生走出阅览室。', '学生走出阅览室。', null, 'Chief Lin｜馆长林晚', '林晚'), false);
  assert.equal(validMovementEvidence('林晚走出阅览室。', '林晚走出阅览室。', null, 'Chief Lin｜馆长林晚', '.*'), false);
  assert(validMovementEvidence('林晚走进值班室(东侧)。', '林晚走进值班室(东侧)。', '值班室(东侧)', '林晚'));
  assert(validMovementEvidence('林晚离开器材室，锁好门，朝宿舍方向走去。', '林晚离开器材室，锁好门，朝宿舍方向走去。', null, '林晚'));
  for (const text of ['林晚朝宿舍方向走去。', '林晚心想：我走进宿舍。', '林晚打算走进宿舍。', '林晚说：“明天走进宿舍。”', '林晚自言自语：“我回到宿舍。”', '她准备回到宿舍。', '她明天回到宿舍。', '她没有回到宿舍。', '她目送学生走进宿舍。']) assert.equal(validMovementEvidence(text, text, '宿舍', '林晚'), false);
  assert.equal(validMovementEvidence('学生走进宿舍。', '走进宿舍。', '宿舍', '林晚'), false);
  assert.equal(validMovementEvidence('林晚走进器材室。\n\n她随后锁门离开。', '林晚走进器材室。', '器材室'), false);
  assert.equal(validMovementEvidence('林晚离开器材室。\n\n她随后回到阅览室。', '林晚离开器材室。', null), false);
});

async function fixture() {
  const f = await postgresFixture({ livingWorld: true });
  try {
  const session = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true });
  const other = randomUUID(), place = randomUUID(), destination = randomUUID();
  const opening = await f.store.beginTurn('alice', session.session.id, `opening:${session.session.id}`, '开场', {}, { operation: 'opening' });
  await f.store.commit(opening, '林晚翻开登记本。', [], { scene: { location: '阅览室', presentCharacterIds: ['lin-wan', other], mode: 'ensemble', playerPresent: true }, observations: { 'lin-wan': '', [other]: '' }, entityChanges: [
    { op: 'create', entity: { id: other, kind: 'npc', name: '小舟', description: '在桌边整理名册。', knownByCharacterIds: ['lin-wan', other] } },
    { op: 'create', entity: { id: place, kind: 'location', name: '阅览室', description: '', knownByCharacterIds: ['lin-wan', other] } },
    { op: 'create', entity: { id: destination, kind: 'location', name: '器材室', description: '', knownByCharacterIds: ['lin-wan', other] } },
  ] });
  return { ...f, session: session.session, other, place, destination };
  } catch (error) { await f.cleanup(); throw error; }
}
const move = (characterId: string, locationId: string | null, quote: string): ActorLocation => ({ characterId, locationId, evidence: { source: 'actor', characterId, quote } });

test('authored narrative names freeze into world identity, reach actor inputs and cannot be forged by WorldOps', async () => {
  const f = await postgresFixture({ livingWorld: true });
  try {
    await f.migrationPool.query("UPDATE characters SET name=$1,source=source || $2::jsonb WHERE id='lin-wan'", ['Chief Lin｜馆长林晚', JSON.stringify({ narrativeName: ' 林晚 ' })]);
    const s = await f.store.createSession('alice','lin-wan',undefined,{dynamicOpening:true,scene:{location:'阅览室',presentCharacterIds:['lin-wan'],mode:'ensemble',playerPresent:true}});
    const root = s.world.entities!.find(entity=>entity.id==='lin-wan')!;
    assert.equal(root.state.narrativeName,'林晚');
    await f.migrationPool.query("UPDATE characters SET source=source || $1::jsonb WHERE id='lin-wan'", [JSON.stringify({ narrativeName:'其他作者姓名' })]);
    const preview = await f.store.previewInput('alice',s.session.id,'再见。');
    assert.equal(preview.character.narrativeName,'林晚');
    assert.equal(preview.worldContext!.actorInputs['lin-wan'].character.narrativeName,'林晚');
    assert.equal(preview.worldContext!.entities.find(entity=>entity.id==='lin-wan')!.state.narrativeName,'林晚');
    const turn = await f.store.beginTurn('alice',s.session.id,'authored-name','再见。');
    const text = '林晚走出阅览室。';
    for(const entityChange of [
      {op:'update' as const,entity:{id:root.id,kind:'npc' as const,name:root.name,description:root.description,state:{narrativeName:'学生'}}},
      {op:'create' as const,entity:{id:randomUUID(),kind:'npc' as const,name:'学生',description:'另一个人',state:{narrativeName:'林晚'},knownByCharacterIds:['lin-wan']}},
    ]) await assert.rejects(f.store.commit(turn,text,[],{entityChanges:[entityChange]}),{code:'ENTITY_LOCKED'});
    const saved = await f.store.commit(turn,text,[],{actorLocations:[move('lin-wan',null,text)]});
    assert.equal(saved.world.entities!.find(entity=>entity.id==='lin-wan')!.state.locationId,null);
    assert.equal(saved.world.entities!.find(entity=>entity.id==='lin-wan')!.state.narrativeName,'林晚');
    // Keep the host's accepted author metadata within the Harness character contract.
    for (const length of [80,81]) {
      const name='名'.repeat(length),owner=`boundary-${length}`;
      await f.migrationPool.query("UPDATE characters SET source=source || $1::jsonb WHERE id='lin-wan'",[JSON.stringify({narrativeName:name})]);
      const boundary=await f.store.createSession(owner,'lin-wan',undefined,{dynamicOpening:true});
      assert.equal((await f.store.previewInput(owner,boundary.session.id,'你好')).character.narrativeName,length===80?name:undefined);
    }
  } finally { await f.cleanup(); }
});

test('focus movement updates only final camera and own position, keeping pre-movement witnesses and episode scene', async () => {
  const f = await fixture();
  try {
    const text = '林晚走进器材室。';
    const turn = await f.store.beginTurn('alice', f.session.id, 'focus-move', '明早六点见。');
    const saved = await f.store.commit(turn, text, [], { observations: { 'lin-wan': turn.input.userText, [f.other]: turn.input.userText }, actorLocations: [move('lin-wan', f.destination, text)] });
    const episode = saved.world.episodes!.find(row => row.turnId === turn.id)!;
    assert.equal(episode.scene.location, '阅览室'); assert.equal(episode.scene.playerPresent, true);
    assert.deepEqual(episode.participantIds, ['lin-wan', f.other]);
    assert.equal(episode.observations![f.other], '明早六点见。');
    assert.deepEqual(saved.world.scene, { location: '器材室', presentCharacterIds: ['lin-wan'], mode: 'ensemble', playerPresent: false });
    assert.equal(saved.world.entities!.find(row => row.id === 'lin-wan')!.state.locationId, f.destination);
    assert.equal(saved.world.entities!.find(row => row.id === f.other)!.state.locationId, f.place);
    const next = await f.store.previewInput('alice', f.session.id, '我还站在原处。');
    assert.equal(next.scene!.playerPresent, false);
    assert((await readPastDialogue(f.store,'alice',f.session.id,f.other,[turn.id])).some(row=>row.turnId===turn.id && row.userText==='明早六点见。'));
    assert.equal((await f.store.getSession('alice', f.session.id)).world.scene!.location, '器材室');
  } finally { await f.cleanup(); }
});

test('a departure without arrival clears only the departing NPC location and does not claim a destination', async () => {
  const f = await fixture();
  try {
    const text = '林晚离开阅览室，朝宿舍方向走去。';
    const turn = await f.store.beginTurn('alice', f.session.id, 'departure', '明天见。');
    const saved = await f.store.commit(turn, text, [], { observations: { 'lin-wan': turn.input.userText, [f.other]: '' }, actorLocations: [move('lin-wan', null, text)] });
    assert.equal(saved.world.scene!.location, null); assert.equal(saved.world.scene!.playerPresent, false);
    assert.equal(saved.world.entities!.find(row => row.id === 'lin-wan')!.state.locationId, null);
    assert.equal(saved.world.entities!.find(row => row.id === f.other)!.state.locationId, f.place);
    assert(!saved.world.entities!.some(row => row.name === '宿舍'));
  } finally { await f.cleanup(); }
});

test('only actors with their own confirmed arrival join the focus at the new destination', async () => {
  const f = await fixture();
  try {
    const turn = await f.store.beginTurn('alice', f.session.id, 'two-arrivals', '我在原地等你们。');
    const replies: SpeakerReply[] = [{ characterId: 'lin-wan', characterName: '林晚', text: '林晚走进器材室。' }, { characterId: f.other, characterName: '小舟', text: '小舟随后走进器材室。' }];
    const saved = await f.store.commit(turn, replies[0].text, [], { replies, observations: { 'lin-wan': turn.input.userText, [f.other]: turn.input.userText }, actorLocations: replies.map(reply => move(reply.characterId, f.destination, reply.text)) });
    assert.deepEqual(saved.world.scene!.presentCharacterIds, ['lin-wan', f.other]);
    assert.equal(saved.world.scene!.playerPresent, false);
    assert.equal(saved.world.episodes!.find(row => row.turnId === turn.id)!.scene.location, '阅览室');
  } finally { await f.cleanup(); }
});

test('a nonfocus actor leaving does not move the player or the focus camera', async () => {
  const f = await fixture();
  try {
    const text = '小舟离开阅览室。';
    const turn = await f.store.beginTurn('alice', f.session.id, 'other-departs', '我们继续看这页。');
    const replies: SpeakerReply[] = [{ characterId: 'lin-wan', characterName: '林晚', text: '林晚翻到下一页。' }, { characterId: f.other, characterName: '小舟', text }];
    const saved = await f.store.commit(turn, replies[0].text, [], { replies, observations: { 'lin-wan': turn.input.userText, [f.other]: turn.input.userText }, actorLocations: [move(f.other, null, text)] });
    assert.equal(saved.world.scene!.location, '阅览室'); assert.equal(saved.world.scene!.playerPresent, true);
    assert.deepEqual(saved.world.scene!.presentCharacterIds, ['lin-wan']);
    assert.equal(saved.world.entities!.find(row => row.id === 'lin-wan')!.state.locationId, f.place);
    assert.equal(saved.world.entities!.find(row => row.id === f.other)!.state.locationId, null);
    assert.deepEqual(saved.world.episodes!.find(row => row.turnId === turn.id)!.participantIds, ['lin-wan', f.other]);
  } finally { await f.cleanup(); }
});

test('invalid post-performance movement rolls back all writes, with a valid result still committable', async () => {
  const f = await fixture();
  try {
    const text = '林晚说：“明天我去器材室。”';
    const turn = await f.store.beginTurn('alice', f.session.id, 'invalid-moves', '好。');
    const observations = { 'lin-wan': '好。', [f.other]: '' };
    for (const candidate of [move('lin-wan', f.destination, text), move('lin-wan', randomUUID(), text), move(f.other, null, text), { ...move('lin-wan', null, text), evidence: { source: 'actor', characterId: f.other, quote: text } } as ActorLocation]) {
      await assert.rejects(f.store.commit(turn, text, [], { observations, actorLocations: [candidate] }), { code: 'ACTOR_LOCATION_INVALID' });
    }
    const validArrival = '林晚走进器材室。';
    await assert.rejects(f.store.commit(turn, validArrival, [], { observations, actorLocations: [move('lin-wan', randomUUID(), validArrival)] }), { code: 'ACTOR_LOCATION_INVALID' });
    await f.store.pool.query('UPDATE world_entities SET known_by_character_ids=$3 WHERE world_id=$1 AND id=$2', [f.session.worldId, f.destination, [f.other]]);
    await assert.rejects(f.store.commit(turn, validArrival, [], { observations, actorLocations: [move('lin-wan', f.destination, validArrival)] }), { code: 'ACTOR_LOCATION_INVALID' });
    const world = await f.store.getWorld('alice', f.session.worldId);
    assert.equal(world.entities!.find(row => row.id === 'lin-wan')!.state.locationId, f.place);
    assert(!world.episodes!.some(row => row.turnId === turn.id));
    await f.store.commit(turn, text, [], { observations });
    assert.equal((await f.store.getTurn('alice', turn.id)).status, 'committed');
  } finally { await f.cleanup(); }
});
