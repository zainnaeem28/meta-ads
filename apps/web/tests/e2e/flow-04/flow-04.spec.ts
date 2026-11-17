import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';
import {
  CAMPAIGN_ID,
  assemblyFixture,
  campaignFixture,
  item,
  jobId,
  mediaId,
  meta,
  qcRun,
  videoJob,
} from '../../../src/features/fe-screen-009a/fixtures';
import type { Assembly } from '@shroomap/contracts';

// TC-FLW-04 (FLOW-04, J-04): SCREEN-008 to SCREEN-009 (select, order, confirm one failed QC clip, assemble, download a
// playable final), through the built web app (`next start`) and the built api.
// The signed-in api answers are a labelled contract mock (API-050, 061, 070, 071, 032 shapes, taken from the screens'
// own contract fixtures): the built web sends no bearer without an identity provider and the api's local identity mints
// tokens only in-process, so no operator token exists out of process, and the worker, MinIO and the provider stubs are not
// reachable through an unauthenticated api. The 401 steps are the real api. The final file is real: the three clips and the
// assembled final are made by the real FFmpeg (the concat of the clips in the order the page sent), served as the media
// link, played by the browser and downloaded. No mock answer is invented; the FFmpeg run is the test's, not the worker's.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-107';
const FINAL_URL = `/campaigns/${CAMPAIGN_ID}/final`;
const CLIPS_URL = `/campaigns/${CAMPAIGN_ID}/clips`;
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FINAL_MEDIA = mediaId(9);

/** Three one-second clips of different lengths in frames and the final the FFmpeg concat makes from them in `order`. */
function makeFinal(order: number[]): { file: string; seconds: number } {
  const dir = mkdtempSync(join(tmpdir(), 'flow04-'));
  const run = (args: string[]) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const clips = [1, 2, 3].map((n) => {
    const file = join(dir, `clip-${n}.webm`);
    run(['-f', 'lavfi', '-i', `testsrc=duration=1:size=320x180:rate=10`, '-f', 'lavfi', '-i', `sine=frequency=${200 * n}:duration=1`, '-c:v', 'libvpx', '-c:a', 'libvorbis', '-shortest', file]);
    return file;
  });
  const file = join(dir, 'final.webm');
  const inputs = order.flatMap((n) => ['-i', clips[n - 1]!]);
  const graph = `${order.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${order.length}:v=1:a=1[v][a]`;
  run([...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-c:v', 'libvpx', '-c:a', 'libvorbis', file]);
  expect(statSync(file).size).toBeGreaterThan(1000);
  return { file, seconds: order.length };
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
const ok = (data: unknown, status = 200): Answer => ({
  status,
  headers: { etag: '"v1"' },
  body: { success: true, data, metaData: meta },
});
const failure = (status: number, code: string, message = 'Refused.'): Answer => ({
  status, body: { success: false, error: { code, message, details: [] }, metaData: meta },
});
const keyRows = () =>
  ['openai', 'wavespeed'].map((provider) => ({
    provider, configured: true, status: 'active', last4: null, fingerprint: null, version: 1, createdAt: null, updatedAt: null, lastValidatedAt: null, inFlightJobCount: 0,
  }));

/** Segment 2 failed its audio check; the others passed. */
const clipList = () => [
  item(1, videoJob(1)),
  item(2, videoJob(2, { latestQc: qcRun(2, { qcState: 'failed', reason: 'speech did not match the script' }) })),
  item(3, videoJob(3)),
];

interface World {
  /** What the next assembly request does: finish, end failed (once), or be refused. */
  assemble: 'ok' | 'fail-once' | 'daily-limit' | 'unauthenticated' | 'qc-changed';
  /** Assembly reads answered in progress before the terminal one. */
  progressReads: number;
  created: Assembly | null;
  body: { clips: string[]; confirmations?: { qcOverride: string[] } }[];
  /** The assembly the campaign already has when the page opens (an out-of-date final, a failed one). */
  existing: Assembly | null;
  media: 'ok' | 'not_ready';
  unavailable: boolean;
  /** Set when the campaign's `latestAssemblyId` should point to the created assembly. */
  calls: string[];
  list: ReturnType<typeof clipList>;
  final: { file: string; seconds: number } | null;
  failedOnce: boolean;
  reads: number;
}
const world = (over: Partial<World> = {}): World => ({
  assemble: 'ok', progressReads: 2, created: null, body: [], existing: null, media: 'ok', unavailable: false, calls: [], list: clipList(), final: null, failedOnce: false, reads: 0, ...over,
});

const current = (w: World) => w.created ?? w.existing;

function answer(w: World, method: string, path: string, body: unknown): Answer | 'media' {
  if (w.unavailable && path.startsWith('/campaigns/')) return failure(404, 'not_found');
  if (method === 'GET' && path === '/me/provider-keys') return ok(keyRows());
  if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}`) {
    return ok(campaignFixture({ latestAssemblyId: current(w)?.id ?? null, finalAvailable: current(w)?.state === 'done' }));
  }
  if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/video-jobs`) return ok(w.list);
  if (method === 'POST' && path === `/campaigns/${CAMPAIGN_ID}/assemblies`) {
    const req = body as World['body'][number];
    w.body.push(req);
    if (w.assemble === 'unauthenticated') return failure(401, 'unauthenticated');
    if (w.assemble === 'daily-limit') return failure(429, 'assembly_daily_limit');
    if (w.assemble === 'qc-changed') {
      // The checks changed after the page loaded: segment 3 now failed too, and the request carried no confirmation for it.
      w.assemble = 'ok';
      w.list = [w.list[0]!, w.list[1]!, item(3, videoJob(3, { latestQc: qcRun(3, { qcState: 'skipped', reason: 'The audio service did not answer.' }) }))];
      return failure(422, 'qc_confirmation_required', 'Segment 3 failed its check.');
    }
    // The server rule (API-070): a failed or skipped QC clip needs its confirmation in the same request.
    const needs = w.list.filter((i) => ['failed', 'skipped'].includes(i.latestJob?.latestQc?.qcState ?? '') && req.clips.includes(i.latestJob!.id));
    const confirmed = req.confirmations?.qcOverride ?? [];
    if (needs.some((i) => !confirmed.includes(i.latestJob!.id))) return failure(422, 'qc_confirmation_required', 'A clip needs confirmation.');
    w.reads = 0;
    w.created = assemblyFixture('queued', {
      clips: req.clips.map((id, index) => ({ position: index + 1, videoJobId: id, outOfDate: false, qcOverrideConfirmed: confirmed.includes(id) })),
    });
    w.final = null;
    return ok(w.created, 202);
  }
  if (method === 'GET' && path === `/assemblies/${current(w)?.id}`) {
    const a = current(w)!;
    if (w.created && a === w.created) {
      w.reads += 1;
      if (w.reads <= w.progressReads) return ok({ ...a, state: w.reads === 1 ? 'queued' : 'rendering' });
      if (w.assemble === 'fail-once' && !w.failedOnce) {
        w.failedOnce = true;
        return ok({ ...a, state: 'failed', causeClass: 'input_unavailable', causeMessage: 'One selected clip could not be fetched from storage (segment 3).' });
      }
      // The real FFmpeg assembles the clips in the order the page sent.
      const order = a.clips.map((c) => Number(c.videoJobId.slice(-1)));
      w.final ??= makeFinal(order);
      w.created = { ...a, state: 'done', outputMediaId: FINAL_MEDIA };
      return ok(w.created);
    }
    return ok(a);
  }
  if (method === 'GET' && path === `/media/${FINAL_MEDIA}/url`) {
    if (w.media === 'not_ready') return failure(409, 'media_not_ready');
    return ok({ url: `${process.env.E2E_STORAGE_URL}/final.webm`, expiresAt: '2026-11-17T09:05:00Z' });
  }
  return failure(404, 'not_found');
}

const signedIn = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([{
    name: LOCAL_SESSION_COOKIE,
    value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp: Math.floor(Date.now() / 1000) + 600 }),
    url: baseURL,
  }]);

/** Relays the browser's api calls with CORS headers and answers each from `w`, or from the running api when `real`. */
async function api(page: Page, w: World, real = false) {
  const origin = process.env.E2E_API_URL!;
  // The storage origin the signed media link points at (the page's CSP allows exactly this origin): the real FFmpeg's file.
  await page.route(`${process.env.E2E_STORAGE_URL}/**`, async (route) => {
    w.calls.push('GET storage/final.webm');
    expect(w.final, 'the final was assembled before it was fetched').not.toBeNull();
    const cors = { 'access-control-allow-origin': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'content-disposition': 'attachment; filename="final-ad.webm"' },
      contentType: 'video/webm',
      body: readFileSync(w.final!.file),
    });
  });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*', 'access-control-allow-methods': '*' } });
    }
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    w.calls.push(`${request.method()} ${path}`);
    const a = real ? 'real' : answer(w, request.method(), path, request.method() === 'GET' ? null : request.postDataJSON());
    if (a === 'real') {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    }
    return route.fulfill({ status: (a as Answer).status, headers: { ...cors, ...((a as Answer).headers ?? {}) }, contentType: 'application/json', body: JSON.stringify((a as Answer).body) });
  });
}

const VIEWPORTS = [{ name: '390', width: 390, height: 844 }, { name: '1440', width: 1440, height: 900 }] as const;
const shape = (calls: string[]) => [...new Set(calls.map((c) => c.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')))];

const assembleButton = (page: Page) => page.getByRole('button', { name: 'Assemble final ad' });
const finalReady = (page: Page) => expect(page.getByRole('heading', { level: 2, name: 'Final ad', exact: true })).toBeVisible({ timeout: 25_000 });

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`@TASK-107 @TC-FLW-04 FLOW-04 assemble and download the final at ${name} px`, () => {
    test.use({ viewport: { width, height }, acceptDownloads: true });
    test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

    const shot = async (page: Page, label: string) => {
      await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await Promise.all(['400', '500', '600', '700'].map((x) => document.fonts.load(`${x} 16px Inter`)));
        await document.fonts.ready;
      });
      await expectNoAxeViolations(page, `${evidence}/axe/${label}-${name}.json`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      // The fixed bottom navigation of the phone layout would hide content in a full-page capture; it is hidden for the picture only.
      const hide = await page.addStyleTag({ content: '.fixed { visibility: hidden !important; }' });
      await page.screenshot({ path: `${evidence}/screenshots/${label}-${name}.png`, fullPage: true });
      await hide.evaluate((el) => el.remove());
    };
    const playable = async (page: Page, seconds: number) => {
      const video = page.locator('video');
      await expect(video).toHaveCount(1);
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
      expect(Math.abs(duration - seconds)).toBeLessThan(0.5);
      expect(await video.evaluate((v: HTMLVideoElement) => v.error)).toBeNull();
    };

    test('the whole journey: select, order, confirm the failed QC clip, assemble with the real FFmpeg, play and download', async ({ page }) => {
      const w = world();
      await api(page, w);

      // 1. SCREEN-009 from SCREEN-008's tab: the completed clips, the failed check named, nothing sent yet.
      await page.goto(FINAL_URL);
      await expect(page.getByRole('heading', { level: 2, name: 'Choose and order clips' })).toBeVisible();
      await expect(page.getByText('1 selected clip has a failed or skipped audio check.')).toBeVisible();
      await expect(page.getByRole('checkbox')).toHaveCount(3);
      await shot(page, '1-select');

      // 2. Order: move segment 3 above segment 2; the page announces it and keeps the order.
      await page.getByRole('button', { name: 'Move segment 3 up' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Segment 3 moved to position 2.' })).toHaveCount(1);
      const order = await page.getByRole('list', { name: 'Clips for the final ad' }).getByRole('checkbox').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).labels?.[0]?.textContent?.trim().slice(0, 9)));
      expect(order).toEqual(['Segment 1', 'Segment 3', 'Segment 2']);
      await shot(page, '2-ordered');

      // 3. Assemble asks for the failed clip's confirmation first; Go back sends nothing, and an unticked box is refused.
      await assembleButton(page).click();
      const dialog = page.getByRole('dialog', { name: 'Assemble with audio checks that did not pass?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Segment 2 failed its audio check (speech did not match the script).')).toBeVisible();
      await shot(page, '3-qc-confirm');
      await dialog.getByRole('button', { name: 'Go back' }).click();
      await expect(dialog).toBeHidden();
      expect(w.calls.filter((c) => c.endsWith('/assemblies'))).toEqual([]);
      await assembleButton(page).click();
      await dialog.getByRole('button', { name: 'Assemble anyway' }).click();
      await expect(dialog.getByText('Tick the box to confirm that you have reviewed these clips.')).toBeVisible();
      expect(w.calls.filter((c) => c.endsWith('/assemblies'))).toEqual([]);
      await shot(page, '4-qc-unticked');

      // 4. Confirmed: one request with the chosen order and the override of exactly the failed clip.
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Assemble anyway' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Assembling your final ad' })).toBeVisible();
      await shot(page, '5-assembling');
      expect(w.body).toEqual([{ clips: [jobId(1), jobId(3), jobId(2)], confirmations: { qcOverride: [jobId(2)] } }]);

      // 5. The real FFmpeg assembled the final: it plays, its length is the three clips', and Download hands over the file.
      await finalReady(page);
      await expect(page.getByText('QC confirmed by you')).toHaveCount(1);
      await playable(page, 3);
      await shot(page, '6-final-ready');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
      expect(download.suggestedFilename()).toBe('final-ad.webm');
      const saved = await download.path();
      expect(readFileSync(saved).equals(readFileSync(w.final!.file))).toBe(true);
      expect(w.final!.seconds).toBe(3);

      // 6. Back returns to a state the page can show again (the assembly is read from the campaign, not lost).
      await page.getByRole('tab', { name: '2 Clips' }).click();
      await page.waitForURL(`**${CLIPS_URL}`);
      await page.goBack();
      await finalReady(page);

      const sent = shape(w.calls);
      for (const call of ['GET /campaigns/:id/video-jobs', 'POST /campaigns/:id/assemblies', 'GET /assemblies/:id', 'GET /media/:id/url', 'GET storage/final.webm']) expect(sent).toContain(call);
    });

    // Mismatch found by this flow (SCREEN-009 done state, TASK-097): the api numbers an assembly's clips by their place in the
    // final (assemblies.service `position: index + 1`), while "Clips used" prints that number as "Segment N". After a reorder the
    // confirmation badge lands on the wrong segment. Expected to fail until TASK-097's screen maps the clip to its segment; the
    // annotation makes the suite flag it the day it is fixed.
    test('known defect: after a reorder, Clips used names the segment that carries the QC confirmation', async ({ page }) => {
      test.fail(true, 'Clips used labels the assembly position as the segment number (owned by TASK-097)');
      const w = world();
      await api(page, w);
      await page.goto(FINAL_URL);
      await page.getByRole('button', { name: 'Move segment 3 up' }).click();
      await assembleButton(page).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Assemble anyway' }).click();
      await finalReady(page);
      const used = page.getByRole('list').filter({ hasText: 'QC confirmed by you' });
      await expect(used.getByRole('listitem').filter({ hasText: 'QC confirmed by you' })).toContainText('Segment 2', { timeout: 3000 });
    });

    test('a failed assembly shows its cause and Assemble again; the retry assembles with the same clips and confirmation', async ({ page }) => {
      const w = world({ assemble: 'fail-once', progressReads: 1 });
      await api(page, w);
      await page.goto(FINAL_URL);
      await page.getByRole('button', { name: 'Move segment 3 up' }).click();
      await assembleButton(page).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Assemble anyway' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Assembly failed' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('One selected clip could not be fetched from storage (segment 3).')).toBeVisible();
      // A failure is never shown as a final: no player, no Download.
      await expect(page.locator('video')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
      await shot(page, '7-assembly-failed');
      await page.getByRole('button', { name: 'Assemble again' }).click();
      await finalReady(page);
      await playable(page, 3);
      expect(w.body).toHaveLength(2);
      expect(w.body[1]).toEqual(w.body[0]);
      await shot(page, '8-retry-assembled');
    });

    test('QC results changed under the page: the api refuses, the page reads the checks again and asks for the confirmation on what they are now', async ({ page }) => {
      const w = world({ assemble: 'qc-changed', list: [item(1, videoJob(1)), item(2, videoJob(2)), item(3, videoJob(3))] });
      await api(page, w);
      await page.goto(FINAL_URL);
      // The page loaded all three clips as passed, so no confirmation was asked in advance.
      await expect(page.getByText(/audio check\. You will be asked to confirm/)).toHaveCount(0);
      await assembleButton(page).click();
      const dialog = page.getByRole('dialog', { name: 'Confirm clips that did not pass the check' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Segment 3: check skipped, the audio service did not answer')).toBeVisible();
      await shot(page, '9-qc-changed');
      await dialog.getByRole('button', { name: 'Go back' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Assembling your final ad' })).toHaveCount(0);
      expect(w.body).toHaveLength(1);
    });

    test('an out-of-date final shows the rebuild notice, keeps Download, and Re-assemble returns to choosing clips', async ({ page }) => {
      const w = world();
      w.final = makeFinal([1, 2, 3]);
      w.existing = assemblyFixture('done', {
        outOfDate: true, outputMediaId: FINAL_MEDIA,
        clips: [1, 2, 3].map((n) => ({ position: n, videoJobId: jobId(n), outOfDate: n === 2, qcOverrideConfirmed: false })),
      });
      w.list = [item(1, videoJob(1)), item(2, videoJob(2, { outOfDate: true })), item(3, videoJob(3))];
      await api(page, w);
      await page.goto(FINAL_URL);
      await expect(page.getByText('This final ad is out of date')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Clip 2 was regenerated after this ad was made/)).toBeVisible();
      await playable(page, 3);
      await expect(page.getByRole('button', { name: 'Download' })).toBeEnabled();
      await shot(page, '10-out-of-date');
      await page.getByRole('button', { name: 'Re-assemble' }).first().click();
      await expect(page.getByRole('heading', { level: 2, name: 'Choose and order clips' })).toBeVisible();
      await expect(page.getByText('Out of date')).toBeVisible();
      await expect(assembleButton(page)).toBeEnabled();
      await shot(page, '11-reassemble-select');
    });

    test('daily assembly limit: the selection is kept, the notice explains and Assemble is off', async ({ page }) => {
      const w = world({ assemble: 'daily-limit', list: [item(1, videoJob(1)), item(2, videoJob(2)), item(3, videoJob(3))] });
      await api(page, w);
      await page.goto(FINAL_URL);
      await page.getByRole('button', { name: 'Move segment 3 up' }).click();
      await assembleButton(page).click();
      await expect(page.getByText('Daily assembly limit reached')).toBeVisible();
      await expect(assembleButton(page)).toBeDisabled();
      await expect(page.getByRole('checkbox')).toHaveCount(3);
      await shot(page, '12-daily-limit');
    });

    test('download refused while the file is not ready: the cause is shown and no file is handed over', async ({ page }) => {
      const w = world({ media: 'not_ready' });
      w.final = makeFinal([1, 2, 3]);
      w.existing = assemblyFixture('done', { outputMediaId: FINAL_MEDIA });
      await api(page, w);
      await page.goto(FINAL_URL);
      await expect(page.getByRole('heading', { level: 2, name: 'Final ad', exact: true })).toBeVisible({ timeout: 20_000 });
      let downloads = 0;
      page.on('download', () => (downloads += 1));
      await page.getByRole('button', { name: 'Download' }).click();
      await expect(page.getByRole('alert').first()).toBeVisible();
      expect(downloads).toBe(0);
      expect(w.calls).not.toContain('GET storage/final.webm');
      await shot(page, '13-download-refused');
    });

    test('session expiry in the journey: the api answers 401 on Assemble, the visitor goes to sign-in with this page as the return path and nothing is assembled', async ({ page }) => {
      const w = world({ assemble: 'unauthenticated', list: [item(1, videoJob(1)), item(2, videoJob(2)), item(3, videoJob(3))] });
      await api(page, w);
      await page.goto(FINAL_URL);
      await assembleButton(page).click();
      await page.waitForURL('**/sign-in**');
      const url = new URL(page.url());
      expect(url.searchParams.get('return')).toBe(FINAL_URL);
      expect(url.searchParams.get('reason')).toBe('session-expired');
      await expect(page.locator('video')).toHaveCount(0);
      await shot(page, '14-session-expired-on-assemble');
    });

    test('permission path: a campaign that is not the operator\'s is answered 404 and no clips or final are shown', async ({ page }) => {
      const w = world({ unavailable: true });
      await api(page, w);
      await page.goto(FINAL_URL);
      await expect(page.getByRole('heading', { name: 'Choose and order clips' })).toHaveCount(0);
      await expect(assembleButton(page)).toHaveCount(0);
      await expect(page.locator('video')).toHaveCount(0);
      await shot(page, '15-campaign-unavailable');
    });

    test('session expiry at the door: the running api answers 401 without a bearer; sign-in carries the return path, no final is shown', async ({ page }) => {
      const w = world();
      await api(page, w, true);
      await page.goto(FINAL_URL);
      await page.waitForURL('**/sign-in**');
      expect(new URL(page.url()).searchParams.get('return')).toBe(FINAL_URL);
      expect(w.calls.some((c) => c.startsWith('GET /campaigns/'))).toBe(true);
      await expect(page.getByRole('button', { name: 'Assemble final ad' })).toHaveCount(0);
      await shot(page, '16-session-expired-sign-in');
    });
  });
}

test.describe('@TASK-107 @TC-FLW-04 FLOW-04 keyboard only', () => {
  test.use({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

  test('order, confirm, Assemble and Download, every step by keys', async ({ page }) => {
    const w = world();
    await api(page, w);
    await page.goto(FINAL_URL);
    await expect(page.getByRole('heading', { level: 2, name: 'Choose and order clips' })).toBeVisible();

    await page.getByRole('button', { name: 'Move segment 3 up' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Segment 3 moved to position 2.' })).toHaveCount(1);

    await assembleButton(page).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Assemble with audio checks that did not pass?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(dialog.getByRole('checkbox')).toBeChecked();
    await dialog.getByRole('button', { name: 'Assemble anyway' }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { level: 2, name: 'Final ad', exact: true })).toBeVisible({ timeout: 25_000 });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).focus();
    await page.keyboard.press('Enter');
    expect((await download).suggestedFilename()).toBe('final-ad.webm');
    expect(w.body[0]!.clips).toEqual([jobId(1), jobId(3), jobId(2)]);
  });
});

