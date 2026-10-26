import test from 'node:test';
import assert from 'node:assert/strict';
import { narratedStoryTime, resolveStoryTime } from '../shared/story-time.ts';
import type { TemporalContext } from '../shared/living-world.ts';
const context:TemporalContext={real:{now:'2026-10-22T08:00:00Z',previousTurnAt:null,elapsedMs:1000},story:{day:2,minute:990,precision:'minute',source:{kind:'setup'}},offlineEligible:false,realGapStoryMs:0};

test('actual short-test wording: idioms later in a sentence cannot suppress elapsed time',()=>{
 const raw='十分钟后，前两圈下来，我的腿有点发沉。我经过她身边时喘着气说：“我没停，就是比我想的还难。”脚下仍维持着慢跑的节奏。';
 const result=resolveStoryTime(context,undefined,raw,'t');
 assert.equal(result.story.minute,1000);assert.equal(result.elapsedMs,600000);
 for(const raw of ['我差一点到了。','我一点也不累。','我有点累。'])assert.equal(narratedStoryTime(context.story,raw,'t'),undefined);
 assert.equal(resolveStoryTime(context,undefined,'下午五点，我有点累。','t').story.minute,1020);
});

test('relative elapsed duration survives a coarse clock without inventing an exact minute',()=>{
 const coarse={...context,story:{day:2,minute:null,precision:'day' as const,source:{kind:'setup' as const}}};
 const result=resolveStoryTime(coarse,undefined,'十分钟后，我做完热身。','t');
 assert.equal(result.story.minute,null);assert.equal(result.story.day,2);assert.equal(result.elapsedMs,600000);
 assert.equal(result.offlineEligible,true);
});
test('explicit ten minutes advance even when Main omits its optional proposal',()=>{
  const result=resolveStoryTime(context,undefined,'十分钟后，我做完热身，站回起跑线。','t');
  assert.equal(result.story.minute,1000);assert.equal(result.elapsedMs,600000);
  assert.equal(result.story.source.quote,'十分钟后，我做完热身，站回起跑线。');
});
test('automatic clock does not advance from dialogue, promises, negation, times or fantasies',()=>{
  for(const raw of ['“十分钟后见。”','再过十分钟我会回来。','我准备十分钟后出发。','如果十分钟后我到场呢？','现在不是下午五点。','三千米成绩是17:18。','我想象着第二天早上六点半来到操场。']) {
    assert.equal(narratedStoryTime(context.story,raw,'t'),undefined,raw);
  }
});
test('explicit next-day arrival overrides wall clock and does not add either jump twice',()=>{
  const t={...context,offlineEligible:true,realGapStoryMs:86400000*7};
  const raw='第二天早上六点半，我穿着运动服来到田径场内道起跑线。';
  const result=resolveStoryTime(t,undefined,raw,'t');
  assert.equal(result.story.day,3);assert.equal(result.story.minute,390);assert.equal(result.elapsedMs,14*3600000);
  assert.deepEqual(resolveStoryTime(t,result.story,raw,'t'),result);
});
test('midnight carries the day; multiple conflicting current anchors fail instead of silently choosing one',()=>{
  const before={...context.story,minute:1435};
  const result=narratedStoryTime(before,'十分钟后，我走出门。','t');
  assert.equal(result?.day,3);assert.equal(result?.minute,5);
  assert.throws(()=>narratedStoryTime(context.story,'十分钟后，我到了。二十分钟后，我又出门了。','t'),/Multiple/);
});
