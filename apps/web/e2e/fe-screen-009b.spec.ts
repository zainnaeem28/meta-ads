import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';
import {
  ASSEMBLY_ID,
  CAMPAIGN_ID,
  assemblyFixture,
  campaignFixture,
  meta,
  passedList,
} from '../src/features/fe-screen-009a/fixtures';
import { THUMB_MEDIA_ID, thumbFixture } from '../src/features/fe-screen-009b/fixtures';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-097';
const URL_PATH = `/campaigns/${CAMPAIGN_ID}/final`;
// 390 and 1440 px (UI-UX §7: SCREEN-009 is framed at these two widths).
const SHOTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

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

type Handler = (route: Route, path: string, method: string) => Promise<boolean> | boolean;

// The built web app against the running built api. The api sets no CORS headers yet, so browser requests to it are
// relayed through this handler, which adds them. The SCREEN-009 operations (API-061, 070, 071, the campaign read, the provider-key read for the header
// badge and the media link) are answered by `script` with contract-shaped fixtures (this environment
// has no operator session or generated brief for the real api); everything else, and the "real api" test, reaches the
// real api. The real UI to API to database proof is the flow ticket's.
async function relay(page: Page, script: Handler, seen: string[] = []) {
  const api = process.env.E2E_API_URL!;
  await page.route(`${api}/**`, async (route) => {
    const request = route.request();
    const origin = (await request.headerValue('origin')) ?? '*';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
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
    seen.push(`${request.method()} ${path}`);
    const answer = await script(
      Object.assign(Object.create(route), {
        fulfill: (o: Parameters<Route['fulfill']>[0]) =>
          route.fulfill({ ...o, headers: { ...(o?.headers ?? {}), ...cors } }),
      }) as Route,
      path,
      request.method(),
    );
    if (answer) return;
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}

const ok = (route: Route, data: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data, metaData: meta }),
  });
const fail = (route: Route, status: number, code: string, message = 'x') =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      success: false,
      error: { code, message, details: [] },
      metaData: { requestId: 'req-e2e-1' },
    }),
  });

const keyRows = (wavespeed: 'active' | 'disabled' | 'missing') =>
  ['openai', 'wavespeed'].map((provider) => ({
    provider,
    configured: provider === 'wavespeed' ? wavespeed !== 'missing' : true,
    status: provider === 'wavespeed' ? (wavespeed === 'missing' ? null : wavespeed) : 'active',
    last4: null,
    fingerprint: null,
    version: 1,
    createdAt: null,
    updatedAt: null,
    lastValidatedAt: null,
    inFlightJobCount: 0,
  }));

interface World {
  assembly?: Parameters<typeof assemblyFixture>[1];
  thumb?: unknown | (() => unknown);
  start?: (route: Route) => Promise<void>;
  posts?: unknown[];
  urls?: string[];
}

const world = (w: World = {}): Handler => {
  return async (route, path, method) => {
    if (method === 'GET' && path === '/me/provider-keys') {
      await ok(route, keyRows('active'));
      return true;
    }
    if (method === 'GET' && /^\/media\/[0-9a-f-]{36}\/url$/.test(path)) {
      w.urls?.push(path);
      await ok(route, { url: `http://127.0.0.1:${process.env.WEB_PORT ?? 3100}/__file.mp4` });
      return true;
    }
    if (method === 'GET' && path === `/assemblies/${ASSEMBLY_ID}`) {
      await ok(route, assemblyFixture('done', w.assembly));
      return true;
    }
    if (!path.startsWith('/campaigns/')) return false;
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}`) {
      await ok(route, campaignFixture({ latestAssemblyId: ASSEMBLY_ID }));
      return true;
    }
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/video-jobs`) {
      await ok(route, passedList());
      return true;
    }
    if (path === `/campaigns/${CAMPAIGN_ID}/thumbstopper`) {
      if (method === 'GET') {
        await ok(route, typeof w.thumb === 'function' ? w.thumb() : (w.thumb ?? null));
        return true;
      }
      w.posts?.push(JSON.parse(route.request().postData() ?? 'null'));
      if (w.start) await w.start(route);
      else await ok(route, thumbFixture('pending'), 202);
      return true;
    }
    return false;
  };
};
const settle = async (page: Page) => {
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await Promise.all(
      ['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 16px Inter`)),
    );
    await document.fonts.ready;
  });
};

async function capture(
  page: Page,
  state: string,
  size: { name: string },
  info: { project: { name: string } },
) {
  await settle(page);
  await expectNoAxeViolations(
    page,
    `${evidence}/axe/${info.project.name}-${state}-${size.name}.json`,
  );
  // The committed evidence images are refreshed on request (EVIDENCE=1), so a check run leaves the tree clean.
  // The fixed bottom navigation of the phone layout would be drawn mid-page in a full-page capture and hide
  // content, so it is hidden for the picture only (it stays in the axe run above).
  await page.addStyleTag({ content: '.fixed:not(.z-50) { visibility: hidden !important; }' });
  if (process.env['EVIDENCE'] === '1') {
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    await page.screenshot({
      path: `${evidence}/screenshots/${state}-${size.name}.png`,
      fullPage: true,
    });
  }
  await expect(page).toHaveScreenshot(`fe-screen-009b-${state}-${size.name}.png`, {
    fullPage: true,
  });
}

type Arrange = (page: Page) => Promise<void>;
const download = (page: Page) => page.getByRole('button', { name: 'Download video' });
const generate = (page: Page) => page.getByRole('button', { name: 'Generate thumbstopper' });
const callout = (page: Page) => page.getByLabel(/Call-out text/);

const STATES: { state: string; world: () => World; arrange: Arrange }[] = [
  {
    state: 'done',
    world: () => ({}),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByRole('heading', { name: 'Final ad' })).toBeVisible();
      await expect(download(page)).toBeEnabled();
      await expect(generate(page)).toBeVisible();
    },
  },
  {
    state: 'out-of-date',
    world: () => ({
      assembly: {
        outOfDate: true,
        clips: assemblyFixture('done').clips.map((c) => ({ ...c, outOfDate: c.position === 3 })),
      },
    }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText('This final ad is out of date')).toBeVisible();
      await expect(page.getByText(/Clip 3 was regenerated/)).toBeVisible();
      await expect(download(page)).toBeEnabled();
    },
  },
  {
    state: 'thumbstopper-generating',
    world: () => ({ thumb: thumbFixture('processing') }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(
        page.getByText('Generating the thumbstopper. This takes about a minute.'),
      ).toBeVisible();
    },
  },
  {
    state: 'thumbstopper-ready',
    world: () => ({ thumb: thumbFixture('completed') }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText('Call-out: Sleep better tonight')).toBeVisible();
      await expect(page.getByRole('img', { name: /Sleep better tonight/ })).toBeVisible();
    },
  },
  {
    state: 'thumbstopper-failed',
    world: () => ({ thumb: thumbFixture('failed') }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText('The thumbstopper could not be made')).toBeVisible();
    },
  },
  {
    state: 'thumbstopper-claim-issue',
    world: () => ({
      start: async (route) =>
        void (await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: 'open_claim_issues',
              message: 'Claim issues',
              details: [
                { field: 'calloutText', code: 'CLAIM-01', message: 'Remove the cure claim.' },
              ],
            },
            metaData: { requestId: 'req-e2e-2' },
          }),
        })),
    }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await callout(page).fill('Cures insomnia');
      await generate(page).click();
      await expect(callout(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('Remove the cure claim.').first()).toBeVisible();
    },
  },
];

test.describe('@TASK-097 SCREEN-009 download, out-of-date and thumbstopper through the built web app', () => {
  test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

  for (const size of SHOTS) {
    for (const { state, world: make, arrange } of STATES) {
      test(`${state} at ${size.name} px: reachable, no axe violations, screenshot and baseline`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await relay(page, world(make()));
        await arrange(page);
        await capture(page, state, size, info);
      });
    }
  }

  test('download asks for a fresh link on every click', async ({ page }) => {
    const urls: string[] = [];
    await relay(page, world({ urls }));
    await page.route('**/__file.mp4', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'video/mp4',
        headers: { 'content-disposition': 'attachment; filename="final.mp4"' },
        body: 'x',
      }),
    );
    await page.goto(URL_PATH);
    await expect(download(page)).toBeEnabled();
    const mediaReads = () => urls.filter((u) => u.includes('000000000009')).length;
    await expect.poll(mediaReads).toBeGreaterThan(0);
    const before = mediaReads();
    const first = page.waitForEvent('download');
    await download(page).click();
    expect((await first).suggestedFilename()).toMatch(/\.mp4$/);
    await expect.poll(mediaReads).toBe(before + 1);
    await download(page).click();
    await expect.poll(mediaReads).toBe(before + 2);
  });

  test('keyboard only: type the call-out, start the thumbstopper; the body carries the text', async ({
    page,
  }) => {
    const posts: unknown[] = [];
    const keys: (string | null)[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') keys.push(r.headers()['idempotency-key'] ?? null);
    });
    await relay(page, world({ posts }));
    await page.goto(URL_PATH);
    await callout(page).focus();
    await page.keyboard.type('Sleep better tonight');
    await page.keyboard.press('Tab');
    await expect(generate(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => posts.length).toBe(1);
    expect(posts).toEqual([{ calloutText: 'Sleep better tonight' }]);
    expect(keys.every((k) => k && k.length === 36)).toBe(true);
  });

  test('every call is one of the listed operations', async ({ page }) => {
    const seen: string[] = [];
    await relay(page, world({ thumb: thumbFixture('completed') }), seen);
    await page.goto(URL_PATH);
    await expect(page.getByRole('img', { name: /Sleep better tonight/ })).toBeVisible();
    await download(page).click();
    const shapes = new Set(seen.map((c) => c.replace(/[0-9a-f-]{36}/g, ':id')));
    expect(shapes).toEqual(
      new Set([
        'GET /campaigns/:id',
        'GET /campaigns/:id/video-jobs',
        'GET /me/provider-keys',
        'GET /assemblies/:id',
        'GET /media/:id/url',
        'GET /campaigns/:id/thumbstopper',
      ]),
    );
    expect(THUMB_MEDIA_ID).toBeTruthy();
  });

  test('the real api answers: a call without an operator token sends the visitor to sign-in', async ({
    page,
  }) => {
    const seen: string[] = [];
    await relay(page, async () => false, seen);
    await page.goto(URL_PATH);
    await page.waitForURL('**/sign-in**');
    expect(new URL(page.url()).searchParams.get('return')).toBe(URL_PATH);
    await expect(page.getByRole('button', { name: 'Download video' })).toHaveCount(0);
  });
});
