import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

// TC-FLW-13 (FLOW-13, J-08): the admin usage report through the built web app (`next start`) and the built api.
// The signed-in api answers are a labelled contract mock (API-130 shape): the built web sends no bearer without an
// identity provider and the api's local identity mints tokens only in-process, so no real admin token exists out of
// process. The 401 step is the real api. Every mock answer is the documented contract; none is invented.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-114';
const NOW = '2026-11-14T22:40:00.000Z';
const U1 = '8f3a0000-0000-4000-8000-00000000c21d';
const meta = { requestId: 'req-flow13', timestamp: NOW };
const usage = (provider: string, calls: number, failed: number, cost: string, p95: number) => ({
  provider,
  calls,
  succeeded: calls - failed,
  failed,
  rejected: 0,
  unconfirmed: 0,
  estimatedCostUsd: cost,
  latencyP50Ms: p95 / 2,
  latencyP95Ms: p95,
});
const REPORT = {
  from: '2026-10-15T00:00:00.000Z',
  to: NOW,
  asOf: NOW,
  empty: false,
  costBasis: 'estimate_from_configured_price_table',
  accounts: [
    {
      userId: U1,
      providers: [
        usage('wavespeed', 402, 14, '201.4000', 94000),
        usage('openai', 318, 4, '38.2000', 6100),
      ],
    },
  ],
  providers: [
    usage('wavespeed', 402, 14, '201.4000', 94000),
    usage('openai', 318, 4, '38.2000', 6100),
  ],
  jobStates: { succeeded: 512, failed: 23, in_progress: 4 },
  claimChecks: [{ class: 'high_risk', raised: 21, closedByEdit: 21, clearedWithReason: 0 }],
};
const ok = (data: unknown) => ({ status: 200, body: { success: true, data, metaData: meta } });
const failure = (status: number, code: string) => ({
  status,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});
type Answer = { status: number; body: unknown };

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

/** Answers API-130 from `answer` (called per request); `passThrough` relays to the running api instead. */
async function api(page: Page, answer: (n: number, search: URLSearchParams) => Answer | 'real') {
  const origin = process.env.E2E_API_URL!;
  const calls: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag',
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
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    const a = answer(calls.length, url.searchParams);
    if (a === 'real') {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    }
    return route.fulfill({
      status: a.status,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify(a.body),
    });
  });
  return calls;
}

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`@TASK-114 @TC-FLW-13 FLOW-13 admin usage report at ${name} px`, () => {
    test.use({ timezoneId: 'UTC', viewport: { width, height } });
    test.beforeEach(async ({ context, baseURL, page }) => {
      await signedIn(context, baseURL!);
      await page.clock.setFixedTime(NOW);
    });

    const shot = async (page: Page, label: string, axe = true) => {
      await page.evaluate(() => document.fonts.ready);
      if (axe) await expectNoAxeViolations(page, `${evidence}/axe/${label}-${name}.json`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await page.screenshot({
        path: `${evidence}/screenshots/${label}-${name}.png`,
        fullPage: true,
      });
    };

    test('open the report, change the window by keyboard, carry it in the URL and keep it on reload and back', async ({
      page,
    }) => {
      const calls = await api(page, () => ok(REPORT));
      await page.goto('/admin/accounts');
      await page.goto('/admin/usage');
      await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
      await expect(page.getByText('US$')).not.toHaveCount(0);
      await expect(page.getByLabel('Time window')).toHaveValue('30');
      await shot(page, 'open-report');

      // Keyboard only: focus the window select and choose 90 days.
      await page.getByLabel('Time window').focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByLabel('Time window')).toHaveValue('90');
      const reports = () => calls.filter((c) => c.includes('/admin/usage-report'));
      await expect.poll(() => reports().length).toBe(2);
      const q = new URL(reports()[1]!.split(' ')[1]!, 'http://x').searchParams;
      expect(Date.parse(q.get('to')!) - Date.parse(q.get('from')!)).toBe(90 * 86_400_000);
      await expect(page).toHaveURL(/\/admin\/usage\?from=2026-08-17&to=2026-11-14/);
      await shot(page, 'window-changed');

      // The window is carried by the URL: a reload asks for the same window.
      await page.reload();
      await expect(page.getByLabel('Time window')).toHaveValue('90');
      await expect(page.getByRole('table', { name: 'By account and provider' })).toBeVisible();

      // Back leaves the report for the page before it, never a half-built state.
      await page.goBack();
      await expect(page).toHaveURL(/\/admin\/accounts/);
    });

    test('a window above 366 days is refused with the limit and no request; a valid one then succeeds', async ({
      page,
    }) => {
      const calls = await api(page, () => ok(REPORT));
      await page.goto('/admin/usage');
      await expect(page.getByRole('table', { name: 'By account and provider' })).toBeVisible();
      await page.getByLabel('Time window').selectOption('custom');
      await page.getByLabel('From').fill('2025-10-01');
      await page.getByLabel('To').fill('2026-11-14');
      await page.getByRole('button', { name: 'Apply' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText('Choose a window of 366 days or fewer.')).toBeVisible();
      await page.waitForTimeout(500);
      expect(calls.filter((c) => c.includes('2025-10-01'))).toEqual([]);
      await shot(page, 'window-too-large');

      // Cancel path: choosing a preset again drops the refused dates and shows a report.
      await page.getByLabel('Time window').selectOption('7');
      await expect(page.getByText('Choose a window of 366 days or fewer.')).toHaveCount(0);
      await expect(page.getByRole('table', { name: 'By account and provider' })).toBeVisible();
    });

    test('the api refusing a window (422) shows the limit, never a report', async ({ page }) => {
      await api(page, (_n, s) =>
        s.has('from') ? failure(422, 'report_window_too_large') : ok(REPORT),
      );
      await page.goto('/admin/usage?from=2026-10-01&to=2026-10-31');
      await expect(page.getByText('Choose a window of 366 days or fewer.')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Brand checks' })).toHaveCount(0);
      await shot(page, 'window-refused-by-api');
    });

    test('a failed source shows the error state, then Try again shows the report', async ({
      page,
    }) => {
      let down = true;
      await api(page, () => (down ? failure(503, 'service_unavailable') : ok(REPORT)));
      await page.goto('/admin/usage');
      await expect(
        page.getByRole('heading', { name: 'The report could not be built' }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('US$')).toHaveCount(0);
      await shot(page, 'error');
      down = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('table', { name: 'Brand checks' })).toBeVisible();
    });

    test('a non-admin gets 403 and the unavailable state with no administration navigation', async ({
      page,
    }) => {
      await api(page, () => failure(403, 'forbidden_role'));
      await page.goto('/admin/usage');
      await expect(page.getByText('Administration is not available')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Usage report' })).toHaveCount(0);
      await shot(page, 'non-admin-unavailable');
    });

    test('session expiry: the running api answers 401 without a bearer and the user goes to sign-in with a return path', async ({
      page,
    }) => {
      const calls = await api(page, () => 'real');
      await page.goto('/admin/usage?from=2026-10-01&to=2026-10-31');
      await page.waitForURL('**/sign-in**');
      expect(calls.some((c) => c.startsWith('GET /api/v1/admin/usage-report'))).toBe(true);
      // The return path is the report; the window (query) is not carried back (finding F-114-1, owner TASK-103).
      expect(new URL(page.url()).searchParams.get('return')).toBe('/admin/usage');
      await shot(page, 'session-expired-sign-in');
    });
  });
}
