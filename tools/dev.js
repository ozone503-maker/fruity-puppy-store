// Local preview server: static public/ plus api/*.js handlers. node tools/dev.js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = new URL('../public/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname.replace(/^\/store(?=\/|$)/, '') || '/';
  const prod = path.match(/^\/product\/([^/]+)\/?$/);
  if (prod) { path = '/api/product'; url.searchParams.set('id', prod[1]); }
  if (path.startsWith('/api/')) {
    try {
      const mod = await import(`../api/${path.slice(5)}.js`);
      const handler = mod[req.method];
      if (!handler) { res.writeHead(405).end(); return; }
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
      const r = await handler(new Request(`http://localhost${path}?${url.searchParams}`, { method: req.method, headers: req.headers, body }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(500).end(String(e.message)); }
    return;
  }
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (path.endsWith('/')) file = join(file, 'index.html');
  // Read before writing headers, so a missing file is a 404 instead of a crash.
  try { const data = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(data); }
  catch { try { const data = await readFile(join(file, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html' }).end(data); } catch { res.writeHead(404).end('Not found'); } }
}).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000) + '/store/'));
