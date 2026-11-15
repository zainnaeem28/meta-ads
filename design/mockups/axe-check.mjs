// Runs axe-core on every frame x state x width in frames.json. Usage: node axe-check.mjs  -> png/axe-report.json
import { createRequire } from 'node:module'; import { createServer } from 'node:http'; import { readFile, writeFile } from 'node:fs/promises'; import { extname, resolve, sep } from 'node:path';
const require = createRequire(import.meta.url); const { chromium } = require('playwright'); const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const root = resolve('.'); const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const s = createServer(async (q, r) => { const f = resolve(root, '.' + new URL(q.url, 'http://x').pathname); if (!f.startsWith(root + sep)) return r.writeHead(403).end(); try { r.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(await readFile(f)); } catch { r.writeHead(404).end(); } });
await new Promise((o) => s.listen(0, '127.0.0.1', o)); const b = await chromium.launch(); const out = [];
for (const fr of JSON.parse(await readFile('frames.json', 'utf8'))) for (const st of fr.states) for (const w of fr.widths) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } }); await p.goto(`http://127.0.0.1:${s.address().port}/${fr.file}?state=${st}`, { waitUntil: 'networkidle' }); await p.evaluate(() => document.fonts.ready);
  await p.evaluate(axeSource);
  const res = await p.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0].target.join(' ') }))));
  out.push({ frame: `${fr.id}--${st}--${w}`, violations: res }); await p.close();
}
await b.close(); s.close(); await writeFile('png/axe-report.json', JSON.stringify(out, null, 1));
const agg = {}; for (const o of out) for (const v of o.violations) { agg[v.id] = agg[v.id] || { impact: v.impact, frames: 0, sample: o.frame + ' ' + v.sample }; agg[v.id].frames++; }
console.log(out.length, 'frames checked;', out.filter((o) => o.violations.length).length, 'with violations'); console.log(JSON.stringify(agg, null, 1));
