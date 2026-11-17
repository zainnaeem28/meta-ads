import { copyFileSync, mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-092';
const NOW = '2026-11-16T12:00:00.000Z';
const ID = '8f3a0000-0000-4000-8000-00000000d001';
const MEDIA = '8f3a0000-0000-4000-8000-00000000e001';
const CAMPAIGN = '8f3a0000-0000-4000-8000-00000000c001';
const meta = { requestId: 'req-e2e', timestamp: NOW };

const draft = (over: Record<string, unknown> = {}) => ({
  id: ID,
  version: 1,
  step: 2,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: 'Morning Focus Blend',
  productDescription:
    "Lion's Mane and Cordyceps capsules for a steady start to the day. 60 capsules, vegan, third-party tested.",
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
const media = (over: Record<string, unknown> = {}) => ({
  id: MEDIA,
  kind: 'upload',
  state: 'ready',
  contentType: 'image/png',
  bytes: 184_320,
  width: 800,
  height: 800,
  rejectReason: null,
  attached: false,
  campaignId: null,
  createdAt: NOW,
  ...over,
});
const job = (state: string) => ({
  id: '8f3a0000-0000-4000-8000-00000000b001',
  state,
  label: 'image_analysis',
  causeClass: null,
  causeMessage: null,
  createdAt: NOW,
  updatedAt: NOW,
  reused: false,
});

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';
const ok = (data: unknown, status = 200): Answer => ({
  status,
  headers: { etag: `"${String((data as { version?: number }).version ?? 1)}"` },
  body: { success: true, data, metaData: meta },
});
const failure = (status: number, code: string): Answer => ({
  status,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});

/** Answers by `METHOD /path` (after /api/v1); anything not listed is a 404 the test would notice in `calls`. */
type Routes = Record<string, Answer>;

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

/** Contract-shaped answers for API-021 to 025, 030, 031, 035, 036 (labelled mocks; the real-api test proves the entry point). */
async function mockApi(page: Page, routes: Routes) {
  const origin = process.env.E2E_API_URL!;
  const calls: string[] = [];
  const keys: (string | null)[] = [];
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
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const call = `${request.method()} ${path}`;
    calls.push(call);
    if (call.endsWith('/submit') || call.endsWith('/analysis'))
      keys.push(await request.headerValue('idempotency-key'));
    const answer: Answer = routes[call] ?? failure(404, 'not_found');
    if (answer === 'hang') return new Promise<void>(() => undefined);
    return route.fulfill({
      status: answer.status,
      headers: { ...cors, ...(answer.headers ?? {}) },
      ...(answer.status === 204
        ? {}
        : { contentType: 'application/json', body: JSON.stringify(answer.body) }),
    });
  });
  return { calls, keys };
}

const settle = (page: Page) => page.evaluate(() => document.fonts.ready);
const heading = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
const PNG = {
  name: 'morning-focus-blend.png',
  mimeType: 'image/png',
  buffer: Buffer.alloc(184_320, 1),
};
const pick = (page: Page, file: { name: string; mimeType: string; buffer: Buffer } = PNG) =>
  page.getByTestId('file-upload-input').setInputFiles(file);
const GET_DRAFT = `GET /drafts/${ID}`;
const PATCH_DRAFT = `PATCH /drafts/${ID}`;
const SUBMIT = `POST /drafts/${ID}/submit`;
const step4 = (over: Record<string, unknown> = {}) =>
  ok(
    draft({
      step: 4,
      productMediaId: MEDIA,
      concept:
        'A calm morning routine: she takes the capsules with breakfast, then heads out for a trail run.',
      ...over,
    }),
  );

test.describe('@TASK-092 SCREEN-006 new brief wizard (image upload, review and generate) through the built web app', () => {
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

  test('real api: the upload reaches API-030 on the running api, which refuses it without a bearer', async ({
    page,
  }) => {
    const origin = process.env.E2E_API_URL!;
    const sent: { call: string; status: number }[] = [];
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
      if (request.method() === 'GET')
        return route.fulfill({
          status: 200,
          headers: { ...cors, etag: '"1"' },
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: draft(), metaData: meta }),
        });
      const response = await route.fetch();
      sent.push({
        call: `${request.method()} ${new URL(request.url()).pathname}`,
        status: response.status(),
      });
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    await page.goto(`/campaigns/new?draft=${ID}`);
    await heading(page, 'Tell us about the product');
    await pick(page);
    await expect(page.getByRole('alertdialog', { name: 'Your session has ended' })).toBeVisible();
    expect(sent).toEqual([{ call: 'POST /api/v1/media', status: 401 }]);
  });

  test('keyboard only: upload, processing to ready, analysis, step 3 to step 4, generate; only the listed operations are called', async ({
    page,
  }) => {
    let reads = 0;
    const { calls, keys } = await mockApi(page, {
      [GET_DRAFT]: ok(draft()),
      [PATCH_DRAFT]: ok(draft({ version: 2, productMediaId: MEDIA })),
      'POST /media': ok(media({ state: 'processing' }), 201),
      [`GET /media/${MEDIA}`]: ok(media()),
      [SUBMIT]: ok(
        { campaignId: CAMPAIGN, briefJob: { ...job('pending'), label: 'brief_generation' } },
        202,
      ),
    });
    // The analysis read answers "none" first, then the finished description.
    await page.route(`${process.env.E2E_API_URL}/api/v1/media/${MEDIA}/analysis`, async (route) => {
      const request = route.request();
      const cors = {
        'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'x-request-id,etag',
      };
      if (request.method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: {
            ...cors,
            'access-control-allow-headers':
              (await request.headerValue('access-control-request-headers')) ?? '*',
            'access-control-allow-methods': '*',
          },
        });
      calls.push(`${request.method()} /media/${MEDIA}/analysis`);
      if (request.method() === 'POST')
        return route.fulfill({
          status: 202,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { job: job('pending'), productDescription: null },
            metaData: meta,
          }),
        });
      reads += 1;
      const done = reads > 1;
      return route.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            job: done ? job('completed') : null,
            productDescription: done
              ? 'A white bottle of 60 capsules with a green mushroom label.'
              : null,
          },
          metaData: meta,
        }),
      });
    });
    await page.goto(`/campaigns/new?draft=${ID}`);
    await heading(page, 'Tell us about the product');
    await pick(page);
    await expect(page.locator('li[data-status="ready"]')).toBeVisible();
    const describe = page.getByRole('button', { name: 'Describe this image' });
    await describe.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('analysis-result')).toContainText(
      'A white bottle of 60 capsules',
    );
    await page.getByRole('button', { name: 'Use as product description' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: /Product description/ })).toHaveValue(
      'A white bottle of 60 capsules with a green mushroom label.',
    );
    await page.getByRole('button', { name: /Next: Audience/ }).focus();
    await page.keyboard.press('Enter');
    await heading(page, 'Audience and direction');
    await page.getByRole('button', { name: /Next: Concept and script/ }).focus();
    await page.keyboard.press('Enter');
    await heading(page, 'Concept and script');
    await page
      .getByRole('textbox', { name: /Concept/ })
      .fill('A calm morning routine with the capsules.');
    await page.getByRole('button', { name: 'Generate brief' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(`**/campaigns/${CAMPAIGN}/brief`);
    expect(keys.every((k) => k !== null && /^[0-9a-f-]{36}$/.test(k))).toBe(true);
    expect(new Set(calls.map((c) => c.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')))).toEqual(
      new Set([
        'GET /drafts/:id',
        'PATCH /drafts/:id',
        'POST /media',
        'GET /media/:id',
        'GET /media/:id/analysis',
        'POST /media/:id/analysis',
        'POST /drafts/:id/submit',
      ]),
    );
  });

  const STATES: {
    state: string;
    url: string;
    routes: Routes;
    ready: (p: Page) => Promise<void>;
  }[] = [
    {
      state: 'default',
      url: `/campaigns/new?draft=${ID}`,
      routes: { [GET_DRAFT]: ok(draft()) },
      ready: (p) => heading(p, 'Tell us about the product'),
    },
    {
      state: 'uploading',
      url: `/campaigns/new?draft=${ID}`,
      routes: { [GET_DRAFT]: ok(draft()), 'POST /media': 'hang' },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await pick(p);
        await expect(p.locator('li[data-status="uploading"]')).toBeVisible();
      },
    },
    {
      state: 'processing',
      url: `/campaigns/new?draft=${ID}`,
      routes: {
        [GET_DRAFT]: ok(draft()),
        'POST /media': ok(media({ state: 'processing' }), 201),
        [`GET /media/${MEDIA}`]: ok(media({ state: 'processing' })),
      },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await pick(p);
        await expect(p.locator('li[data-status="processing"]')).toBeVisible();
      },
    },
    {
      state: 'ready',
      url: `/campaigns/new?draft=${ID}`,
      routes: {
        [GET_DRAFT]: ok(draft({ productMediaId: MEDIA })),
        [`GET /media/${MEDIA}`]: ok(media()),
        [`GET /media/${MEDIA}/analysis`]: {
          status: 200,
          body: {
            success: true,
            data: {
              job: job('completed'),
              productDescription: 'A white bottle of 60 capsules with a green mushroom label.',
            },
            metaData: meta,
          },
        },
      },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await expect(p.getByTestId('analysis-result')).toBeVisible();
        await expect(p.locator('li[data-status="ready"]')).toBeVisible();
      },
    },
    {
      state: 'upload-rejected',
      url: `/campaigns/new?draft=${ID}`,
      routes: {
        [GET_DRAFT]: ok(draft()),
        'POST /media': ok(media({ state: 'processing' }), 201),
        [`GET /media/${MEDIA}`]: ok(
          media({
            state: 'rejected',
            rejectReason: 'decode_failed',
            contentType: null,
            bytes: null,
            width: null,
            height: null,
          }),
        ),
      },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await pick(p);
        await expect(p.locator('li[data-status="rejected"]')).toContainText(
          'This image could not be read',
        );
      },
    },
    {
      state: 'upload-too-large',
      url: `/campaigns/new?draft=${ID}`,
      routes: {
        [GET_DRAFT]: ok(draft()),
        'POST /media': {
          status: 413,
          body: {
            success: false,
            error: {
              code: 'payload_too_large',
              message: 'This file is too large. Images can be up to 10 MB.',
              details: [],
            },
            metaData: meta,
          },
        },
      },
      ready: async (p) => {
        await heading(p, 'Tell us about the product');
        await pick(p);
        await expect(p.locator('li[data-status="rejected"]')).toContainText('too large');
      },
    },
    {
      state: 'step-4',
      url: `/campaigns/new?draft=${ID}`,
      routes: { [GET_DRAFT]: step4() },
      ready: (p) => heading(p, 'Concept and script'),
    },
    {
      state: 'generating',
      url: `/campaigns/new?draft=${ID}`,
      routes: {
        [GET_DRAFT]: step4(),
        [PATCH_DRAFT]: ok(draft({ version: 2, step: 4 })),
        [SUBMIT]: 'hang',
      },
      ready: async (p) => {
        await heading(p, 'Concept and script');
        await p.getByRole('button', { name: 'Generate brief' }).click();
        await expect(p.getByTestId('generating-status')).toContainText('in progress');
      },
    },
    {
      state: 'key-missing',
      url: `/campaigns/new?draft=${ID}&block=key_missing`,
      routes: { [GET_DRAFT]: step4() },
      ready: (p) => expect(p.getByText('Add your OpenAI key to generate the brief')).toBeVisible(),
    },
    {
      state: 'cap-reached',
      url: `/campaigns/new?draft=${ID}&block=spend_cap_reached`,
      routes: { [GET_DRAFT]: step4() },
      ready: (p) => expect(p.getByText('Daily spend limit reached')).toBeVisible(),
    },
    {
      state: 'cap-reached-on-submit',
      url: `/campaigns/new?draft=${ID}`,
      routes: {
        [GET_DRAFT]: step4(),
        [PATCH_DRAFT]: ok(draft({ version: 2, step: 4 })),
        [SUBMIT]: failure(422, 'spend_cap_reached'),
      },
      ready: async (p) => {
        await heading(p, 'Concept and script');
        await p.getByRole('button', { name: 'Generate brief' }).click();
        await expect(p.getByText('Daily spend limit reached')).toBeVisible();
        await expect(p.getByRole('button', { name: 'Generate brief' })).toBeDisabled();
      },
    },
  ];

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    for (const { state, url, routes, ready } of STATES) {
      test(`${state} at ${name} px: axe, screenshot, baseline`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        await mockApi(page, routes);
        await page.goto(url);
        await ready(page);
        await expect(page.locator('[data-screen="SCREEN-006"]')).not.toHaveAttribute(
          'aria-busy',
          'true',
        );
        await settle(page);
        await expectNoAxeViolations(
          page,
          `${evidence}/axe/${info.project.name}-${state}-${name}.json`,
        );
        await page.waitForTimeout(300);
        const full = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height: Math.max(height, full) });
        await settle(page);
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        const baseline = `fe-screen-006b-${state}-${name}.png`;
        await expect(page).toHaveScreenshot(baseline, { fullPage: true });
        copyFileSync(info.snapshotPath(baseline), `${evidence}/screenshots/${state}-${name}.png`);
      });
    }
  }
});
