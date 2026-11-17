import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-103';
const NOW = '2026-11-14T22:40:00.000Z';
const U1 = '8f3a0000-0000-4000-8000-00000000c21d';
const U2 = '41b90000-0000-4000-8000-0000000007ae';
const U3 = '77d20000-0000-4000-8000-00000000e5f1';
const meta = { requestId: 'req-e2e', timestamp: NOW };

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
    {
      userId: U2,
      providers: [
        usage('wavespeed', 256, 9, '128.0000', 88000),
        usage('openai', 190, 8, '24.0000', 5400),
      ],
    },
    { userId: U3, providers: [usage('wavespeed', 118, 0, '21.0000', 91000)] },
  ],
  providers: [
    usage('wavespeed', 776, 23, '350.4000', 94000),
    usage('openai', 508, 12, '62.2000', 6100),
  ],
  jobStates: { succeeded: 512, failed: 23, in_progress: 4 },
  claimChecks: [
    { class: 'high_risk', raised: 21, closedByEdit: 21, clearedWithReason: 0 },
    { class: 'other', raised: 75, closedByEdit: 63, clearedWithReason: 12 },
  ],
};
const EMPTY = {
  ...REPORT,
  empty: true,
  accounts: [],
  providers: [],
  jobStates: {},
  claimChecks: [],
};
const ok = (data: unknown) => ({ status: 200, body: { success: true, data, metaData: meta } });
const failure = (status: number, code: string) => ({
  status,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});

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

type Answer = { status: number; body: unknown } | 'hang';

/** Contract-shaped answers for API-130 (a labelled mock: the browser is relayed with CORS headers, the answer is fixed). */
async function mockApi(page: Page, answer: (search: URLSearchParams) => Answer) {
  const api = process.env.E2E_API_URL!;
  const calls: string[] = [];
  await page.route(`${api}/**`, async (route) => {
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
    const a = answer(url.searchParams);
    if (a === 'hang') return new Promise<void>(() => undefined);
    return route.fulfill({
      status: a.status,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify(a.body),
    });
  });
  return calls;
}

const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
};

test.describe('@TASK-103 SCREEN-015 admin usage report through the built web app', () => {
  test.use({ timezoneId: 'UTC' });
  test.beforeEach(async ({ context, baseURL, page }) => {
    await signedIn(context, baseURL!);
    await page.clock.setFixedTime(NOW);
  });

  test('real api: the page calls API-130 on the running api; without a bearer it answers 401 and the user goes to sign-in', async ({
    page,
  }) => {
    const api = process.env.E2E_API_URL!;
    const sent: string[] = [];
    await page.route(`${api}/**`, async (route) => {
      const request = route.request();
      const cors = {
        'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'x-request-id',
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
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    await page.goto('/admin/usage');
    await page.waitForURL('**/sign-in**');
    expect(sent).toContain('GET /api/v1/admin/usage-report');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/admin/usage');
  });

  test('default: tiles, tables, estimate labels, only API-130 called, keyboard-only window change', async ({
    page,
  }) => {
    const calls = await mockApi(page, () => ok(REPORT));
    await page.goto('/admin/usage');
    await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
    expect(await page.title()).toBe('Usage report · ShrooMap');
    await expect(page.getByText('US$412.60')).toBeVisible();
    await expect(page.getByText('Estimated cost (estimated)')).toBeVisible();
    await expect(page.getByText('14 Nov 2026, 22:40 UTC')).toBeVisible();
    const accounts = page.getByRole('table', { name: 'By account and provider' });
    await expect(accounts.getByRole('row')).toHaveCount(6);
    await expect(accounts).toContainText('u_8f3a…c21d');
    await expect(page.locator('main')).not.toContainText('@');
    await page.getByLabel('Time window').focus();
    await page.getByLabel('Time window').selectOption('90');
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[0]).toBe('GET /api/v1/admin/usage-report');
    const q = new URL(calls[1]!.split(' ')[1]!, 'http://x').searchParams;
    expect(Date.parse(q.get('to')!) - Date.parse(q.get('from')!)).toBe(90 * 86_400_000);
    expect(page.url()).toContain('/admin/usage?from=2026-08-17&to=2026-11-14');
  });

  test('url window: ?from=&to= opens as custom dates and asks for exactly that window', async ({
    page,
  }) => {
    const calls = await mockApi(page, () => ok(REPORT));
    await page.goto('/admin/usage?from=2026-10-01&to=2026-10-31');
    await expect(page.getByText('US$412.60')).toBeVisible();
    await expect(page.getByLabel('Time window')).toHaveValue('custom');
    await expect(page.getByLabel('From')).toHaveValue('2026-10-01');
    expect(calls).toEqual([
      'GET /api/v1/admin/usage-report?from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z',
    ]);
  });

  test('forbidden_role: the shell shows its unavailable state without navigation', async ({
    page,
  }) => {
    await mockApi(page, () => failure(403, 'forbidden_role'));
    await page.goto('/admin/usage');
    await expect(page.getByText('Administration is not available')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expectNoAxeViolations(page, `${evidence}/axe/forbidden_role.json`);
  });

  const STATES = [
    {
      state: 'default',
      answer: (): Answer => ok(REPORT),
      ready: (p: Page) => expect(p.getByRole('table', { name: 'Brand checks' })).toBeVisible(),
    },
    {
      state: 'empty',
      answer: (): Answer => ok(EMPTY),
      ready: (p: Page) =>
        expect(p.getByRole('heading', { name: 'No usage in this window' })).toBeVisible(),
    },
    {
      state: 'loading',
      answer: (): Answer => 'hang',
      ready: (p: Page) => expect(p.getByText('Loading Provider calls')).toBeAttached(),
    },
    {
      state: 'error',
      answer: (): Answer => failure(503, 'service_unavailable'),
      ready: (p: Page) =>
        expect(p.getByRole('heading', { name: 'The report could not be built' })).toBeVisible({
          timeout: 15_000,
        }),
    },
    {
      state: 'window-too-large',
      answer: (s: URLSearchParams): Answer =>
        s.has('from') ? failure(422, 'report_window_too_large') : ok(REPORT),
      ready: async (p: Page) => {
        await expect(p.getByRole('table', { name: 'Brand checks' })).toBeVisible();
        await p.getByLabel('Time window').selectOption('custom');
        await p.getByLabel('From').fill('2025-10-01');
        await p.getByLabel('To').fill('2026-11-14');
        await p.getByRole('button', { name: 'Apply' }).click();
        await expect(p.getByText('Choose a window of 366 days or fewer.')).toBeVisible();
      },
    },
  ] as const;

  for (const { name, width, height } of VIEWPORTS) {
    for (const { state, answer, ready } of STATES) {
      test(`${state} at ${name} px: axe, screenshot, baseline`, async ({ page }, info) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height });
        await mockApi(page, answer);
        await page.goto('/admin/usage');
        await ready(page);
        await settle(page);
        await expectNoAxeViolations(
          page,
          `${evidence}/axe/${info.project.name}-${state}-${name}.json`,
        );
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        await page.screenshot({
          path: `${evidence}/screenshots/${state}-${name}.png`,
          fullPage: true,
        });
        await expect(page).toHaveScreenshot(`fe-screen-015-${state}-${name}.png`, {
          fullPage: true,
        });
      });
    }
  }
});
