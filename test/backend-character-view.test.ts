import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';
import type { ArcSource, CharacterView, EntityChange } from '../shared/living-world.ts';

async function fixture() {
  const f = await postgresFixture({ livingWorld: true });
  try {
  const session = await f.store.createSession('alice', 'lin-wan', undefined, { dynamicOpening: true });
  const other = randomUUID();
  const opening = await f.store.beginTurn('alice', session.session.id, `opening:${session.session.id}`, '开场', {}, { operation: 'opening' });
  await f.store.commit(opening, '林晚翻开名册。', [], { scene: { location: '阅览室', presentCharacterIds: ['lin-wan', other], mode: 'ensemble' }, observations: { 'lin-wan': '', [other]: '' }, entityChanges: [
    { op: 'create', entity: { id: other, kind: 'npc', name: '小舟', description: '负责整理书架的管理员。', knownByCharacterIds: ['lin-wan', other] } },
    { op: 'create', entity: { id: randomUUID(), kind: 'location', name: '阅览室', description: '', knownByCharacterIds: ['lin-wan', other] } },
  ] });
  const world = await f.store.getWorld('alice', session.world.id);
  return { ...f, session: session.session, other, own: world.entities!.find(row => row.id === 'lin-wan')! };
  } catch (error) { await f.cleanup(); throw error; }
}
function update(own: { id: string; name: string; description: string }, arc: string, arcSource?: ArcSource): EntityChange {
  return { op: 'update', entity: { id: own.id, kind: 'npc', name: own.name, description: own.description, state: { arc } }, ...(arcSource ? { arcSource } : {}) };
}

test('actor interpretations retain a traceable subjective view while real actions and promises remain in episodes', async () => {
  const f = await fixture();
  try {
    const quote = '林晚说：“我觉得你是紧张，不是懒。我答应明早六点开门。”';
    const text = `${quote}\n\n林晚把铜钥匙锁进抽屉。`;
    const turn = await f.store.beginTurn('alice', f.session.id, 'perspective', '我站在门边，点了点头。');
    const saved = await f.store.commit(turn, text, [], { observations: { 'lin-wan': turn.input.userText, [f.other]: '' }, entityChanges: [
      update(f.own, '她认为玩家紧张，并答应明早六点开门。', { source: 'actor', characterId: f.own.id, quote }),
      { op: 'create', entity: { id: randomUUID(), kind: 'item', name: '铜钥匙', description: '由林晚保管。', state: { status: '锁在抽屉中', holderCharacterId: f.own.id }, knownByCharacterIds: [f.own.id] } },
    ] });
    const state = saved.world.entities!.find(row => row.id === f.own.id)!.state;
    assert.deepEqual(state.arcProvenance, { kind: 'character_view', status: 'source_verified', turnId: turn.id, source: 'actor', characterId: f.own.id, quote });
    const next = await f.store.previewInput('alice', f.session.id, '早上好。');
    const own = next.worldContext!.actorInputs[f.own.id];
    const projected = own.worldContext!.entities.find(row => row.id === f.own.id)!.state;
    assert.equal(projected.arc, undefined); assert.equal(projected.arcProvenance, undefined);
    assert.equal((projected.characterView as CharacterView).kind, 'character_view');
    assert.equal((projected.characterView as CharacterView).provenance.status, 'source_verified');
    assert.equal((await readPastDialogue(f.store,'alice',f.session.id,f.own.id,[turn.id])).find(row=>row.turnId===turn.id)!.replies[0].text,text);
    assert.equal(own.worldContext!.entities.find(row => row.kind === 'item')!.state.status, '锁在抽屉中');
    const outsider = next.worldContext!.actorInputs[f.other];
    assert(!outsider.worldContext!.entities.some(row => 'characterView' in row.state || 'arcProvenance' in row.state || 'arc' in row.state));
    assert(!JSON.stringify(outsider.worldContext!.entities).includes('玩家紧张'));
  } finally { await f.cleanup(); }
});

test('summary source independently rejects forged, cross-segment, other-NPC and unavailable observations atomically', async () => {
  const f = await fixture();
  try {
    const parts = ['我放下杯子。', '我说：明早见。'];
    const turn = await f.store.beginTurn('alice', f.session.id, 'source-scope', `${parts[0]}（心里想着私人暗号夜雨。）${parts[1]}`);
    const text = '林晚说：“明早见。”';
    const observations = { 'lin-wan': parts, [f.other]: '' };
    for (const arcSource of [
      { source: 'user', quote: '私人暗号夜雨' },
      { source: 'user', quote: parts.join('\n') },
      { source: 'actor', characterId: f.own.id, quote: '不存在的承诺' },
      { source: 'actor', characterId: f.other, quote: '小舟心想：夜雨。' },
      { source: 'pulse', characterId: f.own.id, quote: '已经整理完书架。' },
    ] as ArcSource[]) {
      await assert.rejects(f.store.commit(turn, text, [], { observations, replies: [{ characterId: f.own.id, characterName: f.own.name, text }, { characterId: f.other, characterName: '小舟', text: '小舟心想：夜雨。' }], entityChanges: [update(f.own, '不该保存', arcSource)] }), { code: 'ARC_SOURCE_INVALID' });
    }
    const forged = update(f.own, '伪造可信标签'); forged.entity.state!.arcProvenance = { status: 'source_verified' };
    await assert.rejects(f.store.commit(turn, text, [], { observations, entityChanges: [forged] }), { code: 'ARC_SOURCE_INVALID' });
    assert.equal((await f.store.getTurn('alice', turn.id)).status, 'running');
    assert(!(await f.store.getWorld('alice', f.session.worldId)).entities!.find(row => row.id === f.own.id)!.state.arc);
    await f.store.commit(turn, text, [], { observations, entityChanges: [update(f.own, '她记下玩家说了明早见。', { source: 'user', quote: parts[1] })] });
    const own = (await f.store.previewInput('alice', f.session.id, '继续。')).worldContext!.actorInputs[f.own.id];
    const view = own.worldContext!.entities.find(row => row.id === f.own.id)!.state.characterView as CharacterView;
    assert.equal(view.kind, 'character_view', 'even a verified user quote cannot certify the free-form summary');
    assert(!JSON.stringify(view).includes('夜雨'));
  } finally { await f.cleanup(); }
});

test('legacy summaries remain available as unverified views and cannot inherit a prior verified source', async () => {
  const f = await fixture();
  try {
    const turn = await f.store.beginTurn('alice', f.session.id, 'verified', '明天见。');
    await f.store.commit(turn, '林晚点头。', [], { observations: { 'lin-wan': '明天见。' }, entityChanges: [update(f.own, '她记得玩家道别。', { source: 'user', quote: '明天见。' })] });
    const legacy = await f.store.beginTurn('alice', f.session.id, 'legacy-adapter', '嗯。');
    await f.store.commit(legacy, '林晚合上名册。', [], { observations: { 'lin-wan': '嗯。' }, entityChanges: [update(f.own, '旧运行产物没有逐段来源。')] });
    const stored = (await f.store.getWorld('alice', f.session.worldId)).entities!.find(row => row.id === f.own.id)!;
    assert.deepEqual(stored.state.arcProvenance, { kind: 'character_view', status: 'legacy_unverified', turnId: legacy.id });
    // Historical rows without provenance need no bulk rewrite or fabricated backfill.
    await f.store.pool.query("UPDATE world_entities SET state=state - 'arcProvenance' WHERE world_id=$1 AND id=$2", [f.session.worldId, f.own.id]);
    const fresh = await f.store.createSession('alice', f.own.id, f.session.worldId, { dynamicOpening: true });
    const packet = (await f.store.previewInput('alice', fresh.session.id, '早。')).worldContext!.actorInputs[f.own.id];
    const view = packet.worldContext!.entities.find(row => row.id === f.own.id)!.state.characterView as CharacterView;
    assert.equal(view.summary, '旧运行产物没有逐段来源。'); assert.equal(view.provenance.status, 'legacy_unverified');
    assert.equal((await f.store.getWorld('alice', f.session.worldId)).entities!.find(row => row.id === f.own.id)!.state.arcProvenance, undefined);
  } finally { await f.cleanup(); }
});

test('a completed personal activity can source a view but an invitation cannot masquerade as an experience', async () => {
  const f = await fixture();
  try {
    await f.store.pool.query("UPDATE worlds SET real_anchor_at=clock_timestamp()-interval '2 minutes',clock_world_ms=0,clock_active_ms=0 WHERE id=$1", [f.session.worldId]);
    await f.store.pool.query("UPDATE world_entities SET state=state || jsonb_build_object('lastSettledAt',clock_timestamp()-interval '2 minutes','lastSettledWorldMs',0,'lastSettledActiveMs',0) WHERE world_id=$1 AND kind='npc'", [f.session.worldId]);
    await f.store.pool.query("UPDATE turns SET updated_at=clock_timestamp()-interval '2 minutes' WHERE world_id=$1 AND status='committed'",[f.session.worldId]);
    await f.store.pool.query("UPDATE sessions SET scene=scene || '{\"playerPresent\":false}'::jsonb WHERE world_id=$1",[f.session.worldId]);
    const turn = await f.store.beginTurn('alice', f.session.id, 'activity-view', '我回来了。');
    const quote = '林晚在阅览室整理完两页名册。';
    const locationId = turn.input.worldContext!.actorInputs[f.own.id].worldContext!.entities.find(row => row.id === f.own.id)!.state.locationId as string;
    const change = update(f.own, '她记得独自整理完了两页名册。', { source: 'pulse', characterId: f.own.id, quote });
    await assert.rejects(f.store.commit(turn, '林晚抬头。', [], { scene:{...turn.input.scene!,playerPresent:true},observations: { 'lin-wan': '我回来了。' }, activities: [{ characterId: f.own.id, kind: 'invitation', text: quote, elapsedMs: 60000,elapsedStoryMs:60000, locationId }], entityChanges: [change] }), { code: 'ARC_SOURCE_INVALID' });
    const saved = await f.store.commit(turn, '林晚抬头。', [], { scene:{...turn.input.scene!,playerPresent:true},observations: { 'lin-wan': '我回来了。' }, activities: [{ characterId: f.own.id, kind: 'completed', text: quote, elapsedMs: 60000,elapsedStoryMs:60000, locationId }], entityChanges: [change] });
    assert.equal((saved.world.entities!.find(row => row.id === f.own.id)!.state.arcProvenance as { source: string }).source, 'pulse');
    assert(saved.world.activities!.some(activity => activity.kind === 'completed' && activity.text === quote));
  } finally { await f.cleanup(); }
});
