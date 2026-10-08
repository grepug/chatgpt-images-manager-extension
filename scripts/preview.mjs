import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { buildViewerMenu } from './build-ui.mjs';
await buildViewerMenu();
const root = resolve('extension');
const policy = JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8')).content_security_policy.extension_pages;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const path = resolve(root, `.${new URL(req.url, 'http://localhost').pathname === '/' ? '/library.html' : new URL(req.url, 'http://localhost').pathname}`);
  if (!path.startsWith(`${root}/`)) { res.writeHead(403).end(); return; }
  try { const content = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'text/plain', 'Cache-Control': 'no-store', 'Content-Security-Policy': policy }).end(content); }
  catch { res.writeHead(404).end(); }
}).listen(4173, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4173/library.html?preview=1 (test images only)'));
