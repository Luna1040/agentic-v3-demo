import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express } from 'express';

/** Each listener owns one build root. Private reports are never web assets. */
export function mountStaticApp(app: Express, directory: string) {
  if (!existsSync(resolve(directory, 'index.html'))) throw new Error('前端构建缺失。');
  app.use((request, response, next) => {
    let path: string;
    try { path = decodeURIComponent(request.path); }
    catch { response.sendStatus(400); return; }
    if (path.split('/').some(part => ['verification', 'dist-admin', 'admin'].includes(part))) {
      response.sendStatus(404); return;
    }
    next();
  });
  app.use(express.static(directory, { dotfiles: 'deny', redirect: false }));
  app.use((_request, response) => { response.sendStatus(404); });
}
