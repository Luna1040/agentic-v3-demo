import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig(({ mode }) => {
  const admin = mode === 'admin';
  return {
    root: fileURLToPath(new URL(admin ? './web/admin' : './web', import.meta.url)),
    server: { fs: {
      allow: ['./web', './shared', './node_modules'].map(path => fileURLToPath(new URL(path, import.meta.url))),
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...admin ? [] : [fileURLToPath(new URL('./web/admin/**', import.meta.url))]],
    } },
    plugins: [react(), ...admin ? [] : [{
      name: 'consumer-module-boundary',
      generateBundle(_options: unknown, bundle: Record<string, { type: string; modules?: Record<string, unknown> }>) {
        for (const chunk of Object.values(bundle)) for (const id of Object.keys(chunk.modules || {})) {
          if (/[/\\](?:web[/\\]admin|server)[/\\]/.test(id)) throw new Error('Consumer build imported a private module: ' + id);
        }
      },
    }]],
    build: { outDir: admin ? '../../dist-admin' : '../dist', emptyOutDir: true, sourcemap: false },
  };
});
