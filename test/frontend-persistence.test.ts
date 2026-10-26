import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorldView } from '../shared/contracts';
import { createApiClient } from '../web/api';
import { promptDraftKey, readPromptDrafts, writePromptDrafts } from '../web/prompt-drafts';
import { sceneDraft, sceneDraftReducer, scenePatch } from '../web/scene-state';
import { filterSessions } from '../web/session-presentation';

function memoryStorage() {
  const entries = new Map<string, string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
}

test('prompt drafts survive remount/reload and stay isolated by non-secret owner namespace', () => {
  const storage = memoryStorage();
  writePromptDrafts('owner-a:', { main: 'A unsaved main', actor: '', updater: 'A unsaved updater' }, storage);
  assert.deepEqual(readPromptDrafts('owner-a:', storage), { main: 'A unsaved main', actor: '', updater: 'A unsaved updater' });
  assert.deepEqual(readPromptDrafts('owner-b:', storage), {});
  writePromptDrafts('owner-b:', { main: 'B draft' }, storage);
  assert.equal(readPromptDrafts('owner-a:', storage).main, 'A unsaved main');
  assert.equal(readPromptDrafts('owner-b:', storage).main, 'B draft');
  const client = createApiClient({ storageNamespace: 'owner-a:' });
  assert.equal(client.storageNamespace, 'owner-a:');
});

test('prompt draft storage never serializes unknown configuration and is disabled without an identity namespace', () => {
  const storage = memoryStorage();
  writePromptDrafts(undefined, { main: 'must not leak between anonymous clients' }, storage);
  assert.equal(storage.entries.size, 0);
  assert.equal(promptDraftKey('  '), null);
  writePromptDrafts('owner:', { main: 'valid prompt', providerSecret: 'not a prompt', headers: { authorization: 'not a prompt' } } as never, storage);
  assert.equal(storage.getItem(promptDraftKey('owner:')!), '{"main":"valid prompt"}');
  storage.setItem(promptDraftKey('owner:')!, '{"main":"draft","actor":null,"providerSecret":"ignore"}');
  assert.deepEqual(readPromptDrafts('owner:', storage), { main: 'draft' });
  storage.setItem(promptDraftKey('owner:')!, '{truncated');
  assert.deepEqual(readPromptDrafts('owner:', storage), {});
});

test('browser storage denial cannot prevent prompt editing', () => {
  const unavailable = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(readPromptDrafts('owner:', unavailable), {});
  assert.doesNotThrow(() => writePromptDrafts('owner:', { actor: 'local draft' }, unavailable));
});

const world: WorldView = { id: 'world-111111', title: '雨夜书店', revision: 3, createdAt: '', events: [], scene: { location: '旧书店', presentCharacterIds: ['a'] } };

test('scene drafts retain their original CAS revision until the latest server scene explicitly replaces them', () => {
  let draft = sceneDraft(world);
  draft = sceneDraftReducer(draft, { type: 'location', value: '未保存草稿' });
  draft = sceneDraftReducer(draft, { type: 'present', value: ['a', 'b'] });
  assert.deepEqual(scenePatch(draft), { expectedRevision: 3, scene: { location: '未保存草稿', presentCharacterIds: ['a', 'b'] } });
  const latest = { ...world, revision: 5, scene: { location: '服务器新地点', presentCharacterIds: ['c'] } };
  draft = sceneDraftReducer(draft, { type: 'reload', world: latest });
  assert.deepEqual(scenePatch(draft), { expectedRevision: 5, scene: { location: '服务器新地点', presentCharacterIds: ['c'] } });
  assert.deepEqual(world.scene?.presentCharacterIds, ['a'], 'local editing must not mutate the authoritative snapshot');
  assert.equal(sceneDraftReducer(draft, { type: 'reload', world: { ...latest, id: 'another-world' } }), draft);
});

test('session search covers visible world titles and short IDs without admitting unauthorized sessions', () => {
  const allowed = [{ id: 'session-aaaaaa', worldId: world.id, characterId: 'a', title: '与海斗交谈', createdAt: '2026-10-21T10:00:00Z', updatedAt: '' }];
  const worlds = [world, { ...world, id: 'world-private', title: '不可访问的世界' }];
  for (const query of ['雨夜书店', '#111111', '#AAAAAA', '  海斗  ']) assert.deepEqual(filterSessions(allowed, [], worlds, query), allowed);
  assert.deepEqual(filterSessions(allowed, [], worlds, '不可访问'), []);
  assert.deepEqual(filterSessions([], [], worlds, '雨夜书店'), []);
});
