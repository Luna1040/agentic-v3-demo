import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture } from './pg-helper.ts';
import { resolveStoryTime } from '../shared/story-time.ts';
import type { WorldTurnResult } from '../server/runtime.ts';

test('background settlement preserves inherited time provenance and drains subsequent turns', async () => {
  const f = await postgresFixture({ livingWorld: true });
  try {
    const s = await f.store.createSession('alice', 'lin-wan');
    const advance = await f.store.beginTurn('alice', s.session.id, randomUUID(), '第二天');
    await f.store.commit(advance, '林晚翻开书。', []);
    const original = (await f.store.getWorld('alice', s.world.id)).storyTime!;
    assert.equal(original.source.quote, '第二天');
    for (const content of ['等一下，我有话和你说', '我们走进咖啡馆。']) {
      const turn = await f.store.beginTurn('alice', s.session.id, randomUUID(), content);
      assert.equal(turn.input.worldContext!.temporal!.story.source.quote, undefined);
      const result: WorldTurnResult = { text: '林晚点了点头。', replies: [{ characterId: 'lin-wan', characterName: '林晚', text: '林晚点了点头。' }], changes: [], entityChanges: [], activities: [], usage: {}, scene: turn.input.scene };
      await f.store.commitDialogue(turn, result);
    }
    for (let i = 0; i < 2; i++) {
      const job = await f.store.claimSettlement(); assert(job);
      const input = job.evidence!.input;
      const storyTime = resolveStoryTime(input.worldContext!.temporal!, undefined, input.userText, input.turnId).story;
      await f.store.saveSettlementOffline(job, { activities: [], settledCharacterIds: [], storyTime });
      await f.store.saveSettlementResult(job, { ...job.dialogue, storyTime });
      assert.equal(await f.store.completeSettlement(job), true);
      const persisted = (await f.store.pool.query('SELECT story_time FROM turns WHERE id=$1', [job.turnId])).rows[0].story_time;
      assert.deepEqual(persisted, original);
    }
    assert.equal(await f.store.claimSettlement(), null);
    assert.deepEqual((await f.store.getWorld('alice', s.world.id)).storyTime, original);
  } finally { await f.cleanup(); }
});

test('background time validation rejects a changed clock and a forged stored advance', async () => {
  const f = await postgresFixture({ livingWorld: true });
  try {
    const s = await f.store.createSession('alice', 'lin-wan');
    const turn = await f.store.beginTurn('alice', s.session.id, randomUUID(), '第二天');
    const text = '林晚翻开书。';
    await f.store.commitDialogue(turn, { text, replies: [{ characterId: 'lin-wan', characterName: '林晚', text }], changes: [], entityChanges: [], activities: [], usage: {} });
    const job = await f.store.claimSettlement(); assert(job);
    const input = job.evidence!.input;
    const storyTime = resolveStoryTime(input.worldContext!.temporal!, undefined, input.userText, input.turnId).story;
    const result = { activities: [], settledCharacterIds: [], storyTime };
    await f.store.saveSettlementOffline(job, result);
    await assert.rejects(f.store.saveSettlementOffline(job, { ...result, storyTime: { ...storyTime, day: 99 } }), { code: 'ACTIVITY_INVALID' });
    await f.store.pool.query("UPDATE turns SET story_time=jsonb_set(story_time,'{day}','99') WHERE id=$1", [job.turnId]);
    await assert.rejects(f.store.saveSettlementOffline(job, result), { code: 'ACTIVITY_INVALID' });
  } finally { await f.cleanup(); }
});

for (const edited of [false, true]) test(`queued café discovery ${edited ? 'respects a later manual scene confirmation' : 'fills the latest scene after older background commits'}`, async () => {
  const f = await postgresFixture({ livingWorld: true });
  try {
    const s = await f.store.createSession('alice', 'lin-wan');
    for (const text of ['林晚翻开书。', '林晚在咖啡馆的窗边坐下。']) {
      const turn = await f.store.beginTurn('alice', s.session.id, randomUUID(), '继续。');
      await f.store.commitDialogue(turn, { text, replies: [{ characterId: 'lin-wan', characterName: '林晚', text }], attributedEvidence: [], changes: [], entityChanges: [], activities: [], usage: {} });
    }
    const earlier = await f.store.claimSettlement(); assert(earlier);
    await f.store.saveSettlementResult(earlier, earlier.dialogue);
    assert(await f.store.completeSettlement(earlier));
    if (edited) {
      const world = await f.store.getWorld('alice', s.world.id);
      // Even a manual confirmation of the same scene must fence old results.
      await f.store.setScene('alice', s.world.id, world.revision, world.scene!);
    }
    const latest = await f.store.claimSettlement(); assert(latest);
    const id = randomUUID();
    await f.store.saveSettlementResult(latest, { ...latest.dialogue, scene: { ...latest.input.scene!, location: '咖啡馆' }, entityChanges: [{ op: 'create', entity: { id, kind: 'location', name: '咖啡馆', description: '本轮实际所在的咖啡馆', state: {}, knownByCharacterIds: ['lin-wan'] }, witnessedByCharacterIds: ['lin-wan'] }] });
    assert(await f.store.completeSettlement(latest));
    const world = await f.store.getWorld('alice', s.world.id);
    assert.equal(world.scene?.location, edited ? null : '咖啡馆');
    assert(world.entities?.some(entity => entity.id === id));
  } finally { await f.cleanup(); }
});
