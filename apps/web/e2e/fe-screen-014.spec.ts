import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-102';
const NOW = '2026-11-16T12:00:00.000Z';
const U1 = 'c07e0000-0000-4000-8000-000000009b30';
const U2 = '8f3a0000-0000-4000-8000-00000000c21d';
const U3 = '41b90000-0000-4000-8000-0000000007ae';
const meta = { requestId: 'req-e2e', timestamp: NOW };

const ALERTS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'account_erasure_stuck',
    subjectUserId: U1,
    raisedAt: '2026-11-16T08:41:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    counts: { remaining_objects: 7, attempts: 6 },
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'job_burst',
    subjectUserId: U2,
    raisedAt: '2026-11-16T07:15:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    counts: { jobs: 24, window_minutes: 10, limit: 20 },
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'admin_role_changed',
    subjectUserId: U3,
    raisedAt: '2026-11-15T17:02:00.000Z',
    acknowledgedAt: '2026-11-15T18:00:00.000Z',
    acknowledgedBy: U2,
    counts: {},
  },
];
const page_ = (data: unknown[]) => ({
  success: true,
  data,
  metaData: {
    ...meta,
    pagination: {
      type: 'cursor',
      limit: 50,
      returnedCount: data.length,
      hasNextPage: false,
      nextCursor: null,
    },
  },
});
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

/**
 * Contract-shaped answers for API-125 and API-126 (labelled mocks: the browser is relayed with CORS headers, the
 * answer is fixed). The real-integration proof is the flow ticket; `real api` below only proves the entry point.
 */
async function mockApi(page: Page, list: Answer, acknowledge?: (id: string) => Answer) {
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
    const ack = /\/admin\/alerts\/([^/]+)\/acknowledge$/.exec(url.pathname);
    const answer = ack ? (acknowledge?.(ack[1]!) ?? 'hang') : list;
    if (answer === 'hang') return new Promise<void>(() => undefined);
    return route.fulfill({
      status: answer.status,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  return calls;
}

const ok = (data: unknown[]) => ({ status: 200, body: page_(data) });
const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
};

test.describe('@TASK-102 SCREEN-014 admin alerts through the built web app', () => {
  test.use({ timezoneId: 'UTC' });
  test.beforeEach(async ({ context, baseURL, page }) => {
    await signedIn(context, baseURL!);
    await page.clock.setFixedTime(NOW);
  });

  test('real api: the page calls API-125 on the running api; without a bearer it answers 401 and the user goes to sign-in', async ({
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
    await page.goto('/admin/alerts');
    await page.waitForURL('**/sign-in**');
    expect(sent).toContain('GET /api/v1/admin/alerts');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/admin/alerts');
  });

  test('default: rows, badge count, only API-125 called, keyboard-only Acknowledge calls API-126', async ({
    page,
  }) => {
    const calls = await mockApi(page, ok(ALERTS), (id) => ({
      status: 200,
      body: {
        success: true,
        data: { ...ALERTS.find((a) => a.id === id)!, acknowledgedAt: NOW, acknowledgedBy: U3 },
        metaData: meta,
      },
    }));
    await page.goto('/admin/alerts');
    await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
    expect(await page.title()).toBe('Alerts · ShrooMap');
    const list = page.getByRole('list', { name: 'Alerts' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list).toContainText(
      'u_c07e…9b30: 7 stored objects could not be removed after 6 attempts',
    );
    await expect(list).not.toContainText('@');
    await expect(page.locator('[data-alert-count]').first()).toContainText('2');
    await page.getByRole('button', { name: 'Acknowledge: Unusual job volume' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Alert acknowledged.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Acknowledge:/ })).toHaveCount(1);
    await expect(page.locator('[data-alert-count]').first()).toContainText('1');
    expect(calls).toEqual([
      'GET /api/v1/admin/alerts?limit=50',
      'POST /api/v1/admin/alerts/22222222-2222-4222-8222-222222222222/acknowledge',
    ]);
  });

  test('forbidden_role: the shell shows its unavailable state without navigation', async ({
    page,
  }) => {
    await mockApi(page, failure(403, 'forbidden_role'));
    await page.goto('/admin/alerts');
    await expect(page.getByText('Administration is not available')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expectNoAxeViolations(page, `${evidence}/axe/forbidden_role.json`);
  });

  test('recent_auth_required: step-up dialog with the section 9.1 copy, Escape closes it', async ({
    page,
  }) => {
    await mockApi(page, failure(403, 'recent_auth_required'));
    await page.goto('/admin/alerts');
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('For your security, confirm it is you again to continue.');
    await expect(dialog.getByRole('button', { name: 'Confirm sign-in' })).toBeVisible();
    await expectNoAxeViolations(page, `${evidence}/axe/recent_auth_required.json`);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  const STATES = [
    {
      state: 'default',
      list: () => ok(ALERTS),
      ready: (p: Page) => expect(p.getByRole('list', { name: 'Alerts' })).toBeVisible(),
    },
    {
      state: 'empty',
      list: () => ok([]),
      ready: (p: Page) => expect(p.getByRole('heading', { name: 'No alerts' })).toBeVisible(),
    },
    {
      state: 'loading',
      list: (): Answer => 'hang',
      ready: (p: Page) => expect(p.getByText('Loading alerts')).toBeVisible(),
    },
    {
      state: 'acknowledged',
      list: () => ok(ALERTS),
      ready: async (p: Page) => {
        await p.getByRole('button', { name: 'Acknowledge: Account erasure is stuck' }).focus();
        await p.keyboard.press('Enter');
        await expect(p.getByText('Alert acknowledged.')).toBeVisible();
      },
    },
  ] as const;

  for (const { name, width, height } of VIEWPORTS) {
    for (const { state, list, ready } of STATES) {
      test(`${state} at ${name} px: axe, screenshot, baseline`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        await mockApi(page, list(), (id) => ({
          status: 200,
          body: {
            success: true,
            data: { ...ALERTS.find((a) => a.id === id)!, acknowledgedAt: NOW, acknowledgedBy: U3 },
            metaData: meta,
          },
        }));
        await page.goto('/admin/alerts');
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
        await expect(page).toHaveScreenshot(`fe-screen-014-${state}-${name}.png`, {
          fullPage: true,
        });
      });
    }
  }
});
