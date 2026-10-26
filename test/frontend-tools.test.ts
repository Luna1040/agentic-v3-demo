import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentCallRecord, Character, Session } from '../shared/contracts';
import { ApiError, createApiClient } from '../web/api';
import { filterCharacters, imageUrl, recentCharacters } from '../web/catalog';
import { callCharacterLabel, callForest, testFailureSummary } from '../web/trace-model';
import { CallTrace, Usage } from '../web/CallTrace';
import { lastSessionKey, resolveInitialSession, sessionPresentation } from '../web/session-presentation';

const character = (id: string, fields: Partial<Character> = {}): Character => ({ id, name: id, subtitle: '', description: '', greeting: '', initial: '角', color: 'sage', source: 'legacy', language: 'zh', ...fields });
const call = (id: string, parentId: string | null = null, attemptId = 'attempt1'): AgentCallRecord => ({ id, parentId, attemptId, agent: parentId ? 'actor' : 'main', status: 'completed', model: 'fixture', startedAt: '2026-10-21T00:00:00Z', input: {} });

test('catalog hides samples by default while search and language filters combine', () => {
  const cards = [character('legacy1', { name: '月见', description: '安静的 librarian' }), character('legacy2', { language: 'en', name: 'Librarian' }), character('sample', { source: 'sample', name: '月见示例' })];
  assert.deepEqual(filterCharacters(cards, '', '', false).map(item => item.id), ['legacy1', 'legacy2']);
  assert.deepEqual(filterCharacters(cards, ' LIBRARIAN ', 'zh', false).map(item => item.id), ['legacy1']);
  assert.deepEqual(filterCharacters(cards, '月见', '', true).map(item => item.id), ['legacy1', 'sample']);
  assert.equal(cards.length, 3);
});

test('recent characters preserve an active sample session but never enumerate the catalog', () => {
  const cards = Array.from({ length: 106 }, (_, i) => character(String(i)));
  cards.push(character('sample', { source: 'sample' }));
  const sessions: Session[] = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, characterId: String(i), worldId: 'world', title: 'story', createdAt: '', updatedAt: `2026-10-${10 + i}` }));
  sessions.push({ ...sessions[8], id: 'duplicate' });
  assert.deepEqual(recentCharacters(cards, sessions, 'sample').map(item => item.id), ['sample', '8', '7', '6', '5', '4']);
  assert.equal(recentCharacters(cards, []).length, 0);
});

test('media accepts ordinary hosted images and same-origin paths only', () => {
  assert.equal(imageUrl('https://example.test/card.png'), 'https://example.test/card.png');
  assert.equal(imageUrl('/assets/card.webp'), '/assets/card.webp');
  for (const value of ['javascript:alert(1)', 'data:text/html,unsafe', '//unscoped.test/file', 'file:///private.png', '']) assert.equal(imageUrl(value), undefined);
});

test('call tree follows actual parent IDs, and attempts never borrow each other’s parents', () => {
  const records = [call('main'), call('actor', 'main'), { ...call('updater', 'main'), agent: 'updater' as const }, call('retry', 'main', 'attempt2')];
  const roots = callForest(records);
  assert.deepEqual(roots.map(node => node.call.id), ['main', 'retry']);
  assert.deepEqual(roots[0].children.map(node => node.call.id), ['actor', 'updater']);
  assert.equal(roots[1].children.length, 0);
});

test('old orphan and malformed cyclic call links remain visible without invented roots', () => {
  const roots = callForest([call('orphan', 'missing'), call('cycle1', 'cycle2'), call('cycle2', 'cycle1')]);
  assert.deepEqual(roots.map(node => node.call.id), ['orphan', 'cycle1', 'cycle2']);
  assert.ok(roots.every(node => node.children.length === 0));
});

test('unknown token usage renders as unknown while a reported zero remains zero', () => {
  const unknown = renderToStaticMarkup(createElement(Usage, {}));
  assert.equal((unknown.match(/未返回/g) || []).length, 3);
  const reported = renderToStaticMarkup(createElement(Usage, { usage: { inputTokens: 0, outputTokens: 8 } }));
  assert.match(reported, /输入 0/);
  assert.match(reported, /输出 8/);
  assert.match(reported, /总计 未返回/);
});

test('trial errors remain prominent without requiring a call record, and empty traces do not imply old history', () => {
  assert.equal(testFailureSummary({ output: { error: { code: 'INVALID_SCENE_PLAN', message: '场景计划无法执行' } }, calls: [] }), 'INVALID_SCENE_PLAN · 场景计划无法执行');
  assert.equal(testFailureSummary({ output: {}, calls: [{ ...call('actor'), status: 'failed', error: { code: 'MODEL_TIMEOUT', message: '调用超时' } }] }), 'MODEL_TIMEOUT · 调用超时');
  assert.equal(testFailureSummary({ output: { text: '成功' }, calls: [call('actor')] }), undefined);
  const html = renderToStaticMarkup(createElement(CallTrace, { calls: [] }));
  assert.match(html, /尚无调用记录/);
  assert.doesNotMatch(html, /较早的对话/);
});

test('scene, trace, prompt saving and explicit testing share the injected auth and cancellation contract', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const signal = new AbortController().signal;
  const client = createApiClient({ baseUrl: 'https://host.test/feature/api/', getHeaders: () => ({ Authorization: 'fixture' }), fetch: async (url, init) => { calls.push({ url: String(url), init }); return Response.json({}); } });
  await client.trace('turn/one', { signal });
  await client.updateScene('world/one', { expectedRevision: 7, scene: { location: '书店', presentCharacterIds: ['c1'] } }, { signal });
  await client.prompts({ signal });
  await client.savePrompt('actor', { expectedVersion: 3, content: 'draft' }, { signal });
  assert.equal(calls.length, 4, 'reading and saving must not send a test request');
  await client.testAgent('updater', { sessionId: 's1', userText: 'user', assistantText: 'reply', prompt: 'unsaved draft' }, { signal });
  assert.deepEqual(calls.map(item => [item.url, item.init?.method]), [
    ['https://host.test/feature/api/turns/turn%2Fone/trace', 'GET'],
    ['https://host.test/feature/api/worlds/world%2Fone/scene', 'PATCH'],
    ['https://host.test/feature/api/dev/prompts', 'GET'],
    ['https://host.test/feature/api/dev/prompts/actor', 'PUT'],
    ['https://host.test/feature/api/dev/agents/updater/test', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { expectedRevision: 7, scene: { location: '书店', presentCharacterIds: ['c1'] } });
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { expectedVersion: 3, content: 'draft' });
  assert.deepEqual(JSON.parse(String(calls[4].init?.body)), { sessionId: 's1', userText: 'user', assistantText: 'reply', prompt: 'unsaved draft' });
  for (const item of calls) { assert.equal(item.init?.signal, signal); assert.equal(new Headers(item.init?.headers).get('authorization'), 'fixture'); }
});

test('version conflicts stay structured for scene and prompt recovery', async () => {
  const client = createApiClient({ fetch: async () => Response.json({ error: { code: 'PROMPT_VERSION_CONFLICT', message: '已被更新' } }, { status: 409 }) });
  await assert.rejects(client.savePrompt('main', { content: 'draft', expectedVersion: 1 }), (error: unknown) => error instanceof ApiError && error.code === 'PROMPT_VERSION_CONFLICT' && error.status === 409);
});

const savedSessions: Session[] = [
  { id: 'session-latest-aaaaaa', worldId: 'world-first-111111', characterId: 'kaito', title: '与海斗交谈', createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z' },
  { id: 'session-older-bbbbbb', worldId: 'world-second-222222', characterId: 'kaito', title: '与海斗交谈', createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z' },
];

test('authorized remembered conversation is restored instead of silently selecting the newest', () => {
  assert.equal(resolveInitialSession(savedSessions, undefined, savedSessions[1].id), savedSessions[1].id);
  assert.equal(resolveInitialSession(savedSessions, savedSessions[0].id, savedSessions[1].id), savedSessions[0].id);
});

test('unauthorized or removed remembered IDs never become startup selections', () => {
  assert.equal(resolveInitialSession(savedSessions, undefined, 'another-owner-session'), savedSessions[0].id);
  assert.equal(resolveInitialSession([], undefined, savedSessions[1].id), null);
  assert.notEqual(lastSessionKey('host-account-a:'), lastSessionKey('host-account-b:'));
  assert.equal(lastSessionKey('host-account-a:'), 'host-account-a:last-opened-session');
});

test('same character and timestamp sessions remain visibly distinguishable, with existing world titles', () => {
  const worlds = savedSessions.map((session, index) => ({ id: session.worldId, title: `测试故事 ${index + 1}`, revision: 1, createdAt: session.createdAt, events: [] }));
  const first = sessionPresentation(savedSessions[0], worlds);
  const second = sessionPresentation(savedSessions[1], worlds);
  assert.notEqual(first.stamp, second.stamp);
  assert.match(first.stamp, /#aaaaaa/);
  assert.match(second.stamp, /#bbbbbb/);
  assert.match(first.worldLabel, /世界 #111111.*测试故事 1/);
  assert.match(second.worldLabel, /世界 #222222.*测试故事 2/);
  assert.match(second.option, /^#bbbbbb.*与海斗交谈.*测试故事 2/);
  assert.match(sessionPresentation({ ...savedSessions[0], createdAt: '' }).stamp, /日期未记录/);
});

test('multiple Actor calls expose their actual input speaker while malformed identities stay hidden', () => {
  const first = { ...call('actor1', 'main'), input: { character: { name: '柏青', id: 'npc-abc123' } } };
  const second = { ...call('actor2', 'main'), input: { character: { name: '海斗', id: 'root-def456' } } };
  assert.equal(callCharacterLabel(first), '柏青 · #abc123');
  assert.equal(callCharacterLabel({ ...first, input: { character: { name: { secret: true } } } }), undefined);
  const html = renderToStaticMarkup(createElement(CallTrace, { calls: [call('main'), first, second] }));
  assert.match(html, /柏青 · #abc123/);
  assert.match(html, /海斗 · #def456/);
});
