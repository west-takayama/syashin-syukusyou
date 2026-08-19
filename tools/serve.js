#!/usr/bin/env node
/**
 * 動作確認用の静的ファイルサーバー（依存パッケージなし）。
 *   npm start -- --port 8080
 * 同じ Wi-Fi のスマホから開けるよう、LAN の IP も表示する。
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const portFlag = process.argv.indexOf('--port');
const port = Number(portFlag > -1 ? process.argv[portFlag + 1] : process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('404 Not Found');
    return;
  }
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((info) => info && info.family === 'IPv4' && !info.internal)
    .map((info) => `  http://${info.address}:${port}`);
  console.log(`写真圧縮ツールを配信中:\n  http://localhost:${port}`);
  if (addresses.length > 0) console.log(`同じ Wi-Fi のスマホから:\n${addresses.join('\n')}`);
});
