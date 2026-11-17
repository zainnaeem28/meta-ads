#!/usr/bin/env node
// Playwright web-vitals of the built web app (QUALITY-RELEASE-PLAN sections 6 and 7): LCP, CLS and INP per route and
// profile, SAMPLES cold loads each, with the conditions fixed and recorded. INP is the longest interaction after load
// (two key presses and a click on the page body). The Event Timing API reports only interactions of 16 ms or more, so a
// sample with inputs sent and none reported has an INP of at most 16 ms: it is recorded as null (not observed, never 0)
// and judged by the evaluator as "below the reporting threshold".
//   web-vitals.mjs --state STATE.json --out FILE [--samples N] [--smoke]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const { baselines } = baselinePolicy();
const fe = baselines.frontend;
const samples = Number(arg('samples') ?? fe.samplesPerRoute);

const PROFILES = {
  // Same conditions as the Lighthouse presets, so the two tools measure the same thing.
  mobile: { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true, cpu: 4, rttMs: 150, downKbps: 1638.4, upKbps: 750 },
  desktop: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpu: 1, rttMs: 40, downKbps: 10240, upKbps: 10240 },
};

const observer = `
  window.__vitals = { lcp: null, cls: 0, inp: null, events: [] };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__vitals.lcp = e.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  let session = { value: 0, first: 0, last: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      if (session.value && e.startTime - session.last < 1000 && e.startTime - session.first < 5000) { session.value += e.value; }
      else { session = { value: e.value, first: e.startTime, last: e.startTime }; }
      session.last = e.startTime;
      window.__vitals.cls = Math.max(window.__vitals.cls, session.value);
    }
  }).observe({ type: 'layout-shift', buffered: true });
  const interactions = new Map();
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.interactionId) continue;
      interactions.set(e.interactionId, Math.max(interactions.get(e.interactionId) ?? 0, e.duration));
      window.__vitals.inp = Math.max(...interactions.values());
    }
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
`;

async function resolveRoutes() {
  const account = state.users[1];
  const list = await fetch(`${state.apiUrl}/api/v1/campaigns?limit=1`, { headers: { Authorization: `Bearer ${account.token}` } });
  const campaign = (await list.json()).data?.[0]?.id;
  if (!campaign) throw new Error('the baseline dataset has no campaign for the signed-in routes');
  return fe.routes.map((r) => ({ ...r, url: `${state.webUrl}${r.path.replace('{campaign}', campaign)}` }));
}

const sessionCookie = (kind) => (kind === 'admin' ? state.admin.cookie : kind === 'user' ? state.users[1].cookie : null);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const out = { tool: 'Playwright web-vitals', browser: `Chromium ${browser.version()}`, conditions: {}, samples: [] };
for (const [name, p] of Object.entries(PROFILES)) {
  out.conditions[name] = { viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, cpuSlowdown: p.cpu, rttMs: p.rttMs, downKbps: p.downKbps, upKbps: p.upKbps, cache: 'cold (fresh context per sample)', dataSet: 'baseline dataset (25 accounts, 125 stub jobs)' };
}
const routes = await resolveRoutes();
const concurrency = Number(process.env.BASELINE_CONCURRENCY ?? 2);
out.concurrency = concurrency;
out.requested = samples;

async function measure(route, profile, n) {
  const p = PROFILES[profile];
  const context = await browser.newContext({ viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, isMobile: p.isMobile, hasTouch: p.hasTouch, reducedMotion: 'no-preference' });
  const cookie = sessionCookie(route.session);
  if (cookie) await context.addCookies([{ name: 'shroomap_local_session', value: cookie, url: state.webUrl }]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: p.rttMs, downloadThroughput: (p.downKbps * 1024) / 8, uploadThroughput: (p.upKbps * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
  await page.addInitScript(observer);
  let record = { route: route.id, profile, sample: n, status: null, lcpMs: null, cls: null, inpMs: null };
  try {
    const response = await page.goto(route.url, { waitUntil: 'load', timeout: 60_000 });
    record.status = response?.status() ?? null;
    record.finalPath = new URL(page.url()).pathname;
    await page.waitForTimeout(2500);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.mouse.click(Math.floor(p.viewport.width / 2), Math.floor(p.viewport.height / 2));
    await page.waitForTimeout(800);
    const v = await page.evaluate(() => window.__vitals);
    record = { ...record, lcpMs: v.lcp, cls: v.cls, inpMs: v.inp, inputs: 3 }; // 2 key presses and a click were sent
  } catch (error) {
    record.error = String(error.message ?? error).slice(0, 200);
  }
  await context.close();
  return record;
}

const queue = [];
for (const route of routes) for (const profile of fe.profiles) for (let n = 1; n <= samples; n += 1) queue.push([route, profile, n]);
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) out.samples.push(await measure(...job));
  }),
);
await browser.close();
writeFileSync(arg('out'), JSON.stringify(out, null, 2));
process.stdout.write(`web-vitals: ${out.samples.length} samples\n`);
