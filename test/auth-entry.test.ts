import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { createGatewayAuthentication } from '../server/auth.ts';
import { mountStaticApp } from '../server/static-app.ts';

const secret = 'test-gateway-secret-with-at-least-32-bytes';
const request = (headers: Record<string, string> = {}, address = '127.0.0.1') => ({
  get: (name: string) => headers[name.toLowerCase()], socket: { remoteAddress: address },
}) as Request;
const headers = { 'x-agentic-gateway-secret': secret, 'x-agentic-user-id': 'alice' };

test('identity requires the gateway secret; admin roles alone and production local fallback are rejected', () => {
  assert.throws(() => createGatewayAuthentication({ production: true, env: {} }), /AUTH_GATEWAY_SECRET/);
  assert.throws(() => createGatewayAuthentication({ production: true, env: { LOCAL_DEMO_ONLY: 'true', AUTH_GATEWAY_SECRET: secret } }), /LOCAL_DEMO_ONLY/);
  const auth = createGatewayAuthentication({ production: true, env: { AUTH_GATEWAY_SECRET: secret } });
  assert.throws(() => auth.authenticate(request({ 'x-agentic-user-id': 'alice', 'x-agentic-roles': 'admin' })), { code: 'AUTH_REQUIRED' });
  assert.throws(() => auth.authenticate(request({ ...headers, 'x-agentic-gateway-secret': 'x'.repeat(secret.length) })), { code: 'AUTH_REQUIRED' });
  assert.throws(() => auth.authenticate(request({ ...headers, 'x-agentic-user-id': 'alice,bob' })), { code: 'AUTH_REQUIRED' });
  assert.equal(auth.authenticate(request(headers)), 'alice');
  assert.equal(auth.authorizeAdmin(request({ ...headers, 'x-agentic-roles': 'not-admin' })), false);
  assert.equal(auth.authorizeAdmin(request({ ...headers, 'x-agentic-roles': 'reader,admin' })), true);
  const local = createGatewayAuthentication({ production: false, env: { LOCAL_DEMO_ONLY: 'true' } });
  assert.equal(local.authenticate(request()), 'local');
  assert.throws(() => local.authenticate(request({ 'x-forwarded-for': '127.0.0.1' }, '192.0.2.1')), { code: 'AUTH_REQUIRED' });
});

test('consumer never serves management/report files; admin HTML and assets both require authenticated admin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-entry-'));
  const consumer = join(root, 'dist'), admin = join(root, 'dist-admin');
  await mkdir(join(consumer, 'verification'), { recursive: true });
  await mkdir(join(consumer, 'assets'), { recursive: true });
  await mkdir(join(admin, 'assets'), { recursive: true });
  await writeFile(join(consumer, 'index.html'), 'consumer');
  await writeFile(join(consumer, 'verification', 'report.html'), 'private report');
  await writeFile(join(consumer, 'assets', 'app.js'), 'consumer bundle');
  await writeFile(join(admin, 'index.html'), 'admin');
  await writeFile(join(admin, 'assets', 'app.js'), 'admin bundle');
  const publicApp = express(), adminApp = express();
  const auth = createGatewayAuthentication({ production: true, env: { AUTH_GATEWAY_SECRET: secret } });
  adminApp.use(auth.requireAdmin);
  mountStaticApp(publicApp, consumer);
  mountStaticApp(adminApp, admin);
  const publicServer = publicApp.listen(0, '127.0.0.1'), adminServer = adminApp.listen(0, '127.0.0.1');
  await Promise.all([publicServer, adminServer].map(server => new Promise<void>(done => server.once('listening', done))));
  const url = (server: typeof publicServer) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await (await fetch(url(publicServer))).text(), 'consumer');
    assert.equal((await fetch(url(publicServer) + '/assets/app.js')).status, 200);
    for (const path of ['/verification/report.html', '/%76erification/report.html', '/admin', '/dist-admin/index.html', '/missing']) {
      assert.equal((await fetch(url(publicServer) + path)).status, 404, path);
    }
    for (const path of ['/', '/assets/app.js']) {
      for (const [requestHeaders, status] of [[{}, 401], [headers, 403], [{ ...headers, 'x-agentic-roles': 'admin' }, 200]] as const) {
        const response = await fetch(url(adminServer) + path, { headers: requestHeaders });
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
      }
    }
  } finally {
    await Promise.all([publicServer, adminServer].map(server => new Promise<void>((done, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : done()); })));
    await rm(root, { recursive: true, force: true });
  }
});
