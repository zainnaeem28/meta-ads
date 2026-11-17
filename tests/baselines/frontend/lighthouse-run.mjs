#!/usr/bin/env node
/* global process, fetch, setTimeout, clearTimeout */
// Lighthouse CI on the built web app: mobile and desktop presets, SAMPLES cold runs per route, performance category only.
//   lighthouse-run.mjs --state STATE.json --out FILE [--samples N]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselinePolicy } from '../lib/policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { chromium } = createRequire(join(root, 'apps', 'web', 'package.json'))('@playwright/test');
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const state = JSON.parse(readFileSync(arg('state'), 'utf8'));
const fe = baselinePolicy().baselines.frontend;
const samples = Number(arg('samples') ?? fe.samplesPerRoute);
const tools = process.env.CI_TOOLS_DIR ?? join(process.env.HOME, '.cache', 'shroomap-ci-tools');
const lighthouse = join(tools, 'lighthouse', 'node_modules', '.bin', 'lighthouse');
const chrome = chromium.executablePath();

const list = await fetch(`${state.apiUrl}/api/v1/campaigns?limit=1`, {
  headers: { Authorization: `Bearer ${state.users[1].token}` },
});
const campaign = (await list.json()).data?.[0]?.id;
const cookieFor = (kind) =>
  kind === 'admin' ? state.admin.cookie : kind === 'user' ? state.users[1].cookie : null;
const work = mkdtempSync(join(tmpdir(), 'lh-'));
const concurrency = Number(process.env.BASELINE_CONCURRENCY ?? 2);
const result = {
  tool: 'Lighthouse',
  toolVersion: null,
  browser: null,
  concurrency,
  requested: samples,
  host: { cpus: cpus().length, loadStart: loadavg()[0] },
  samples: [],
};

const tasks = [];
for (const route of fe.routes) {
  const url = `${state.webUrl}${route.path.replace('{campaign}', campaign)}`;
  const cookie = cookieFor(route.session);
  const headers = join(work, `headers-${route.id}.json`);
  writeFileSync(
    headers,
    JSON.stringify(cookie ? { Cookie: `shroomap_local_session=${cookie}` } : {}),
  );
  for (const profile of fe.profiles)
    for (let n = 1; n <= samples; n += 1) tasks.push({ route, url, headers, profile, n });
}

// One headless Chrome per worker (remote debugging port), reused between that worker's runs; Lighthouse clears the
// cache and storage before each run, so every sample is a cold load.
const worker = async (slot) => {
  const port = 9400 + slot + (process.pid % 300);
  const chromeProc = spawn(
    chrome,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(work, `profile-${slot}`)}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await new Promise((r) => setTimeout(r, 2500));
  try {
    for (;;) {
      const task = tasks.shift();
      if (!task) return;
      // A run the tool could not complete (protocol timeout, nothing painted on a busy shared host) is repeated up to
      // twice; only a sample that never completes is recorded with its error and counted as not valid.
      let record = await runAsync(task, port, slot);
      for (let retry = 1; record.error && retry <= 2; retry += 1) record = await runAsync(task, port, slot);
      result.samples.push(record);
    }
  } finally {
    chromeProc.kill('SIGKILL');
  }
};

const runAsync = (task, port, slot) =>
  new Promise((done) => {
    const outFile = join(work, `run-${slot}-${task.route.id}-${task.profile}-${task.n}.json`);
    const args = [
      task.url,
      `--port=${port}`,
      '--output=json',
      `--output-path=${outFile}`,
      '--only-categories=performance',
      '--quiet',
      `--extra-headers=${task.headers}`,
    ];
    if (task.profile === 'desktop') args.push('--preset=desktop');
    const child = spawn(lighthouse, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const record = {
        route: task.route.id,
        profile: task.profile,
        sample: task.n,
        lcpMs: null,
        cls: null,
        tbtMs: null,
      };
      if (code !== 0) {
        record.error = (err || 'lighthouse failed').slice(-200);
        return done(record);
      }
      const lhr = JSON.parse(readFileSync(outFile, 'utf8'));
      result.toolVersion = lhr.lighthouseVersion;
      result.browser = lhr.environment?.hostUserAgent ?? null;
      record.finalPath = new URL(lhr.finalDisplayedUrl).pathname;
      record.lcpMs = lhr.audits['largest-contentful-paint']?.numericValue ?? null;
      record.cls = lhr.audits['cumulative-layout-shift']?.numericValue ?? null;
      record.tbtMs = lhr.audits['total-blocking-time']?.numericValue ?? null;
      record.runWarnings = lhr.runWarnings?.length ?? 0;
      done(record);
    });
  });

await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)));
rmSync(work, { recursive: true, force: true });
result.host.loadEnd = loadavg()[0];
writeFileSync(arg('out'), JSON.stringify(result, null, 2));
process.stdout.write(`lighthouse: ${result.samples.length} runs\n`);
