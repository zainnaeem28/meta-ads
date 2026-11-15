// Render every frame × state × width in frames.json to png/ (design/mockups/frames/*.html -> png/<id>--<state>--<width>.png).
// Usage: NODE_PATH=<folder with playwright>/node_modules node render-frames.mjs "Inter" [frameId ...]
// Serves this folder on loopback and aborts every other request. Fails on network use, missing files, script errors,
// a missing brand font, or horizontal overflow. Also writes png/manifest.json (SHA-256) and overview sheets.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const font = process.argv[2] ?? 'Inter';
const only = process.argv.slice(3);
const root = resolve('.');
const heights = { 390: 844, 768: 1024, 1440: 900 };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const frames = JSON.parse(await readFile('frames.json', 'utf8')).filter((f) => !only.length || only.includes(f.id));
const browser = await chromium.launch();
const problems = [];
const manifest = [];
await mkdir('png', { recursive: true });

for (const frame of frames) for (const state of frame.states) for (const width of frame.widths) {
  const name = `${frame.id}--${state}--${width}`;
  const page = await browser.newPage({ viewport: { width, height: heights[width] ?? 900 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*', (r) => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  page.on('requestfailed', (r) => problems.push(`${name}: request failed ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${name}: HTTP ${r.status()} ${r.url()}`));
  page.on('pageerror', (e) => problems.push(`${name}: script error ${e.message}`));
  await page.goto(`${origin}/${frame.file}?state=${encodeURIComponent(state)}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const fontLoaded = await page.evaluate((f) => [...document.fonts].some((face) => face.family.replace(/["']/g, '') === f && face.status === 'loaded'), font);
  if (!fontLoaded) problems.push(`${name}: font "${font}" not loaded`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push(`${name}: horizontal overflow of ${overflow}px`);
  const path = `png/${name}.png`;
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  manifest.push({ frame: name, screen: frame.id, state, width, file: path, sha256 });
  await page.close();
}

if (!only.length) {
  for (const [kind, width, scale] of [['desktop', 1440, 0.3], ['mobile', 390, 0.6]]) {
    const shots = manifest.filter((m) => m.width === width);
    for (let i = 0; i < shots.length; i += 12) {
      const figures = shots.slice(i, i + 12).map((m) => `<figure><img src="/${m.file}" width="${Math.round(width * scale)}" alt=""><figcaption>${m.frame}</figcaption></figure>`).join('');
      const sheet = `png/overview-${kind}-${i / 12 + 1}`;
      await writeFile(`${sheet}.html`, `<!doctype html><meta charset="utf-8"><style>body{margin:16px;font:12px sans-serif;display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}figure{margin:0}img{display:block;border:1px solid #ccc}</style>${figures}`);
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
      await page.goto(`${origin}/${sheet}.html`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: `${sheet}.png`, fullPage: true });
      await page.close();
    }
  }
  await writeFile('png/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
}
await browser.close();
server.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Rendered ${manifest.length} frames without problems.`);
