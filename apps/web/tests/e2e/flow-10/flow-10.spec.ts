import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { VIEWPORTS } from '../../support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

// TC-FLW-10: any unknown URL -> SCREEN-004 -> Go Home (anonymous goes to sign-in, signed in to the campaign list).
// Runs against the built web app (`next start`) and the compiled api; no network call is made by SCREEN-004 itself.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-111';
const SIZES = VIEWPORTS.filter((v) => v.name !== '768');

const session = async (context: BrowserContext, baseURL: string, expiresIn: number) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp: Math.floor(Date.now() / 1000) + expiresIn }),
      url: baseURL,
    },
  ]);

/** The step's screenshot at both design widths plus axe, taken on the page as it stands. */
async function capture(page: Page, step: string, project: string) {
  const original = page.viewportSize();
  for (const { name, width, height } of SIZES) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await expectNoAxeViolations(page, `${evidence}/axe/${project}-${step}-${name}.json`);
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    await page.screenshot({ path: `${evidence}/screenshots/${step}-${name}.png`, fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

const noindex = (page: Page) =>
  page.locator('meta[name=robots]').evaluateAll((els) => els.map((e) => e.getAttribute('content')));

const watchApi = (page: Page) => {
  const calls: string[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith(process.env.E2E_API_URL!)) calls.push(req.url());
  });
  return calls;
};

test.describe('@TASK-111 @FLOW-10 not found and home route end to end', () => {
  test('signed in: unknown URL -> SCREEN-004 -> Go Home (keyboard only) -> campaign list', async ({ page, context, baseURL }, info) => {
    await session(context, baseURL!, 600);
    const apiOnNotFound = watchApi(page);

    const res = await page.goto('/no/such/page?x=1#frag');
    expect(res?.status(), 'an unknown URL is a real 404, never a 200').toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(await page.title()).toBe('Page not found · ShrooMap');
    expect(await noindex(page)).toEqual(expect.arrayContaining([expect.stringMatching(/noindex/)]));
    await capture(page, '1-unknown-url-404', info.project.name);

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Go Home' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/campaigns');
    expect(apiOnNotFound, 'SCREEN-004 makes no api call before the campaign list loads').toEqual([]);
    await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
    // Let the list settle (loaded, empty or an api error state, whatever the running api answers): the landing is the proof here.
    await expect(page.getByText('Loading campaigns')).toHaveCount(0, { timeout: 20_000 });
    await capture(page, '2-go-home-campaign-list', info.project.name);
  });

  test('signed in: unavailable record -> SCREEN-004 -> Go Home -> campaign list; one message, no hint', async ({ page, context, baseURL }, info) => {
    await session(context, baseURL!, 600);
    await page.goto('/not-found?state=unavailable');
    await expect(page.getByRole('heading', { level: 1, name: 'This campaign is unavailable' })).toBeVisible();
    await expect(page.getByText("We can't tell you which.")).toBeVisible();
    expect(await noindex(page)).toEqual(expect.arrayContaining([expect.stringMatching(/noindex/)]));
    await capture(page, '3-unavailable-record', info.project.name);
    await page.getByRole('link', { name: 'Go Home' }).click();
    await page.waitForURL('**/campaigns');
  });

  test('back path: browser back from the campaign list returns to the not-found page', async ({ page, context, baseURL }) => {
    await session(context, baseURL!, 600);
    await page.goto('/no/such/page');
    await page.getByRole('link', { name: 'Go Home' }).click();
    await page.waitForURL('**/campaigns');
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });

  test('home route "/" sends a signed-in user to the campaign list', async ({ page, context, baseURL }) => {
    await session(context, baseURL!, 600);
    await page.goto('/');
    expect(new URL(page.url()).pathname).toBe('/campaigns');
  });

  test('anonymous: unknown URL -> sign-in with a safe return path; Go Home target "/" -> sign-in', async ({ page }, info) => {
    const res = await page.goto('/no/such/page');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/no/such/page');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'AI UGC Ad Director' })).toBeVisible();
    await expect(page.getByText('Your session ended. Sign in to continue.')).toHaveCount(0);
    await capture(page, '4-anonymous-unknown-url-sign-in', info.project.name);

    await page.goto('/');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(new URL(page.url()).searchParams.get('return')).toBeNull();
  });

  test('anonymous cannot read the unavailable page: it goes to sign-in too', async ({ page }) => {
    await page.goto('/not-found?state=unavailable');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    await expect(page.getByRole('heading', { name: 'This campaign is unavailable' })).toHaveCount(0);
  });

  test('session expiry: an ended session on an unknown URL returns to sign-in with the session-ended message', async ({ page, context, baseURL }, info) => {
    await session(context, baseURL!, -60);
    await page.goto('/no/such/page');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(new URL(page.url()).searchParams.get('reason')).toBe('session-expired');
    await expect(page.getByText('Your session ended. Sign in to continue.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
    await capture(page, '5-session-expired-sign-in', info.project.name);
  });

  test('a tampered session cookie is treated as anonymous, never as a signed-in 404', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: LOCAL_SESSION_COOKIE, value: 'forged.value', url: baseURL! }]);
    await page.goto('/no/such/page');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
  });
});
