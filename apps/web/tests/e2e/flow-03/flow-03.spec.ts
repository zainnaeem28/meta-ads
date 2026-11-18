import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { VIEWPORTS } from '../../support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

// TC-FLW-03 (FLOW-03, J-03): SCREEN-007 (accepted) -> SCREEN-008 (generate 4 clips, one fails then Retry, review the
// audio checks) -> SCREEN-009, through the built web app (`next start`) and the built api on real PostgreSQL.
// Nothing between the browser and the database is mocked: the web gets its bearer from /local-token, the api answers
// every call, the jobs are queued by the api in pg-boss and run by the worker (in-process, see harness.mjs), the quality
// check extracts the audio of a real clip with real FFmpeg. Only the provider hosts are stand-ins (WaveSpeed and OpenAI
// answer from a local TLS server, clips are stored in an S3 stand-in). The brief is seeded as accepted: its acceptance
// is FLOW-02's journey. The control server only seeds accounts and steers the stand-ins; it never touches the product.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-106';
const control = process.env.FLOW03_CONTROL_URL!;
const SIZES = VIEWPORTS.filter((v) => v.name !== '768');
const SLOW = 150_000;

interface Seeded {
  owner: string;
  campaign: string;
  dialogue: string[];
}
const post = async <T = unknown>(path: string, body: unknown = {}): Promise<T> =>
  (await fetch(`${control}${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<T>;
const seed = (email: string, options: Record<string, unknown> = {}) =>
  post<Seeded>('/seed', { email, ...options });
const steer = (body: { failOnce?: number[]; qcMismatch?: number[]; submit?: string }) =>
  post('/behaviour', body);
const stateOf = async (campaign: string) =>
  (await (await fetch(`${control}/state?campaign=${campaign}`)).json()) as {
    jobs: { position: number; state: string; cause_class: string | null; qc_state: string | null }[];
  };
/** Submits that reached the WaveSpeed stand-in (a clip is only ever sent by an explicit action). */
const submits = async () =>
  (
    (await (await fetch(`${control}/calls`)).json()) as { calls: { method: string; url: string }[] }
  ).calls.filter(
    (c) =>
      c.method === 'POST' &&
      c.url.startsWith('/api/v3/') &&
      !c.url.startsWith('/api/v3/predictions/delete'),
  ).length;

const sessionCookie = async (email: string, expiresIn: number) =>
  signLocalSession({
    sub: 'user_local_e2e',
    email,
    exp: Math.floor(Date.now() / 1000) + expiresIn,
  });
const signedIn = async (context: BrowserContext, baseURL: string, email: string, expiresIn = 3000) =>
  context.addCookies([
    { name: LOCAL_SESSION_COOKIE, value: await sessionCookie(email, expiresIn), url: baseURL },
  ]);

/** The step's screenshot at both design widths plus axe, taken on the page as it stands. */
async function capture(page: Page, step: string) {
  const original = page.viewportSize();
  for (const { name, width, height } of SIZES) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await expectNoAxeViolations(page, `${evidence}/axe/${step}-${name}.json`);
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    await page.screenshot({ path: `${evidence}/screenshots/${step}-${name}.png`, fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

/** Moves focus with Tab until `target` has it (keyboard-only journey, NFR-07). */
async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let i = 0; i < 80; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('the control cannot be reached with the keyboard');
}
const press = async (page: Page, target: Locator, key = 'Enter') => {
  await tabTo(page, target);
  await page.keyboard.press(key);
};
const row = (page: Page, position: number) => page.locator(`li[data-segment="${position}"]`);
const rows = (page: Page) => page.getByRole('list', { name: 'Segment clips' }).getByRole('listitem');

test.describe('@TASK-106 @TC-FLW-03 @FLOW-03 generate clips, QC and retry end to end', () => {
  test.use({ timezoneId: 'UTC', viewport: { width: 1440, height: 900 } });

  test('keyboard only: brief accepted -> generate four clips, one fails then Retry, review QC, re-run one check -> final', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(420_000);
    const email = 'flow03-journey@example.com';
    const s = await seed(email);
    await steer({ failOnce: [2], qcMismatch: [3], submit: 'ok' });
    await post('/calls/reset');
    await signedIn(context, baseURL!, email);
    const clipsUrl = `/campaigns/${s.campaign}/clips`;

    // 1. SCREEN-007, accepted: the way on is "Continue to clips".
    await page.goto(`/campaigns/${s.campaign}/brief`);
    await expect(page.getByRole('heading', { level: 2, name: 'Brief accepted · all checks closed' })).toBeVisible();
    await expect(page.getByText('Accepted', { exact: true }).first()).toBeVisible();
    await capture(page, '1-brief-accepted');
    await press(page, page.getByRole('link', { name: 'Continue to clips' }).first());
    await page.waitForURL(`**${clipsUrl}`);

    // 2. SCREEN-008 with the campaign carried: four segments, nothing generated, the final tab not yet open.
    await expect(page.getByRole('heading', { level: 1, name: 'Calm Morning Drink' })).toBeVisible();
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByText('Not generated')).toHaveCount(4);
    await expect(page.locator('[data-screen="SCREEN-008"]')).toHaveAttribute('data-clips-state', 'ready');
    await expect(page.getByRole('tab', { name: '3 Final' })).toBeDisabled();
    for (let p = 1; p <= 4; p += 1) await expect(row(page, p)).toContainText(s.dialogue[p - 1]!.slice(0, 30));
    await capture(page, '2-clips-not-generated');

    // 3. Generate the remaining clips: four jobs start, one provider task per clip.
    await press(page, page.getByRole('button', { name: 'Generate remaining clips' }), 'Enter');
    await expect(page.getByText('Remaining clips started.')).toBeVisible();
    await expect(page.getByText(/^(Queued|Processing)$/).first()).toBeVisible();
    await capture(page, '3-generating');

    // 4. Segment 2 fails: its cause class and Retry show, nothing is retried automatically.
    await expect(row(page, 2)).toContainText('Failed: temporary provider problem', { timeout: SLOW });
    await expect(row(page, 2).getByRole('button', { name: 'Retry segment 2' })).toBeVisible();
    await expect(row(page, 2)).toContainText('Nothing is retried automatically');
    await capture(page, '4-failed-with-retry');
    await page.waitForTimeout(8000);
    expect(await submits(), 'one submit per clip, no automatic retry of the failed one').toBe(4);
    expect((await stateOf(s.campaign)).jobs.filter((j) => j.position === 2)).toHaveLength(1);

    // 5. Retry (keyboard): a new job for segment 2 starts and the other clips are untouched.
    await press(page, page.getByRole('button', { name: 'Retry segment 2' }));
    await expect(page.getByText('Segment 2 clip started.')).toBeVisible();
    await expect.poll(submits, { timeout: 30_000 }).toBe(5);

    // 6. QC review: segments 1, 2 and 4 pass; segment 3's speech does not match its script.
    for (const p of [1, 2, 4]) {
      await expect(row(page, p)).toContainText('Completed', { timeout: SLOW });
      await expect(row(page, p)).toContainText('Audio check: passed', { timeout: SLOW });
    }
    await expect(row(page, 3)).toContainText('Audio check: failed', { timeout: SLOW });
    await expect(row(page, 3)).toContainText('of the words differ from the script');
    await expect(page.getByText('3 of 4 clips ready.')).toHaveCount(0);
    await capture(page, '5-qc-review');
    const jobs = (await stateOf(s.campaign)).jobs;
    expect(jobs.filter((j) => j.position === 2).map((j) => [j.state, j.cause_class])).toEqual([
      ['failed', 'temporary'],
      ['completed', null],
    ]);

    // 7. Re-run the failed check (keyboard) once the speech is right: the result changes, history stays on the server.
    await steer({ qcMismatch: [] });
    await press(page, page.getByRole('button', { name: 'Re-run check segment 3' }));
    await expect(page.getByText('Check started for segment 3.')).toBeVisible();
    await expect(row(page, 3)).toContainText('Audio check: passed', { timeout: SLOW });
    await expect(page.getByText('4 of 4 clips ready.')).toBeVisible();
    await capture(page, '6-all-clips-passed');
    expect(await submits(), 'a re-run check never sends a clip to the provider again').toBe(5);

    // 8. On to SCREEN-009 with the campaign carried; the four clips are there to choose and order.
    await press(page, page.getByRole('link', { name: 'Choose clips for the final ad' }));
    await page.waitForURL(`**/campaigns/${s.campaign}/final`);
    await expect(page.getByRole('heading', { name: 'Choose and order clips' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Clips for the final ad' }).getByRole('listitem')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Assemble final ad' })).toBeEnabled();
    await capture(page, '7-final-arrival');

    // 9. Back: SCREEN-008 shows the same four completed clips (state carried, nothing regenerated).
    await page.goBack();
    await page.waitForURL(`**${clipsUrl}`);
    await expect(page.getByText('4 of 4 clips ready.')).toBeVisible();
    expect(await submits()).toBe(5);
  });

  test('outcome unknown: the lost submit is never repeated by itself; the user can start a new clip on purpose', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    const email = 'flow03-unknown@example.com';
    const s = await seed(email);
    await steer({ failOnce: [], qcMismatch: [], submit: 'hang' });
    await post('/calls/reset');
    await signedIn(context, baseURL!, email);
    await page.goto(`/campaigns/${s.campaign}/clips`);
    await press(page, page.getByRole('button', { name: 'Generate segment 1' }));
    await expect(row(page, 1)).toContainText('Failed: outcome unknown', { timeout: SLOW });
    await expect(row(page, 1)).toContainText('not sent again automatically');
    await capture(page, '8-outcome-unknown');
    await page.waitForTimeout(12_000);
    expect(await submits(), 'the clip was sent once and is never sent again by itself').toBe(1);
    expect((await stateOf(s.campaign)).jobs).toMatchObject([{ position: 1, state: 'failed', cause_class: 'outcome_unknown' }]);

    // Only an explicit action starts another clip.
    await steer({ submit: 'ok' });
    await press(page, row(page, 1).getByRole('button', { name: 'Retry segment 1 as a new clip' }));
    await expect.poll(submits, { timeout: 30_000 }).toBe(2);
    await expect(row(page, 1)).toContainText('Audio check: passed', { timeout: SLOW });
  });

  test('cap reached: Generate is refused with the blocked state, no clip is created, nothing is sent', async ({
    page,
    context,
    baseURL,
  }) => {
    const email = 'flow03-cap@example.com';
    const s = await seed(email, { reservedUsd: '49.99' });
    await steer({ failOnce: [], qcMismatch: [], submit: 'ok' });
    await post('/calls/reset');
    await signedIn(context, baseURL!, email);
    await page.goto(`/campaigns/${s.campaign}/clips`);
    await press(page, page.getByRole('button', { name: 'Generate segment 1' }));
    await expect(page.locator('[data-screen="SCREEN-008"]')).toHaveAttribute('data-clips-state', 'spend_cap_reached');
    await expect(page.getByRole('button', { name: 'Generate segment 1' })).toBeDisabled();
    await capture(page, '9-cap-reached');
    expect((await stateOf(s.campaign)).jobs).toEqual([]);
    expect(await submits()).toBe(0);
  });

  test('key disabled and key missing: the blocked states, with the way to SCREEN-010 and back', async ({
    page,
    context,
    baseURL,
  }) => {
    const email = 'flow03-key@example.com';
    const s = await seed(email, { keys: { wavespeed: 'disabled' } });
    await signedIn(context, baseURL!, email);
    await page.goto(`/campaigns/${s.campaign}/clips`);
    await expect(page.locator('[data-screen="SCREEN-008"]')).toHaveAttribute('data-clips-state', 'key_disabled');
    await expect(page.getByText('Your provider key was disabled after repeated failures. Replace it to continue.')).toBeVisible();
    for (let p = 1; p <= 4; p += 1) await expect(page.getByRole('button', { name: `Generate segment ${p}` })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Generate remaining clips' })).toBeDisabled();
    await capture(page, '10-key-disabled');
    await page.getByRole('link', { name: /Replace key/ }).first().click();
    await page.waitForURL('**/settings/provider-keys');
    await page.goBack();
    await expect(page.locator('[data-screen="SCREEN-008"]')).toHaveAttribute('data-clips-state', 'key_disabled');

    const missingEmail = 'flow03-nokey@example.com';
    const m = await seed(missingEmail, { keys: { wavespeed: 'none' } });
    await signedIn(context, baseURL!, missingEmail);
    await page.goto(`/campaigns/${m.campaign}/clips`);
    await expect(page.locator('[data-screen="SCREEN-008"]')).toHaveAttribute('data-clips-state', 'key_missing');
    await expect(page.getByText('Add your provider key to continue. Your work is saved.')).toBeVisible();
    await capture(page, '11-key-missing');
  });

  test('brief not accepted: SCREEN-008 is blocked with the way back to the brief; the final stays closed', async ({
    page,
    context,
    baseURL,
  }) => {
    const email = 'flow03-draft@example.com';
    const s = await seed(email, { briefState: 'draft' });
    await signedIn(context, baseURL!, email);
    await page.goto(`/campaigns/${s.campaign}/clips`);
    await expect(page.locator('[data-screen="SCREEN-008"]')).toHaveAttribute('data-clips-state', 'brief_not_accepted');
    await expect(page.getByRole('button', { name: 'Generate segment 1' })).toBeDisabled();
    await expect(page.getByRole('tab', { name: '3 Final' })).toBeDisabled();
    await capture(page, '12-brief-not-accepted');
    await page.getByRole('link', { name: /Open the brief/ }).first().click();
    await page.waitForURL(`**/campaigns/${s.campaign}/brief`);
    await page.goBack();
    await expect(page.locator('[data-screen="SCREEN-008"]')).toHaveAttribute('data-clips-state', 'brief_not_accepted');
  });

  test('leaving while clips run keeps them running; coming back shows them, none is sent twice (back and cancel path)', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    const email = 'flow03-leave@example.com';
    const s = await seed(email);
    await steer({ failOnce: [], qcMismatch: [], submit: 'ok' });
    await post('/calls/reset');
    await signedIn(context, baseURL!, email);
    await page.goto(`/campaigns/${s.campaign}/clips`);
    await page.getByRole('button', { name: 'Generate remaining clips' }).click();
    await expect(page.getByText('Remaining clips started.')).toBeVisible();
    // Leave to the brief (tab), then to the campaign list, then back to the clips by the browser's Back.
    await page.getByRole('tab', { name: '1 Brief' }).click();
    await page.waitForURL(`**/campaigns/${s.campaign}/brief`);
    await page.getByRole('link', { name: 'Campaigns' }).first().click();
    await page.waitForURL('**/campaigns');
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForURL(`**/campaigns/${s.campaign}/brief`);
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForURL(`**/campaigns/${s.campaign}/clips`);
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByText('4 of 4 clips ready.')).toBeVisible({ timeout: SLOW });
    expect(await submits(), 'leaving and returning sent no clip twice').toBe(4);
    await capture(page, '13-back-after-leaving');
  });

  test('session expiry: the ended session returns to sign-in with the message and the page as the return path', async ({
    page,
    context,
    baseURL,
  }) => {
    const email = 'flow03-expiry@example.com';
    const s = await seed(email);
    await signedIn(context, baseURL!, email);
    await page.goto(`/campaigns/${s.campaign}/clips`);
    await expect(rows(page)).toHaveCount(4);
    // The session ends while the page is open: the next navigation is turned back, nothing is shown.
    await signedIn(context, baseURL!, email, -60);
    await page.getByRole('tab', { name: '1 Brief' }).click();
    await page.waitForURL('**/sign-in**');
    const url = new URL(page.url());
    expect(url.searchParams.get('reason')).toBe('session-expired');
    expect(url.searchParams.get('return')).toBe(`/campaigns/${s.campaign}/brief`);
    await expect(page.getByText('Your session ended. Sign in to continue.')).toBeVisible();
    await expect(page.getByText(s.dialogue[0]!.slice(0, 30))).toHaveCount(0);
    await capture(page, '14-session-expired');
    // Anonymous deep link to the clips: same turn-back with the clips page as the return path.
    await context.clearCookies();
    await page.goto(`/campaigns/${s.campaign}/clips`);
    await page.waitForURL('**/sign-in**');
    expect(new URL(page.url()).searchParams.get('return')).toBe(`/campaigns/${s.campaign}/clips`);
  });

  test("permission: another account's campaign answers as unavailable, with none of its content", async ({
    page,
    context,
    baseURL,
  }) => {
    const owner = await seed('flow03-owner@example.com');
    await seed('flow03-stranger@example.com');
    await signedIn(context, baseURL!, 'flow03-stranger@example.com');
    const calls: number[] = [];
    page.on('response', (r) => {
      if (/\/api\/v1\/campaigns\/[^/]+(\/video-jobs|\/brief)?$/.test(new URL(r.url()).pathname)) calls.push(r.status());
    });
    await page.goto(`/campaigns/${owner.campaign}/clips`);
    await expect(page.getByText(owner.dialogue[0]!.slice(0, 30))).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Generate segment/ })).toHaveCount(0);
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c === 404), 'the api answers not found, never forbidden or the data').toBe(true);
    await capture(page, '15-foreign-campaign');
  });
});
