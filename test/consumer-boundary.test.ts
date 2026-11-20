import { worldBackgroundStatus } from '../web/world-model';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApiClient } from '../web/api';
import { clientScopeKey } from '../web/client-scope';
import { createAdminApiClient } from '../web/admin/api';
import { WorldInspection, inspectionTabs } from '../web/WorldInspector';
import { WorldInspection as AdminWorldInspection } from '../web/admin/WorldInspector';
import type { WorldView } from '../shared/contracts';

const administration = ['trace', 'prompts', 'savePrompt', 'testAgent', 'agentCatalog', 'runtimeAudit', 'captureRuntimeAudit'];
test('account scope remount key changes for a new client or namespace and stays stable within one identity', () => {
  const first = createApiClient(), second = createApiClient();
  const key = clientScopeKey(first, 'alice:');
  assert.equal(clientScopeKey(first, 'alice:'), key);
  assert.notEqual(clientScopeKey(first, 'bob:'), key);
  assert.notEqual(clientScopeKey(second, 'alice:'), key);
  assert.equal(clientScopeKey(first, 'alice:'), key);
});

test('consumer client has no administration capabilities; separate admin client keeps authenticated requests', async () => {
  const publicClient = createApiClient();
  for (const key of administration) assert.equal(key in publicClient, false, key);
  const calls: { url: string; authorization: string | null }[] = [];
  const adminClient = createAdminApiClient({ baseUrl: '/private/api', getHeaders: () => ({ Authorization: 'fixture' }), fetch: async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json({});
  } });
  for (const key of administration) assert.equal(typeof adminClient[key as keyof typeof adminClient], 'function', key);
  await adminClient.prompts(); await adminClient.agentCatalog(); await adminClient.trace('turn');
  assert.deepEqual(calls, ['/private/api/dev/prompts', '/private/api/dev/agent-catalog', '/private/api/turns/turn/trace'].map(url => ({ url, authorization: 'fixture' })));
});

test('consumer world UI cannot render internal fields even if given an unfiltered admin snapshot', () => {
  const world: WorldView = { id: 'world', title: '世界', revision: 1, createdAt: '', events: [],
    entities: [{ id: 'person', kind: 'npc', name: '可见人物', description: '公开介绍', createdAt: '', updatedAt: '', sourceTurnId: 'turn', knownByCharacterIds: [], state: { secret: 'PRIVATE_ENTITY', arc: 'PRIVATE_SUMMARY' } }],
    director: { status: 'failed', turnId: 'turn', errorCode: 'PRIVATE_ERROR' },
    deferredCommands: [{ id: 'command', reason: 'PRIVATE_REASON', evidenceIds: [] }],
  };
  assert.deepEqual(worldBackgroundStatus(world), { pendingTurns: 0, failedTurns: 0, polling: false });
  assert.deepEqual(worldBackgroundStatus({ ...world, settlementBacklog: { pendingTurns: 2, failedTurns: 1, oldestPendingAt: null } }), { pendingTurns: 2, failedTurns: 1, polling: true });
  for (const [tab] of inspectionTabs) {
    const html = renderToStaticMarkup(createElement(WorldInspection, { world, tab }));
    assert.doesNotMatch(html, /PRIVATE_|保存字段|JSON|队列与入库/);
  }
  assert.match(renderToStaticMarkup(createElement(WorldInspection, { world, tab: 'npc' })), /可见人物/);
  assert.match(renderToStaticMarkup(createElement(AdminWorldInspection, { world, tab: 'npc' })), /PRIVATE_ENTITY/);
});

test('consumer artifact check rejects management code in any chunk, maps and retained reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'consumer-boundary-'));
  const checker = resolve('scripts/check-consumer-build.mjs');
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<script src="/assets/main.js"></script>');
    writeFileSync(join(root, 'assets/main.js'), 'console.log("story");');
    const run = () => spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    for (const marker of ['/dev/prompts', '/trace', '/runtime-audit', 'prompt-drafts:v1', 'mainlinePlan', 'av-prompt-editor']) {
      writeFileSync(join(root, 'assets/lazy.js'), JSON.stringify(marker));
      const result = run(); assert.notEqual(result.status, 0, marker); assert.match(result.stderr, /Private marker/);
    }
    rmSync(join(root, 'assets/lazy.js'));
    for (const name of ['assets/main.js.map', 'verification/report.json', 'admin/index.html']) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), '{}');
      assert.notEqual(run().status, 0, name);
      rmSync(join(root, name));
    }
    symlinkSync(join(root, 'assets/main.js'), join(root, 'assets/leaked.js'));
    assert.match(run().stderr, /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('consumer development server denies admin and backend sources, including direct filesystem URLs', async () => {
  const server = await createServer({ configFile: resolve('vite.config.ts'), mode: 'development', optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, preTransformRequests: false }, logLevel: 'silent' });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== 'string');
    for (const [path, status] of [['/main.tsx', 200], ['/admin/main.tsx', 403], ['/@fs' + resolve('web/admin/api.ts'), 403], ['/@fs' + resolve('server/developer.ts'), 403]] as const) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      await response.text();
      assert.equal(response.status, status, path);
    }
  } finally { await server.close(); }
});
