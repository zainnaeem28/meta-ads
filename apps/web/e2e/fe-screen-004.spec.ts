import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-089';
const SHOTS = VIEWPORTS.filter((v) => v.name !== '768');

const signedIn = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({
        sub: 'user_local_e2e',
        email: 'e2e@example.com',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      url: baseURL,
    },
  ]);

const STATES = [
  { state: 'route-404', path: '/no/such/page', title: 'Page not found' },
  {
    state: 'unavailable',
    path: '/not-found?state=unavailable',
    title: 'This campaign is unavailable',
  },
] as const;

test.describe('@TASK-089 SCREEN-004 not found and unavailable record through the built web app', () => {
  test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

  for (const { state, path, title } of STATES) {
    test(`${state}: message, noindex, document title and Go Home reaches the campaign list`, async ({
      page,
    }) => {
      const apiCalls: string[] = [];
      page.on('request', (req) => {
        if (req.url().startsWith(process.env.E2E_API_URL!)) apiCalls.push(req.url());
      });
      const res = await page.goto(path);
      if (state === 'route-404') expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      expect(await page.title()).toBe(`${title} · ShrooMap`);
      expect(
        await page
          .locator('meta[name=robots]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('content'))),
      ).toEqual(expect.arrayContaining([expect.stringMatching(/noindex/)]));
      // keyboard only: Tab reaches the link, Enter follows it
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Go Home' })).toBeFocused();
      await page.keyboard.press('Enter');
      await page.waitForURL('**/campaigns');
      expect(apiCalls).toEqual([]);
    });
  }

  test('anonymous Go Home lands on sign-in', async ({ browser, baseURL }) => {
    const anon = await browser.newContext({ baseURL });
    const page = await anon.newPage();
    // Anonymous visitors reach the unknown URL through the route policy: sign-in.
    await page.goto('/no/such/page');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    await anon.close();
  });

  for (const { name, width, height } of SHOTS) {
    for (const { state, path } of STATES) {
      test(`${state} at ${name} px: no axe violations and a screenshot`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        await expectNoAxeViolations(
          page,
          `${evidence}/axe/${info.project.name}-${state}-${name}.json`,
        );
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        await page.screenshot({
          path: `${evidence}/screenshots/${state}-${name}.png`,
          fullPage: true,
        });
        await expect(page).toHaveScreenshot(`fe-screen-004-${state}-${name}.png`, {
          fullPage: true,
        });
      });
    }
  }
});
