import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_DEV_CODE, LOCAL_DEV_PASSWORD } from '../src/lib/auth/local-dev';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-084';
const SHOTS = VIEWPORTS.filter((v) => v.name !== '768');

const cookieFor = async (context: BrowserContext, baseURL: string, exp: number) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp }),
      url: baseURL,
    },
  ]);

const signIn = async (page: Page, password = LOCAL_DEV_PASSWORD) => {
  await page.getByLabel('Email address').fill('operator@example.com');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
};

const headTags = (page: Page) =>
  page.evaluate(() => ({
    title: document.title,
    robots: document.querySelector('meta[name=robots]')?.getAttribute('content') ?? '',
  }));

test.describe('@TASK-084 Clerk integration, route protection and sign-in through the built web app (local mode)', () => {
  for (const path of ['/campaigns', '/campaigns/42/brief?tab=clips', '/settings/provider-keys', '/access']) {
    test(`anonymous visitor to ${path} lands on sign-in and no data is requested`, async ({ page }) => {
      const apiCalls: string[] = [];
      page.on('request', (req) => {
        if (req.url().startsWith(process.env.E2E_API_URL!)) apiCalls.push(req.url());
      });
      await page.goto(path);
      const url = new URL(page.url());
      expect(url.pathname).toBe('/sign-in');
      expect(url.searchParams.get('return')).toBe(path);
      expect(url.searchParams.get('reason')).toBeNull();
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      expect(apiCalls).toEqual([]);
    });
  }

  test('signing in returns to the requested URL; a wrong password shows the invalid state', async ({ page }) => {
    await page.goto('/campaigns/42/brief?tab=clips');
    await signIn(page, 'wrong-password');
    await expect(page.getByRole('alert').filter({ hasText: 'That email and password do not match' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    await signIn(page);
    await page.waitForURL('**/campaigns/42/brief?tab=clips');
  });

  test('an expired session returns to the same URL after sign-in, with the session-ended message', async ({ page, context, baseURL }) => {
    await cookieFor(context, baseURL!, 1);
    await page.goto('/campaigns/7/clips');
    const url = new URL(page.url());
    expect(url.searchParams.get('reason')).toBe('session-expired');
    await expect(page.getByRole('status').filter({ hasText: 'Your session ended' })).toBeVisible();
    await signIn(page);
    await page.waitForURL('**/campaigns/7/clips');
  });

  test('home route: signed out goes to sign-in, signed in goes to the campaign list', async ({ page, context, baseURL }) => {
    await page.goto('/');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    await cookieFor(context, baseURL!, Math.floor(Date.now() / 1000) + 600);
    await page.goto('/');
    expect(new URL(page.url()).pathname).toBe('/campaigns');
  });

  test('an off-site return path is ignored', async ({ page }) => {
    await page.goto('/sign-in?return=https%3A%2F%2Fevil.example%2F');
    await signIn(page);
    await page.waitForURL('**/campaigns');
    expect(page.url()).not.toContain('evil.example');
  });

  test('every route carries noindex, Referrer-Policy same-origin and the document title pattern', async ({ page, request }) => {
    for (const path of ['/sign-in', '/mfa', '/campaigns', '/']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.headers()['referrer-policy'], path).toBe('same-origin');
      expect(res.headers()['x-robots-tag'], path).toMatch(/noindex/);
    }
    await page.goto('/sign-in');
    expect(await headTags(page)).toEqual({ title: 'Sign in · ShrooMap', robots: 'noindex, nofollow' });
    await page.goto('/mfa');
    expect(await headTags(page)).toEqual({ title: 'Two-step verification · ShrooMap', robots: 'noindex, nofollow' });
  });

  test('the sign-in page loads nothing from a third party', async ({ page, baseURL }) => {
    const foreign: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith(new URL(baseURL!).origin) && !url.startsWith('data:')) foreign.push(url);
    });
    await page.goto('/sign-in');
    await page.evaluate(() => document.fonts.ready);
    expect(foreign).toEqual([]);
  });

  test('the second step accepts the local code and rejects another', async ({ page, context, baseURL }) => {
    await cookieFor(context, baseURL!, Math.floor(Date.now() / 1000) + 600);
    await page.goto('/mfa?return=%2Fcampaigns%2F9');
    await page.getByLabel('6-digit code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('That code is not right or has expired')).toBeVisible();
    await page.getByLabel('6-digit code').fill(LOCAL_DEV_CODE);
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL('**/campaigns/9');
  });

  test('the running api answers an anonymous caller with 401 and the web runs beside it', async ({ request }) => {
    expect((await request.get(`${process.env.E2E_API_URL}/health/live`)).ok()).toBe(true);
    expect((await request.get(`${process.env.E2E_API_URL}/api/v1/me`)).status()).toBe(401);
  });

  for (const { name, width, height } of SHOTS) {
    for (const state of ['default', 'session-expired', 'invalid', 'mfa'] as const) {
      test(`${state} at ${name} px: no axe violations and a screenshot`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        if (state === 'mfa') await page.goto('/mfa');
        else await page.goto(state === 'session-expired' ? '/sign-in?reason=session-expired&return=%2Fcampaigns' : '/sign-in');
        if (state === 'invalid') {
          await signIn(page, 'wrong-password');
          await expect(page.getByRole('alert').filter({ hasText: 'do not match' })).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-${state}-${name}.json`);
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        await page.screenshot({ path: `${evidence}/screenshots/${state}-${name}.png`, fullPage: true });
        await expect(page).toHaveScreenshot(`clerk-${state}-${name}.png`, { fullPage: true });
      });
    }
  }
});
