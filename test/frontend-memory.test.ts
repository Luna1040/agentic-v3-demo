import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoryEvent } from '../shared/contracts';
import { ApiError, createApiClient } from '../web/api';
import { MemoryEntry } from '../web/MemoryDrawer';
import { memoryAction, memoryLabel } from '../web/memory-state';

const memory = (fields: Partial<StoryEvent> = {}): StoryEvent => ({
  id: 'memory1', kind: 'fact', text: '这是玩家原文。', visibility: 'private', characterId: 'character1',
  sourceTurnId: 'turn-source-12345678', createdAt: '2026-10-21T10:00:00Z', status: 'active',
  evidence: { source: 'user', turnId: 'turn-user-abcdefgh' }, ...fields,
});
const render = (event: StoryEvent, disabled = false) => renderToStaticMarkup(createElement(MemoryEntry, {
  event, disabled, saving: false, onChange: () => { throw new Error('Rendering must never mutate memory'); },
}));

test('only retracted memories with user evidence can be restored, and unverified entries cannot be promoted', () => {
  assert.equal(memoryAction(memory()), 'retracted');
  assert.equal(memoryAction(memory({ status: 'retracted' })), 'active');
  assert.equal(memoryAction(memory({ status: 'retracted', evidence: null })), null);
  assert.equal(memoryAction(memory({ status: 'retracted', evidence: { source: 'user', turnId: '' } })), null);
  assert.equal(memoryAction(memory({ status: 'unverified', evidence: null })), 'retracted');
  assert.equal(memoryAction(memory({ status: 'unverified' })), 'retracted');
});

test('memory labels do not misrepresent legacy summaries or missing evidence as player quotations', () => {
  assert.equal(memoryLabel(memory()), '玩家原话');
  assert.equal(memoryLabel(memory({ status: 'unverified', evidence: null })), '旧记录待核对');
  assert.equal(memoryLabel(memory({ status: 'retracted' })), '已停用');
  assert.notEqual(memoryLabel(memory({ evidence: null })), '玩家原话');
});

test('memory UI shows evidence provenance and refuses activation controls for quarantined records', () => {
  const active = render(memory());
  assert.match(active, /玩家原话出处/);
  assert.match(active, /轮次 #abcdefgh/);
  assert.match(active, /角色私有/);
  assert.match(active, /停用记忆/);
  const legacy = render(memory({ status: 'unverified', evidence: null }));
  assert.match(legacy, /旧记录待核对/);
  assert.match(legacy, /旧记录来源/);
  assert.match(legacy, /轮次 #12345678/);
  assert.match(legacy, /停用记忆/);
  assert.doesNotMatch(legacy, /恢复使用/);
  assert.match(render(memory({ status: 'retracted' })), /恢复使用/);
  assert.doesNotMatch(render(memory({ status: 'retracted', evidence: null })), /<button/);
});

test('busy memory actions are visibly disabled without hiding their current state', () => {
  const html = render(memory(), true);
  assert.match(html, /玩家原话/);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /停用记忆/);
});

test('memory patch preserves world/event scope, expected revision, auth and abort signal', async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const signal = new AbortController().signal;
  const updated = { id: 'world/one', title: '故事', revision: 4, createdAt: '', events: [memory({ status: 'retracted' })] };
  const client = createApiClient({ baseUrl: '/host/api', getHeaders: () => ({ Authorization: 'fixture' }), fetch: async (url, init) => { captured = { url: String(url), init }; return Response.json(updated); } });
  assert.deepEqual(await client.updateMemory('world/one', 'event/one', { expectedRevision: 3, status: 'retracted' }, { signal }), updated);
  assert.equal(captured?.url, '/host/api/worlds/world%2Fone/events/event%2Fone');
  assert.equal(captured?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), { expectedRevision: 3, status: 'retracted' });
  assert.equal(captured?.init?.signal, signal);
  assert.equal(new Headers(captured?.init?.headers).get('authorization'), 'fixture');
});

test('memory CAS conflict remains structured so the panel refreshes instead of assuming a mutation succeeded', async () => {
  const client = createApiClient({ fetch: async () => Response.json({ error: { code: 'WORLD_CHANGED', message: '请刷新' } }, { status: 409 }) });
  await assert.rejects(client.updateMemory('world', 'event', { expectedRevision: 3, status: 'active' }), (error: unknown) => error instanceof ApiError && error.code === 'WORLD_CHANGED' && error.status === 409);
});
