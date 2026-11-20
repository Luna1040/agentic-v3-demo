import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../server/app.ts';
import { createGatewayAuthentication } from '../server/auth.ts';
import { createPreviewFixture } from './preview-fixture.ts';

if (process.env.NODE_ENV === 'production') throw new Error('本地预览不能用于生产环境。');

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = createPreviewFixture();
const auth = createGatewayAuthentication({ production: false, env: { LOCAL_DEMO_ONLY: 'true' } });
const cleanups: Array<() => Promise<void>> = [];
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled(cleanups.map(cleanup => cleanup()));
}

try {
  for (const [audience, port] of [['consumer', 7633], ['admin', 7634]] as const) {
    const app = createApp({
      store: fixture.store, runtime: fixture.runtime, audience, authenticate: auth.authenticate,
      ...(audience === 'admin' ? { developer: {
        authorize: auth.authorizeAdmin, defaultPrompts: fixture.defaultPrompts, buildRuntime: fixture.buildRuntime,
      } } : {}),
    });
    const server = createHttpServer(app);
    cleanups.push(async () => { server.close(); await app.locals.shutdown(); server.closeAllConnections(); });
    if (audience === 'admin') app.use(auth.requireAdmin);
    const vite = await createViteServer({
      configFile: root + 'vite.config.ts', mode: audience === 'admin' ? 'admin' : 'development',
      cacheDir: root + 'node_modules/.vite-preview-' + audience,
      server: { middlewareMode: true, hmr: { server } }, appType: 'spa',
      plugins: [{ name: 'local-preview-label', transformIndexHtml: () => [{
        tag: 'style', children: 'body #root .agentic-app{height:calc(100dvh - 34px)}', injectTo: 'head',
      }, {
        tag: 'div', attrs: { role: 'status', style: 'height:34px;display:flex;align-items:center;justify-content:center;background:#fff2ce;color:#614711;font:12px system-ui' },
        children: '本地预览 · 固定演示回复 · 数据仅存内存，重启后清空', injectTo: 'body-prepend',
      }] }],
    });
    cleanups.push(() => vite.close());
    app.use(vite.middlewares);
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
    console.log(`${audience === 'consumer' ? 'C 端' : '管理端'}预览：http://127.0.0.1:${port}`);
  }
  console.log('仅本机预览：未连接数据库、Harness 或真实模型。刷新页面查看前端修改。');
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
} catch (error) {
  await shutdown();
  throw error;
}
