import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-088';
const SHOTS = VIEWPORTS.filter((v) => v.name !== '768');
const api = () => process.env.E2E_API_URL!;

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

type Me = 'none' | 'pending' | 'declined' | 'suspended' | 'removed' | 'form-off';
const meta = { requestId: 'req-e2e' };
const error = (code: string) => ({
  success: false,
  error: { code, message: code, details: [] },
  metaData: meta,
});

/** Answers the two operations a not-linked token may call; the real-api proof is the flow ticket. Returns the calls made. */
async function stubApi(
  page: Page,
  me: Me,
  access: { status: number; code?: string } = { status: 202 },
) {
  const calls: string[] = [];
  await page.route(`${api()}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(request.url()).pathname;
    calls.push(`${request.method()} ${path}`);
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify(body),
      });
    if (path === '/api/v1/me') {
      if (me === 'suspended' || me === 'removed') return json(403, error(`account_${me}`));
      const state = me === 'form-off' ? 'none' : me;
      return json(200, {
        success: true,
        data: { linkState: 'not_linked', accessRequest: { formEnabled: me !== 'form-off', state } },
        metaData: meta,
      });
    }
    if (path === '/api/v1/access-requests') {
      return access.status === 202
        ? json(202, { success: true, data: { state: 'received' }, metaData: meta })
        : json(access.status, error(access.code ?? 'internal_error'));
    }
    return json(500, error('internal_error'));
  });
  return calls;
}

const STATES = [
  { state: 'not-linked', path: '/access', me: 'none', title: 'This account has no access yet' },
  { state: 'request-pending', path: '/access', me: 'pending', title: 'Request sent' },
  {
    state: 'suspended',
    path: '/access?state=suspended',
    me: 'none',
    title: 'This account is suspended',
  },
  {
    state: 'removed',
    path: '/access?state=removed',
    me: 'none',
    title: 'This account has been removed',
  },
  {
    state: 'invite-invalid',
    path: '/access?state=invite-invalid',
    me: 'none',
    title: 'This invitation cannot be used',
  },
] as const;

test.describe('@TASK-088 SCREEN-002 access states through the built web app', () => {
  test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

  for (const { state, path, me, title } of STATES) {
    test(`${state}: one h1, noindex, Back to sign in by keyboard`, async ({ page }) => {
      const calls = await stubApi(page, me);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      expect(await page.title()).toBe('Access · ShrooMap');
      expect(
        await page
          .locator('meta[name=robots]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('content'))),
      ).toEqual(expect.arrayContaining([expect.stringMatching(/noindex/)]));
      if (state === 'removed') {
        await expect(
          page.getByText('This account has been removed.', { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(/administrator/i)).toHaveCount(0);
      }
      if (state === 'suspended')
        await expect(
          page.getByText('Your account is suspended. Contact your administrator.'),
        ).toBeVisible();
      // Only API-001 and API-002 are ever called (suspended, removed and invite-invalid make no call).
      expect(
        calls.every((c) => c === 'GET /api/v1/me' || c === 'POST /api/v1/access-requests'),
      ).toBe(true);
      if (state !== 'not-linked' && state !== 'request-pending') expect(calls).toEqual([]);
      const back = page.getByRole('link', { name: 'Back to sign in' });
      for (let i = 0; i < 4 && !(await back.evaluate((el) => el === document.activeElement)); i++)
        await page.keyboard.press('Tab');
      await expect(back).toBeFocused();
    });
  }

  test('the suspended and removed answers of API-001 show their states', async ({ page }) => {
    for (const [me, title] of [
      ['suspended', 'This account is suspended'],
      ['removed', 'This account has been removed'],
    ] as const) {
      await page.unrouteAll();
      await stubApi(page, me);
      await page.goto('/access');
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    }
  });

  test('requesting access by keyboard sends the note only and shows the neutral confirmation', async ({
    page,
  }) => {
    const calls = await stubApi(page, 'none');
    let body: unknown;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/access-requests')) body = r.postDataJSON();
    });
    await page.goto('/access');
    await page.getByLabel(/Tell your administrator/).focus();
    await page.keyboard.type('Marketing, spring launch');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Request access' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Request sent' })).toBeVisible();
    expect(body).toEqual({ note: 'Marketing, spring launch' });
    expect(calls).toEqual(['GET /api/v1/me', 'POST /api/v1/access-requests']);
  });

  test('rate limited shows the wait and keeps the form; a disabled form shows neutral copy', async ({
    page,
  }) => {
    await stubApi(page, 'none', { status: 429, code: 'rate_limited' });
    await page.goto('/access');
    await page.getByRole('button', { name: 'Request access' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Too many attempts' })).toBeVisible();
    await expect(page.getByLabel(/Tell your administrator/)).toBeVisible();
    await page.unrouteAll();
    await stubApi(page, 'form-off');
    await page.goto('/access');
    await expect(page.getByText(/Requests are not being taken/)).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
  });

  for (const { name, width, height } of SHOTS) {
    for (const { state, path, me } of STATES) {
      test(`${state} at ${name} px: axe and a screenshot`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        await stubApi(page, me);
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('status')).toHaveCount(0);
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
        await expect(page).toHaveScreenshot(`fe-screen-002-${state}-${name}.png`, {
          fullPage: true,
        });
      });
    }
  }
});
