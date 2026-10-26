import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStoryTime as hostResolve, validateStoryAdvance as hostValidate } from '../shared/story-time.ts';
import type { StoryTime, TemporalContext } from '../shared/living-world.ts';

const harnessRoot = process.env.HARNESS_ROOT || '../../roleplay-harness';
const harness = () => import(pathToFileURL(resolve(harnessRoot, 'dist/apps/agentic-v3/story-time.js')).href);
const before: StoryTime = { day: 1, minute: 990, precision: 'minute', source: { kind: 'setup' } };
const temporal = (extra: Partial<TemporalContext> = {}): TemporalContext => ({ real: { now: '2026-10-22T08:00:00Z', previousTurnAt: '2026-10-15T07:00:00Z', elapsedMs: 7 * 86400000 + 3600000 }, story: before, offlineEligible: false, realGapStoryMs: 0, ...extra });
const proposed = (day: number, minute: number | null, quote: string, period?: StoryTime['period']): StoryTime => ({ day, minute, ...(period ? { period } : {}), precision: minute === null ? 'period' : 'minute', source: { kind: 'user_explicit', turnId: 'turn', quote } });

test('host and built Harness agree on explicit story advance and reject score, promise and backward time', async () => {
  const app = await harness();
  const quote = '第二天下午，我来到操场。';
  const next = proposed(2, null, quote, 'afternoon');
  assert.deepEqual(hostValidate(before, next, quote, 'turn'), app.validateStoryAdvance(before, next, quote, 'turn'));
  assert.equal(hostValidate(before, next, quote, 'turn').day, 2);
  for (const [text, candidate] of [
    ['第二天下午，我没有迟到，来到操场。', proposed(2, null, '第二天下午，我没有迟到，来到操场。', 'afternoon')],
    ['现在下午四点半，我还没吃饭。', proposed(1, 990, '现在下午四点半，我还没吃饭。', 'afternoon')],
  ] as const) {
    assert.deepEqual(hostValidate(before, candidate, text, 'turn'), app.validateStoryAdvance(before, candidate, text, 'turn'));
  }
  for (const [text, bad] of [
    ['三千米成绩是17:18。', proposed(1, 1038, '三千米成绩是17:18。')],
    ['“明天下午四点半见。”', proposed(2, 990, '“明天下午四点半见。”')],
    ['现在上午十点，我到了。', proposed(1, 600, '现在上午十点，我到了。', 'morning')],
  ] as const) {
    assert.throws(() => hostValidate(before, bad, text, 'turn'));
    assert.throws(() => app.validateStoryAdvance(before, bad, text, 'turn'));
  }
});

test('host and Harness preserve a full week gap, protect active scenes, and never add an explicit jump twice', async () => {
  const app = await harness();
  const duration = 7 * 86400000 + 3600000;
  const left = temporal({ offlineEligible: true, realGapStoryMs: duration });
  const real = hostResolve(left, undefined, '我回来了。', 'turn');
  assert.deepEqual(real, app.resolveStoryTime(left, undefined, '我回来了。', 'turn'));
  assert.equal(real.story.day, 8); assert.equal(real.story.minute, 1050); assert.equal(real.elapsedMs, duration);
  const protectedScene = temporal({ offlineEligible: false, realGapStoryMs: duration });
  assert.equal(hostResolve(protectedScene, undefined, '嗯。', 'turn').elapsedMs, 0);
  assert.deepEqual(hostResolve(protectedScene, undefined, '嗯。', 'turn'), app.resolveStoryTime(protectedScene, undefined, '嗯。', 'turn'));
  const quote = '第二天下午，我来到操场。', next = proposed(2, null, quote, 'afternoon');
  const explicit = hostResolve(left, next, quote, 'turn');
  assert.equal(explicit.story.day, 2); assert(explicit.elapsedMs < duration);
  assert.deepEqual(explicit, app.resolveStoryTime(left, next, quote, 'turn'));
});

test('a coarse story time cannot silently lose days or acquire an invented exact clock on return', async () => {
  const app = await harness();
  const input = temporal({ story: { day: 1, minute: null, period: 'afternoon', precision: 'period', source: { kind: 'setup' } }, offlineEligible: true, realGapStoryMs: 7 * 86400000 + 4 * 3600000 });
  const result = hostResolve(input, undefined, '我回来了。', 'turn');
  assert.deepEqual(result, app.resolveStoryTime(input, undefined, '我回来了。', 'turn'));
  assert(result.story.day !== null && result.story.day >= 8); assert.equal(result.story.minute, null);
});
