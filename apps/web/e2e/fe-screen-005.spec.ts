import { copyFileSync, mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-090';
const NOW = '2026-11-16T12:00:00.000Z';
const meta = { requestId: 'req-e2e', timestamp: NOW };
const cursorMeta = (n: number, next: string | null) => ({
  ...meta,
  pagination: { type: 'cursor', limit: 10, returnedCount: n, hasNextPage: next !== null, nextCursor: next },
});
const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const camp = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('c', n),
  productName: `Product ${n}`,
  productDescriptionExcerpt: 'Description',
  progress: 'processing',
  briefState: 'accepted',
  segmentCount: 3,
  finalAvailable: false,
  createdAt: '2026-11-15T12:00:00.000Z',
  updatedAt: '2026-11-16T11:48:00.000Z',
  ...over,
});
const ROWS = [
  camp(1, { productName: 'Morning Focus Blend' }),
  camp(2, { productName: 'Evening Calm Gummies', progress: 'completed', finalAvailable: true, segmentCount: 4, updatedAt: '2026-11-16T10:00:00.000Z' }),
  camp(3, { productName: 'Cordyceps Trail Mix, spring launch with the long working title the team keeps', progress: 'failed', segmentCount: 2, updatedAt: '2026-11-15T09:00:00.000Z' }),
  camp(4, { productName: 'Reishi Night Tincture', progress: 'in_progress', briefState: 'draft', updatedAt: '2026-11-15T08:00:00.000Z' }),
  camp(5, { productName: 'Daily Greens + Chaga', progress: 'completed', finalAvailable: true, segmentCount: 1, updatedAt: '2026-11-13T09:00:00.000Z' }),
];
const dr = (n: number, over: Record<string, unknown>) => ({
  id: id('d', n),
  version: 1,
  step: 3,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: null,
  productDescription: null,
  audience: null,
  direction: null,
  concept: null,
  script: null,
  productMediaId: null,
  campaignId: null,
  durationSeconds: 45,
  createdAt: '2026-11-10T11:00:00.000Z',
  updatedAt: '2026-11-16T11:55:00.000Z',
  ...over,
});
const DRAFTS = [
  dr(1, { productName: "Lion's Mane Sampler Pack", step: 3 }),
  dr(2, { productName: null, step: 1, durationSeconds: null, updatedAt: '2026-11-15T11:00:00.000Z' }),
  dr(3, { productName: 'Chaga Chai Latte Mix', step: 4, durationSeconds: 60, updatedAt: '2026-11-12T11:00:00.000Z' }),
];

const key = (provider: string, configured = true) => ({
  provider,
  configured,
  status: configured ? 'active' : null,
  last4: configured ? '7Q2d' : null,
  fingerprint: configured ? '4f9a1c07b21e' : null,
  version: configured ? 1 : null,
  createdAt: null,
  updatedAt: null,
  lastValidatedAt: null,
  inFlightJobCount: 0,
});
const ok = (data: unknown, m: unknown = meta) => ({ status: 200, body: { success: true, data, metaData: m } });
const failure = (status: number, code: string, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});
const linked = ok({ linkState: 'linked', id: id('a', 1), role: 'user', status: 'active', mfa: { required: true, satisfied: true }, recentAuth: { satisfied: true, maxAgeSeconds: 600 }, keyNotices: [] });
const TOTALS: Record<string, number> = { '': 24, processing: 3, completed: 19, failed: 2 };

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';
interface Api {
  /** API-040 for a page of 10; a count read (limit 50) is answered from TOTALS. */
  campaigns?: (url: URL) => Answer;
  drafts?: unknown[];
  keys?: unknown[];
  deleteCampaign?: () => Answer;
  deleteDraft?: () => Answer;
}

const signedIn = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp: Math.floor(Date.now() / 1000) + 600 }),
      url: baseURL,
    },
  ]);

const listPage = (rows: unknown[], next: string | null = null) => ok(rows, cursorMeta(rows.length, next));

/**
 * Contract-shaped answers for API-040, 020, 042, 025 and the shell's API-001 and API-010 (labelled mocks: the browser
 * is relayed with CORS headers, the answer is fixed). The real-integration proof is the flow ticket; `real api` below
 * only proves the entry point.
 */
async function mockApi(page: Page, api: Api = {}) {
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
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*' } });
    }
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    let answer: Answer;
    if (url.pathname.endsWith('/me/provider-keys')) answer = ok(api.keys ?? [key('openai'), key('wavespeed')]);
    else if (url.pathname.endsWith('/me')) answer = linked;
    else if (url.pathname.endsWith('/drafts')) answer = listPage(api.drafts ?? DRAFTS);
    else if (/\/drafts\/[^/]+$/.test(url.pathname) && request.method() === 'DELETE') answer = api.deleteDraft?.() ?? { status: 204 };
    else if (/\/campaigns\/[^/]+$/.test(url.pathname) && request.method() === 'DELETE') {
      answer = api.deleteCampaign?.() ?? ok({ deletionRunId: id('e', 1), state: 'running' });
      if (answer !== 'hang' && answer.status === 200) answer = { ...answer, status: 202 };
    } else if (url.pathname.endsWith('/campaigns')) {
      if (url.searchParams.get('limit') === '50') {
        const n = Math.min(TOTALS[url.searchParams.get('filter') ?? ''] ?? 0, 50);
        answer = listPage(Array.from({ length: n }, (_, i) => camp(i + 1)));
      } else answer = api.campaigns?.(url) ?? listPage(ROWS, 'cur-1');
    } else answer = failure(404, 'not_found');
    if (answer === 'hang') return new Promise<void>(() => undefined);
    return route.fulfill({
      status: answer.status,
      headers: { ...cors, ...(answer.headers ?? {}) },
      ...(answer.status === 204 ? {} : { contentType: 'application/json', body: JSON.stringify(answer.body) }),
    });
  });
  return { calls };
}

const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
};
const list = (page: Page) => page.getByRole('list', { name: 'Campaign history' });
const noCampaigns = () => listPage([]);

test.describe('@TASK-090 SCREEN-005 campaigns through the built web app', () => {
  test.use({ timezoneId: 'UTC' });
  test.beforeEach(async ({ context, baseURL, page }) => {
    await signedIn(context, baseURL!);
    await page.clock.setFixedTime(NOW);
  });

  test('real api: the page calls API-040 on the running api; without a bearer it answers 401 and the user goes to sign-in', async ({ page }) => {
    const origin = process.env.E2E_API_URL!;
    const sent: string[] = [];
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const cors = { 'access-control-allow-origin': (await request.headerValue('origin')) ?? '*', 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'x-request-id' };
      if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*' } });
      }
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    await page.goto('/campaigns');
    await page.waitForURL('**/sign-in**');
    expect(sent).toContain('GET /api/v1/campaigns');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/campaigns');
  });

  test('default: rows open their stage, chips and tabs carry counts, only the listed operations are called', async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto('/campaigns');
    await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
    expect(await page.title()).toBe('Campaigns · ShrooMap');
    await expect(list(page).getByRole('listitem')).toHaveCount(5);
    await expect(list(page).getByRole('button', { name: 'Delete Cordyceps Trail Mix, spring launch with the long working title the team keeps' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(list(page).getByRole('link', { name: 'Morning Focus Blend' })).toHaveAttribute('href', `/campaigns/${id('c', 1)}/clips`);
    await expect(list(page).getByRole('link', { name: 'Evening Calm Gummies' })).toHaveAttribute('href', `/campaigns/${id('c', 2)}/final`);
    await expect(list(page).getByRole('link', { name: 'Reishi Night Tincture' })).toHaveAttribute('href', `/campaigns/${id('c', 4)}/brief`);
    await expect(page.getByRole('tab', { name: /History/ })).toContainText('24');
    await expect(page.getByRole('tab', { name: /Drafts/ })).toContainText('3');
    await expect(page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /Completed/ })).toContainText('19');
    expect(new Set(calls.map((c) => c.split('?')[0]))).toEqual(new Set(['GET /api/v1/me', 'GET /api/v1/me/provider-keys', 'GET /api/v1/campaigns', 'GET /api/v1/drafts']));
  });

  test('keyboard only: search, a status chip, then Next, with the URL and the api query following', async ({ page }) => {
    const { calls } = await mockApi(page, { campaigns: (url) => (url.searchParams.get('cursor') ? listPage([camp(11, { productName: 'Second page row' })]) : listPage(ROWS, 'cur-1')) });
    await page.goto('/campaigns');
    await expect(list(page)).toBeVisible();
    await page.getByRole('searchbox').focus();
    await page.keyboard.type('reishi');
    await expect(page).toHaveURL(/\?q=reishi$/);
    await page.getByRole('button', { name: /^Failed/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\?q=reishi&status=failed$/);
    await expect(page.getByRole('button', { name: /^Failed/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /Next/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/status=failed&page=2$/);
    await expect(page.getByRole('link', { name: 'Second page row' })).toBeVisible();
    expect(calls.some((c) => c.includes('q=reishi') && c.includes('filter=failed') && c.includes('cursor=cur-1'))).toBe(true);
    await page.getByRole('button', { name: 'Clear all' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/campaigns$/);
  });

  test('delete: the dialog states the media removal, API-042 is called, the toast shows and the row goes', async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Delete Reishi Night Tincture' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete "Reishi Night Tincture"?' });
    await expect(dialog).toContainText('including its brief, its clips, any final video and the product image');
    await dialog.getByRole('button', { name: 'Delete campaign' }).click();
    await expect(page.getByText('Campaign deleted. Its media is being removed in the background.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Reishi Night Tincture' })).toHaveCount(0);
    expect(calls).toContain(`DELETE /api/v1/campaigns/${id('c', 4)}`);
  });

  test('draft delete calls API-025', async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto('/campaigns?tab=drafts');
    await page.getByRole('button', { name: 'Delete draft Untitled draft' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete draft' }).click();
    await expect(page.getByText('Draft deleted. Its product image is removed.')).toBeVisible();
    expect(calls).toContain(`DELETE /api/v1/drafts/${id('d', 2)}`);
  });

  const STATES: { state: string; path: string; api: () => Api; ready: (p: Page) => Promise<void> }[] = [
    { state: 'default', path: '/campaigns', api: () => ({}), ready: (p) => expect(list(p)).toBeVisible() },
    { state: 'loading', path: '/campaigns', api: () => ({ campaigns: () => 'hang' }), ready: (p) => expect(p.getByText('Loading campaigns').first()).toBeVisible() },
    { state: 'empty', path: '/campaigns', api: () => ({ campaigns: noCampaigns, drafts: [] }), ready: (p) => expect(p.getByRole('heading', { name: 'No campaigns yet' })).toBeVisible() },
    { state: 'no-results', path: '/campaigns?q=reishi+gummies', api: () => ({ campaigns: noCampaigns }), ready: (p) => expect(p.getByRole('heading', { name: 'No campaigns match "reishi gummies"' })).toBeVisible() },
    { state: 'error', path: '/campaigns', api: () => ({ campaigns: () => failure(500, 'internal_error') }), ready: (p) => expect(p.getByRole('button', { name: /Try again/ })).toBeVisible({ timeout: 15_000 }) },
    {
      state: 'delete-confirm',
      path: '/campaigns',
      api: () => ({}),
      ready: async (p) => {
        await p.getByRole('button', { name: 'Delete Reishi Night Tincture' }).click();
        await expect(p.getByRole('dialog', { name: 'Delete "Reishi Night Tincture"?' })).toBeVisible();
      },
    },
    {
      state: 'deleted',
      path: '/campaigns',
      api: () => ({}),
      ready: async (p) => {
        await p.getByRole('button', { name: 'Delete Reishi Night Tincture' }).click();
        await p.getByRole('dialog').getByRole('button', { name: 'Delete campaign' }).click();
        await expect(p.getByText('Campaign deleted. Its media is being removed in the background.')).toBeVisible();
      },
    },
    { state: 'drafts', path: '/campaigns?tab=drafts', api: () => ({}), ready: (p) => expect(p.getByRole('list', { name: 'Drafts' })).toBeVisible() },
    { state: 'key-missing', path: '/campaigns', api: () => ({ keys: [key('openai'), key('wavespeed', false)] }), ready: (p) => expect(p.getByText('Add your provider keys to start generating')).toBeVisible() },
    {
      state: 'menu-open',
      path: '/campaigns',
      api: () => ({}),
      ready: async (p) => {
        await expect(list(p)).toBeVisible();
        await p.getByRole('button', { name: 'Operator account menu' }).click();
        await expect(p.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
      },
    },
  ];

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    for (const { state, path, api, ready } of STATES) {
      test(`${state} at ${name} px: axe, screenshot, baseline`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        await mockApi(page, api());
        await page.goto(path);
        await ready(page);
        await settle(page);
        await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-${state}-${name}.json`);
        // Size the viewport to the page so the fixed bottom nav sits at the page bottom, not over the content.
        const full = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height: Math.max(height, full) });
        await settle(page);
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        const baseline = `fe-screen-005-${state}-${name}.png`;
        await expect(page).toHaveScreenshot(baseline, { fullPage: true });
        copyFileSync(info.snapshotPath(baseline), `${evidence}/screenshots/${state}-${name}.png`);
      });
    }
  }
});
