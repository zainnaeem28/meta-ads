// Builds the two representative deliverables from rendered frames: png/UI-Mockups-Desktop.png (1440 px frames) and png/UI-Mockups-Mobile.png (390 px frames).
import { createRequire } from 'node:module'; import { createServer } from 'node:http'; import { readFile, writeFile } from 'node:fs/promises'; import { extname, resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const sets = {
  desktop: { width: 1440, scale: 0.4, crop: 900, cols: 3, frames: [['SCREEN-001--default', 'SCREEN-001 Sign in'], ['SCREEN-005--default', 'SCREEN-005 Campaigns (operator home)'], ['SCREEN-006--default', 'SCREEN-006 New brief wizard'], ['SCREEN-007--default', 'SCREEN-007 Brief review'], ['SCREEN-010--default', 'SCREEN-010 Provider keys'], ['SCREEN-011--default', 'SCREEN-011 Accounts (administration home)']] },
  mobile: { width: 390, scale: 0.75, crop: 844, cols: 4, frames: [['SCREEN-001--default', 'SCREEN-001 Sign in'], ['SCREEN-005--default', 'SCREEN-005 Campaigns'], ['SCREEN-006--step-3', 'SCREEN-006 New brief'], ['SCREEN-007--default', 'SCREEN-007 Brief'], ['SCREEN-008--default', 'SCREEN-008 Clips'], ['SCREEN-009--default', 'SCREEN-009 Final ad'], ['SCREEN-010--default', 'SCREEN-010 Provider keys'], ['SCREEN-011--default', 'SCREEN-011 Accounts']] },
};
const root = resolve('.'); const types = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.js': 'text/javascript' };
const s = createServer(async (q, r) => { const f = resolve(root, '.' + new URL(q.url, 'http://x').pathname); if (!f.startsWith(root + sep)) return r.writeHead(403).end(); try { r.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(await readFile(f)); } catch { r.writeHead(404).end(); } });
await new Promise((o) => s.listen(0, '127.0.0.1', o));
const b = await chromium.launch();
for (const [kind, c] of Object.entries(sets)) {
  const w = Math.round(c.width * c.scale), h = Math.round(c.crop * c.scale);
  const figs = c.frames.map(([f, cap]) => `<figure><div class="crop"><img src="/png/${f}--${c.width}.png" width="${w}" alt="${cap}"></div><figcaption>${cap}</figcaption></figure>`).join('');
  await writeFile(`png/_${kind}.html`, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css"><style>body{min-height:0;padding:32px;background:var(--muted)}h1{margin-bottom:24px}.g{display:grid;grid-template-columns:repeat(${c.cols},${w}px);gap:24px}figure{margin:0}.crop{width:${w}px;height:${h}px;overflow:hidden;border:1px solid var(--border-strong);border-radius:8px;background:var(--card)}figcaption{font-size:14px;margin-top:8px;font-weight:600}</style><h1>ShrooMap AI UGC Ad Director: proposed UI mockups (${kind}, ${c.width} px). Design evidence, not product screenshots.</h1><div class="g">${figs}</div>`);
  const p = await b.newPage({ viewport: { width: c.cols * w + (c.cols - 1) * 24 + 64, height: 900 } });
  await p.goto(`http://127.0.0.1:${s.address().port}/png/_${kind}.html`, { waitUntil: 'networkidle' }); await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `png/UI-Mockups-${kind === 'desktop' ? 'Desktop' : 'Mobile'}.png`, fullPage: true }); await p.close();
}
await b.close(); s.close(); console.log('overviews written');
