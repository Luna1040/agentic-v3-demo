import assert from 'node:assert/strict';
import test from 'node:test';
import { storyTimeLabel, recordedTimeLabel, actorRecallSummary } from '../web/time-model.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntityCard } from '../web/WorldArchive.tsx';
import { SceneStrip } from '../web/ScenePanel.tsx';
import { MemoryEntry } from '../web/MemoryDrawer.tsx';
import type { WorldEntity, WorldView } from '../shared/contracts.ts';

test('story display preserves unknown and coarse precision instead of inventing midnight', () => {
  assert.equal(storyTimeLabel(undefined), '剧情时间未确定');
  assert.equal(storyTimeLabel({ day: null, minute: null, precision: 'unknown' }), '剧情时间未确定');
  assert.equal(storyTimeLabel({ day: 3, minute: null, precision: 'day' }), '故事第 3 天');
  assert.equal(storyTimeLabel({ day: 3, minute: null, precision: 'period', period: 'afternoon' }), '故事第 3 天 · 下午');
  assert.equal(storyTimeLabel({ day: 4, minute: 990, precision: 'minute' }), '故事第 4 天 · 16:30');
  assert.equal(storyTimeLabel({ day: 4, minute: 1500, precision: 'minute' }), '故事第 4 天');
  assert.equal(storyTimeLabel({ day: null, minute: 990, precision: 'minute' }), '故事日期未确定 · 16:30');
  assert.equal(storyTimeLabel('2026-10-22T08:30:00Z'), '剧情时间未确定');
});

test('real record time uses the selected local timezone and handles legacy missing values', () => {
  assert.match(recordedTimeLabel('2026-10-22T00:30:00Z', 'Asia/Shanghai'), /2026\/10\/22.*08:30/);
  assert.match(recordedTimeLabel('2026-10-22T00:30:00Z', 'America/New_York'), /2026\/10\/21.*20:30/);
  assert.equal(recordedTimeLabel(''), '记录时间未确定');
  assert.equal(recordedTimeLabel('invalid'), '记录时间未确定');
});

test('developer recall summary counts only the actual actor packet and exposes its selection reasons', () => {
  assert.equal(actorRecallSummary({ episodes: [] }), undefined);
  const summary = actorRecallSummary({ character: { id: 'a' }, worldContext: { story: { now: { day: 4, minute: 990, precision: 'minute' } } }, episodes: [
    { turnId: 'old', sessionId: 'one', storyTime: { day: 1, minute: null, precision: 'day' }, retrieval: { reason: 'related', matches: ['归还书本'] } },
    { turnId: 'new', sessionId: 'two', retrieval: { reason: 'recent', matches: [] } },
  ] });
  assert.equal(summary?.count, 2); assert.equal(summary?.sessions, 2); assert.equal(summary?.related, 1);
  assert.equal(summary?.time, '故事第 4 天 · 16:30');
  assert.deepEqual(summary?.records[0]?.matches, ['归还书本']);
});

test('scene, quest and memory render story chronology separately from real record dates', () => {
  const time = { day: 3, minute: null, period: 'afternoon' as const, precision: 'period' as const, source: { kind: 'user_explicit' as const, turnId: 'turn-1', quote: '第三天下午' } };
  const quest: WorldEntity = { id: 'quest', kind: 'quest', name: '归还旧书', description: '次日归还', state: { status: 'active', storyDue: { day: 4, minute: 990, precision: 'minute' }, progression: { phase: '等待赴约', completedMilestones: ['已借出旧书'], nextStep: '次日在书店归还' } }, knownByCharacterIds: [], sourceTurnId: 'turn-1', createdAt: '2026-10-22T08:00:00Z', updatedAt: '2026-10-22T08:00:00Z' };
  const world: WorldView = { id: 'world', title: '故事', revision: 1, createdAt: quest.createdAt, storyTime: time, events: [], entities: [quest] };
  const sceneHtml = renderToStaticMarkup(createElement(SceneStrip, { world, characters: [], busy: false, onEdit: () => {} }));
  assert.match(sceneHtml, /故事第 3 天 · 下午/); assert.doesNotMatch(sceneHtml, /00:00/);
  const questHtml = renderToStaticMarkup(createElement(EntityCard, { entity: quest, entities: [quest], templates: [], busy: false, onScene: () => {} }));
  assert.match(questHtml, /故事第 4 天 · 16:30/); assert.match(questHtml, /已借出旧书/); assert.match(questHtml, /下一步意向/);
  const memoryHtml = renderToStaticMarkup(createElement(MemoryEntry, { event: { id: 'event', kind: 'event', text: '我借走了书。', characterId: 'a', visibility: 'private', sourceTurnId: 'turn-1', createdAt: quest.createdAt, storyTime: time, status: 'active', evidence: { source: 'user', turnId: 'turn-1' } }, disabled: false, saving: false, onChange: () => {} }));
  assert.match(memoryHtml, /记录于/); assert.match(memoryHtml, /故事第 3 天 · 下午/);
});
