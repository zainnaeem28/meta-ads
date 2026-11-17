import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { LOCAL_DEV_CODE, LOCAL_DEV_PASSWORD } from '../../../src/lib/auth/local-dev';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

// TC-FLW-05 (FLOW-05): SCREEN-001 sign-in to SCREEN-003 (two-step enrol and challenge) to SCREEN-005, or SCREEN-002 when
// the identity is not linked, through the built web app (`next start`, local identity mode) and the built api. Sign-in,
// the second step, the middleware redirects and the return path are the real web app. The signed-in api answers
// (API-001, 040, 020 shapes, from the screens' own e2e fixtures) are a labelled contract mock: the built web sends no
// bearer without an identity provider and the api's local identity mints tokens only in-process. The 401 steps are the
// real api. The provider-hosted components of the hosted mode are not exercised here (no provider keys).
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-108';
const NOW = '2026-11-16T12:00:00.000Z';
const meta = { requestId: 'req-e2e', timestamp: NOW };
const EMAIL = 'operator@example.com';
const MFA_CHAIN = `/mfa?step=enrol&return=${encodeURIComponent('/campaigns')}`;
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const campaign = (n: number, name: string) => ({
  id: id(n),
  productName: name,
  productDescriptionExcerpt: 'Description',
  progress: 'processing',
  briefState: 'accepted',
  segmentCount: 3,
  finalAvailable: false,
  createdAt: '2026-11-15T12:00:00.000Z',
  updatedAt: '2026-11-16T11:48:00.000Z',
});
const ROWS = [campaign(1, 'Morning Focus Blend'), campaign(2, 'Evening Calm Gummies')];

type Answer = { status: number; body: unknown };
const ok = (data: unknown, extra: Record<string, unknown> = {}): Answer => ({
  status: 200,
  body: { success: true, data, metaData: { ...meta, ...extra } },
});
const failure = (status: number, code: string): Answer => ({
  status,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});
const linked = ok({
  linkState: 'linked',
  id: id(99),
  role: 'user',
  status: 'active',
  mfa: { required: true, satisfied: true },
  recentAuth: { satisfied: true, maxAgeSeconds: 600 },
  keyNotices: [],
});
const notLinked = ok({
  linkState: 'not_linked',
  accessRequest: { formEnabled: true, state: 'none' },
});

interface Api {
  /** What the campaign list (API-040) answers; `me` answers API-001. */
  campaigns?: Answer;
  me?: Answer;
  /** Run the browser's api calls against the running api instead of the labelled answers. */
  real?: boolean;
}

async function api(page: Page, a: Api = {}) {
  const origin = process.env.E2E_API_URL!;
  const calls: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-headers':
            (await request.headerValue('access-control-request-headers')) ?? '*',
        },
      });
    }
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname.replace('/api/v1', '')}`);
    if (a.real) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    }
    let answer: Answer;
    if (url.pathname.endsWith('/me/provider-keys')) answer = ok([]);
    else if (url.pathname.endsWith('/me')) answer = a.me ?? linked;
    else if (url.pathname.endsWith('/drafts'))
      answer = ok([], {
        pagination: {
          type: 'cursor',
          limit: 10,
          returnedCount: 0,
          hasNextPage: false,
          nextCursor: null,
        },
      });
    else if (url.pathname.endsWith('/campaigns')) {
      answer =
        a.campaigns ??
        ok(ROWS, {
          pagination: {
            type: 'cursor',
            limit: 10,
            returnedCount: ROWS.length,
            hasNextPage: false,
            nextCursor: null,
          },
        });
    } else answer = failure(404, 'not_found');
    return route.fulfill({
      status: answer.status,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  return calls;
}

const sessionFor = (exp: number) =>
  signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp });
const signedIn = async (
  context: BrowserContext,
  baseURL: string,
  exp = Math.floor(Date.now() / 1000) + 600,
) =>
  context.addCookies([{ name: LOCAL_SESSION_COOKIE, value: await sessionFor(exp), url: baseURL }]);

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`@TASK-108 @TC-FLW-05 FLOW-05 sign in and MFA at ${name} px`, () => {
    test.use({ viewport: { width, height }, timezoneId: 'UTC' });

    const shot = async (page: Page, label: string) => {
      await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await Promise.all(
          ['400', '500', '600', '700'].map((x) => document.fonts.load(`${x} 16px Inter`)),
        );
        await document.fonts.ready;
      });
      await expectNoAxeViolations(page, `${evidence}/axe/${label}-${name}.json`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      const hide = await page.addStyleTag({ content: '.fixed { visibility: hidden !important; }' });
      await page.screenshot({
        path: `${evidence}/screenshots/${label}-${name}.png`,
        fullPage: true,
      });
      await hide.evaluate((el) => el.remove());
    };
    const fillSignIn = async (page: Page, password = LOCAL_DEV_PASSWORD) => {
      await page.getByLabel('Email address').fill(EMAIL);
      await page.getByLabel('Password').fill(password);
    };

    test('the whole journey: requested URL kept, sign in, two-step enrol with a wrong then the right code, then the campaigns', async ({
      page,
    }) => {
      await api(page);
      // 1. An anonymous visit to a deep link goes to SCREEN-001 with the requested URL as the return path.
      await page.goto('/campaigns?tab=drafts');
      await page.waitForURL('**/sign-in**');
      expect(new URL(page.url()).searchParams.get('return')).toBe('/campaigns?tab=drafts');
      await expect(
        page.getByRole('heading', { level: 1, name: 'AI UGC Ad Director' }),
      ).toBeVisible();
      await expect(page.getByText('Your session ended.')).toHaveCount(0);
      await shot(page, '1-sign-in');

      // 2. A wrong password shows the message and keeps the visitor on the page with the return path.
      await fillSignIn(page, 'not-the-password');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('That email and password do not match')).toBeVisible();
      await expect(page).toHaveURL(/\/sign-in/);
      await shot(page, '2-sign-in-error');

      // 3. The right password returns to the requested URL (SCREEN-005, drafts tab).
      await fillSignIn(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL('**/campaigns?tab=drafts');
      await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();

      // 4. Sign-in that goes on to the second step: enrol (SCREEN-003), wrong code, right code, then SCREEN-005.
      await page.context().clearCookies();
      await page.goto(`/sign-in?return=${encodeURIComponent(MFA_CHAIN)}`);
      await fillSignIn(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL('**/mfa?**');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Set up two-step verification' }),
      ).toBeVisible();
      await expect(page.getByTestId('mfa-recovery')).toContainText(
        'Recovery needs another second factor',
      );
      await shot(page, '3-mfa-enrol');
      await page.getByLabel('6-digit code').fill('111111');
      await page.getByRole('button', { name: 'Verify and continue' }).click();
      await expect(page.getByText('That code is not right or has expired')).toBeVisible();
      await shot(page, '4-mfa-error');
      await page.getByLabel('6-digit code').fill(LOCAL_DEV_CODE);
      await page.getByRole('button', { name: 'Verify and continue' }).click();
      await page.waitForURL('**/campaigns');
      await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Morning Focus Blend' })).toBeVisible();
      await shot(page, '5-campaigns');

      // 5. A returning user meets the challenge (not the enrol copy) and the same screen leads on.
      await page.goto('/mfa?return=%2Fcampaigns');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Two-step verification' }),
      ).toBeVisible();
      await shot(page, '6-mfa-challenge');
    });

    test('identity not linked: the account has no access yet (SCREEN-002), the request form, and Back to sign in', async ({
      page,
      context,
      baseURL,
    }) => {
      await signedIn(context, baseURL!);
      const calls = await api(page, { me: notLinked, campaigns: failure(403, 'not_linked') });
      await page.goto('/campaigns');
      await page.waitForURL('**/access?state=not-linked');
      await expect(
        page.getByRole('heading', { level: 1, name: 'This account has no access yet' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Request access' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
        'href',
        /\/sign-in/,
      );
      expect(calls).toContain('GET /me');
      expect(calls).toContain('GET /campaigns');
      await shot(page, '7-not-linked');
      await page.getByRole('link', { name: 'Back to sign in' }).click();
      await page.waitForURL('**/sign-in**');
    });

    test('the two-step requirement from the api (mfa_required) sends the user to SCREEN-003 with the requirement shown', async ({
      page,
      context,
      baseURL,
    }) => {
      await signedIn(context, baseURL!);
      await api(page, { campaigns: failure(403, 'mfa_required') });
      await page.goto('/campaigns');
      await page.waitForURL('**/mfa');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });

    for (const [state, title] of [
      ['suspended', 'This account is suspended'],
      ['removed', 'This account has been removed'],
      ['invite-invalid', 'This invitation cannot be used'],
    ] as const) {
      test(`invalid state ${state}: its own message, never the campaigns`, async ({
        page,
        context,
        baseURL,
      }) => {
        await signedIn(context, baseURL!);
        const calls = await api(page);
        await page.goto(`/access?state=${state}`);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
        expect(calls).toEqual([]);
        await shot(page, `8-access-${state}`);
      });
    }

    test('session expiry: an ended session returns to sign-in with the message and the requested page as return path', async ({
      page,
      context,
      baseURL,
    }) => {
      await signedIn(context, baseURL!, Math.floor(Date.now() / 1000) - 60);
      await api(page);
      await page.goto('/campaigns/new?draft=abc');
      await page.waitForURL('**/sign-in**');
      const url = new URL(page.url());
      expect(url.searchParams.get('reason')).toBe('session-expired');
      expect(url.searchParams.get('return')).toBe('/campaigns/new?draft=abc');
      await expect(page.getByText('Your session ended. Sign in to continue.')).toBeVisible();
      await shot(page, '9-session-expired');
      // Signing in again returns to the page that was open.
      await fillSignIn(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL('**/campaigns/new?draft=abc');
    });

    test('session expiry at the door: the running api answers 401 without a bearer, nothing is shown, sign-in carries the return path', async ({
      page,
      context,
      baseURL,
    }) => {
      await signedIn(context, baseURL!);
      const calls = await api(page, { real: true });
      await page.goto('/campaigns');
      await page.waitForURL('**/sign-in**');
      expect(calls).toContain('GET /campaigns');
      expect(new URL(page.url()).searchParams.get('return')).toBe('/campaigns');
      await expect(page.getByText('Morning Focus Blend')).toHaveCount(0);
    });

    for (const unsafe of [
      'https://evil.example/steal',
      '//evil.example',
      '/\\evil.example',
      '/sign-in?return=/campaigns',
    ]) {
      test(`unsafe return path ${unsafe} is ignored: sign-in lands on the campaigns, never off-site`, async ({
        page,
        baseURL,
      }) => {
        await api(page);
        await page.goto(`/sign-in?return=${encodeURIComponent(unsafe)}`);
        await fillSignIn(page);
        await page.getByRole('button', { name: 'Continue' }).click();
        // Finding F-1 (docs/evidence/TASK-108/findings.md): the sign-in action redirects to the home path "/", and the
        // client keeps "/" in the address bar while showing the campaigns; a reload lands on /campaigns. Owner: TASK-087.
        await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
        expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
        await page.reload();
        await expect(page).toHaveURL(`${baseURL}/campaigns`);
      });
    }

    test('back and cancel: browser Back from the second step returns to the campaigns with the session kept; a visit without a session cannot reach the campaigns', async ({
      page,
    }) => {
      await api(page);
      await page.goto('/sign-in?return=%2Fcampaigns');
      await fillSignIn(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL('**/campaigns');
      await page.goto('/mfa?step=enrol');
      await page.goBack();
      await expect(page).toHaveURL(/\/campaigns$/);
      // Cancel: leaving the second step unfinished (no code) and clearing the session sends the next visit to sign-in.
      await page.context().clearCookies();
      await page.goto('/mfa?step=enrol');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Set up two-step verification' }),
      ).toBeVisible();
      await page.goto('/campaigns');
      await page.waitForURL('**/sign-in**');
      expect(new URL(page.url()).searchParams.get('return')).toBe('/campaigns');
    });
  });
}

test.describe('@TASK-108 @TC-FLW-05 FLOW-05 keyboard only', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('sign in, the second step and the campaigns by keys only', async ({ page }) => {
    await api(page);
    await page.goto(`/sign-in?return=${encodeURIComponent(MFA_CHAIN)}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await page.getByLabel('Email address').focus();
    await page.keyboard.type(EMAIL);
    await page.keyboard.press('Tab');
    await page.keyboard.type(LOCAL_DEV_PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/mfa?**');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('6-digit code').focus();
    await page.keyboard.type(LOCAL_DEV_CODE);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/campaigns');
    await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
  });
});
