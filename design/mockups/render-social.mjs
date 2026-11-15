// Renders the 1200x630 social preview from frames/BRAND-social-preview.html to ../brand/icons/social-preview.png
import { createRequire } from 'node:module'; import { createServer } from 'node:http'; import { readFile } from 'node:fs/promises'; import { extname, resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = resolve('.'); const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const s = createServer(async (q, r) => { const f = resolve(root, '.' + new URL(q.url, 'http://x').pathname); if (!f.startsWith(root + sep)) return r.writeHead(403).end(); try { r.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(await readFile(f)); } catch { r.writeHead(404).end(); } });
await new Promise((o) => s.listen(0, '127.0.0.1', o));
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.goto(`http://127.0.0.1:${s.address().port}/frames/BRAND-social-preview.html`, { waitUntil: 'networkidle' }); await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: '../brand/icons/social-preview.png' }); await b.close(); s.close(); console.log('social preview written');
