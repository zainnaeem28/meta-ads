import { copyFileSync, mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-091';
const NOW = '2026-11-16T12:00:00.000Z';
const ID = '8f3a0000-0000-4000-8000-00000000d001';
const meta = { requestId: 'req-e2e', timestamp: NOW };

const draft = (over: Record<string, unknown> = {}) => ({
  id: ID,
  version: 1,
  step: 2,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: 'Morning Focus Blend',
  productDescription:
    "Lion's Mane and Cordyceps capsules for a steady start to the day. 60 capsules, vegan, third-party tested. Taken with breakfast.",
  audience: {
    ageMin: 35,
    ageMax: 52,
    gender: 'all',
    interests: ['morning routines', 'nootropics', 'trail running'],
  },
  direction: { goal: 'conversion', tone: 'Calm and grounded', segmentCount: 3 },
  concept: null,
  script: null,
  productMediaId: null,
  campaignId: null,
  durationSeconds: 45,
  createdAt: '2026-11-16T08:00:00.000Z',
  updatedAt: '2026-11-16T08:00:00.000Z',
  ...over,
});
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';
const ok = (data: { version: number }, status = 200): Answer => ({
  status,
  headers: { etag: `"${String(data.version)}"` },
  body: { success: true, data, metaData: meta },
});
const failure = (status: number, code: string): Answer => ({
  status,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});

interface Api {
  get?: Answer;
  patch?: Answer;
  post?: Answer;
  del?: Answer;
}

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

/** Contract-shaped answers for API-021, 022, 023 and 025 (labelled mocks; the real-api test below proves the entry point). */
async function mockApi(page: Page, api: Api) {
  const origin = process.env.E2E_API_URL!;
  const calls: string[] = [];
  const headers: (string | null)[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-headers':
            (await request.headerValue('access-control-request-headers')) ?? '*',
          'access-control-allow-methods': '*',
        },
      });
    }
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/me/provider-keys')) {
      // The side card's own read (not a draft operation): answered here so the draft answer is not mistaken for a key list.
      return route.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            { provider: 'openai', configured: true, status: 'active' },
            { provider: 'wavespeed', configured: true, status: 'active' },
          ],
          metaData: meta,
        }),
      });
    }
    calls.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'PATCH') headers.push(await request.headerValue('if-match'));
    const answer: Answer =
      (request.method() === 'GET' && api.get) ||
      (request.method() === 'PATCH' && api.patch) ||
      (request.method() === 'POST' && api.post) ||
      (request.method() === 'DELETE' && api.del) ||
      failure(404, 'not_found');
    if (answer === 'hang') return new Promise<void>(() => undefined);
    return route.fulfill({
      status: answer.status,
      headers: { ...cors, ...(answer.headers ?? {}) },
      ...(answer.status === 204
        ? {}
        : { contentType: 'application/json', body: JSON.stringify(answer.body) }),
    });
  });
  return { calls, ifMatch: headers };
}

const settle = (page: Page) => page.evaluate(() => document.fonts.ready);
const heading = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
const goNext = (page: Page, name: RegExp) => page.getByRole('button', { name }).click();

test.describe('@TASK-091 SCREEN-006 new brief wizard (steps 1 to 3) through the built web app', () => {
  test.use({ timezoneId: 'UTC' });
  test.beforeEach(async ({ context, baseURL, page }) => {
    await signedIn(context, baseURL!);
    await page.clock.setFixedTime(NOW);
  });

  test('real api: the page calls API-022 on the running api; without a bearer it answers 401 and the session-ended dialog returns to this draft', async ({
    page,
  }) => {
    const origin = process.env.E2E_API_URL!;
    const sent: string[] = [];
    await page.route(`${origin}/**`, async (route) => {
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
    await page.goto(`/campaigns/new?draft=${ID}`);
    const dialog = page.getByRole('alertdialog', { name: 'Your session has ended' });
    await expect(dialog).toBeVisible();
    expect(sent).toContain(`GET /api/v1/drafts/${ID}`);
    await dialog.getByRole('button', { name: 'Sign in again' }).click();
    await page.waitForURL('**/sign-in**');
    expect(new URL(page.url()).searchParams.get('return')).toBe(`/campaigns/new?draft=${ID}`);
  });

  test('keyboard only: step 1 to step 3, autosave carries If-Match, only the listed operations are called', async ({
    page,
  }) => {
    const { calls, ifMatch } = await mockApi(page, {
      post: ok(draft({ step: 2 }), 201),
      patch: ok(draft({ version: 2 })),
      get: ok(draft({ step: 1 })),
    });
    await page.goto('/campaigns/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New brief' })).toBeVisible();
    expect(await page.title()).toBe('New brief · ShrooMap');
    await page.getByRole('radio', { name: /Describe the idea/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Paste a script/ })).toBeChecked();
    await page.getByRole('button', { name: /Next: Product/ }).focus();
    await page.keyboard.press('Enter');
    await heading(page, 'Tell us about the product');
    await page.getByLabel(/Product name/).fill('Morning Focus Blend');
    await page.getByLabel(/Product description/).fill('Capsules.');
    await expect(page.getByTestId('save-status')).toContainText('Draft saved just now');
    await page.getByRole('button', { name: /Next: Audience/ }).focus();
    await page.keyboard.press('Enter');
    await heading(page, 'Audience and direction');
    await page.getByRole('radio', { name: '1', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('segments-total')).toHaveText('2 segments × 15 s = 30 s total');
    await expect(page.getByTestId('save-status')).toContainText('Draft saved just now');
    expect(calls[0]).toBe('POST /api/v1/drafts');
    expect(calls.filter((c) => c.startsWith('PATCH')).length).toBeGreaterThan(0);
    expect(ifMatch.every((v) => v === '"1"' || v === '"2"')).toBe(true);
    expect(new Set(calls.map((c) => c.split(' ')[0]))).toEqual(new Set(['POST', 'PATCH']));
  });

  const read = ok(draft());
  const STATES: { state: string; url: string; api: Api; ready: (p: Page) => Promise<void> }[] = [
    {
      state: 'default',
      url: `/campaigns/new?draft=${ID}`,
      api: { get: read },
      ready: (p) => heading(p, 'Tell us about the product'),
    },
    {
      state: 'step-1',
      url: `/campaigns/new?draft=${ID}`,
      api: { get: ok(draft({ step: 1 })) },
      ready: (p) => heading(p, 'Choose the format'),
    },
    {
      state: 'step-3',
      url: `/campaigns/new?draft=${ID}`,
      api: { get: ok(draft({ step: 3 })) },
      ready: (p) => heading(p, 'Audience and direction'),
    },
    {
      state: 'validation-error',
      url: `/campaigns/new?draft=${ID}`,
      api: { get: ok(draft({ productName: null, productDescription: null })) },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await goNext(p, /Next: Audience/);
        await expect(p.getByRole('group', { name: 'Fix 2 things to continue' })).toBeFocused();
      },
    },
    {
      state: 'saving',
      url: `/campaigns/new?draft=${ID}`,
      api: { get: read, patch: 'hang' },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await goNext(p, /Next: Audience/);
        await expect(p.getByRole('button', { name: /Saving…/ })).toBeVisible();
        await expect(p.getByTestId('save-status')).toContainText('Saving draft…');
      },
    },
    {
      state: 'conflict',
      url: `/campaigns/new?draft=${ID}`,
      api: { get: read, patch: failure(409, 'version_conflict') },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await p.getByLabel(/Product name/).fill('Morning Focus Blend 2');
        await expect(p.getByText('This draft was changed in another tab')).toBeVisible();
      },
    },
    {
      state: 'key-missing',
      url: `/campaigns/new?draft=${ID}&block=key_missing`,
      api: { get: ok(draft({ step: 4 })) },
      ready: (p) => expect(p.getByText('Add your OpenAI key to generate the brief')).toBeVisible(),
    },
    {
      state: 'cap-reached',
      url: `/campaigns/new?draft=${ID}&block=spend_cap_reached`,
      api: { get: ok(draft({ step: 4 })) },
      ready: (p) => expect(p.getByText('Daily spend limit reached')).toBeVisible(),
    },
    {
      state: 'session-expired',
      url: `/campaigns/new?draft=${ID}`,
      api: { get: read, patch: failure(401, 'unauthenticated') },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await goNext(p, /Next: Audience/);
        await expect(p.getByRole('alertdialog', { name: 'Your session has ended' })).toBeVisible();
      },
    },
  ];

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    for (const { state, url, api, ready } of STATES) {
      test(`${state} at ${name} px: axe, screenshot, baseline`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        await mockApi(page, api);
        await page.goto(url);
        await ready(page);
        await settle(page);
        await expectNoAxeViolations(
          page,
          `${evidence}/axe/${info.project.name}-${state}-${name}.json`,
        );
        const full = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height: Math.max(height, full) });
        await settle(page);
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        const baseline = `fe-screen-006a-${state}-${name}.png`;
        await expect(page).toHaveScreenshot(baseline, { fullPage: true });
        copyFileSync(info.snapshotPath(baseline), `${evidence}/screenshots/${state}-${name}.png`);
      });
    }
  }
});
