import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerProfile, WorldView } from '../shared/contracts';
import { createApiClient } from '../web/api';
import { ProfileDrafts, profileDraft, profileDrafts, profileDirty } from '../web/player-profile-drafts';
import { PlayerProfiles } from '../web/PlayerProfiles';

const profile: PlayerProfile = { id: 'profile-a', name: '周宁', persona: '修表店店员', version: 1 };

test('switching saved profiles and a new profile retains each unsaved draft', () => {
  const drafts = new ProfileDrafts();
  drafts.write({ ...drafts.current, name: '新人物草稿' });
  drafts.select(profile);
  drafts.write({ ...drafts.current, persona: '未保存的秘密' });
  assert.equal(drafts.select(null).name, '新人物草稿');
  assert.equal(drafts.select({ ...profile, version: 2 }).persona, '未保存的秘密');
  assert.equal(drafts.current.selected?.version, 1, 'a newer remote list must not silently bless stale edits');
  assert.ok(profileDirty(drafts.current));
  drafts.write(profileDraft({ ...profile, version: 2, persona: '新版' }));
  assert.equal(profileDirty(drafts.current), false);
  assert.equal(drafts.select(null).name, '新人物草稿');
});

test('drafts survive remounts and isolate both worlds and client identities', () => {
  const client = {}, anotherClient = {};
  const a = profileDrafts(client, 'world-a');
  a.write({ ...a.select(profile), persona: '甲世界未保存设定' });
  assert.equal(profileDrafts(client, 'world-a').current.persona, '甲世界未保存设定');
  assert.equal(profileDrafts(client, 'world-b').current.persona, '');
  assert.equal(profileDrafts(anotherClient, 'world-a').current.persona, '');
  assert.notEqual(a.key, profileDrafts(anotherClient, 'world-a').key);
});

test('successful saves replace only their original draft and deletion retains a separate new draft', () => {
  const drafts = new ProfileDrafts();
  drafts.write({ ...drafts.current, name: '新草稿' });
  drafts.select(profile);
  const second = { ...profile, id: 'profile-b', name: '乙' };
  drafts.select(second);
  drafts.write({ ...drafts.current, persona: '乙草稿' });
  drafts.saved({ ...profile, version: 2, persona: '甲已保存' }, profile.id);
  assert.equal(profileDirty(drafts.current), false);
  assert.equal(drafts.select(second).persona, '乙草稿');
  assert.equal(drafts.remove(second.id).name, '新草稿');
});

test('profile editor labels the world snapshot and blocks changes during a running story', () => {
  const world: WorldView = { id: 'w', title: '旧书店世界', revision: 2, createdAt: '', events: [], playerProfile: profile };
  const html = renderToStaticMarkup(createElement(PlayerProfiles, { client: createApiClient(), world, busy: true, onApplied: async () => {} }));
  assert.match(html, /当前世界：旧书店世界/);
  assert.match(html, /正在使用：周宁/);
  assert.match(html, /修表店店员/);
  assert.match(html, /disabled="">停用当前设定/);
  assert.match(html, /故事正在运行或载入/);
  assert.match(html, /刷新身份列表/);
});

test('profile API uses default host authentication and carries explicit versions and world revision', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createApiClient({ fetch: async (input, init) => { calls.push({ url: String(input), init }); return Response.json(profile); } });
  await client.playerProfiles();
  await client.savePlayerProfile('a/b', { name: '甲', persona: '', expectedVersion: 3 });
  await client.setPlayerProfile('w/1', { profileId: 'a/b', expectedRevision: 9 });
  await client.deletePlayerProfile('a/b', 3);
  assert.deepEqual(calls.map(call => [call.url, call.init?.method]), [['/api/player-profiles', 'GET'], ['/api/player-profiles/a%2Fb', 'PUT'], ['/api/worlds/w%2F1/player-profile', 'PATCH'], ['/api/player-profiles/a%2Fb', 'DELETE']]);
  assert.deepEqual(JSON.parse(calls[2].init!.body as string), { profileId: 'a/b', expectedRevision: 9 });
  assert.deepEqual(JSON.parse(calls[3].init!.body as string), { expectedVersion: 3 });
  for (const { init } of calls) assert.equal(new Headers(init?.headers).has('x-owner'), false);
});
