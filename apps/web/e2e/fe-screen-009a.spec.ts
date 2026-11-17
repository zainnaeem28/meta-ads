import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';
import {
  ASSEMBLY_ID,
  CAMPAIGN_ID,
  assemblyFixture,
  campaignFixture,
  exceptionList,
  jobId,
  meta,
  noClipsList,
  passedList,
} from '../src/features/fe-screen-009a/fixtures';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-096';
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
  /** The clips answer, or a function called on every read. */
  list?: unknown | (() => unknown);
  /** The assembly the campaign points at, by state; none when absent. */
  assembly?: Parameters<typeof assemblyFixture>[0];
  gate?: Promise<void>;
  create?: (route: Route) => Promise<void>;
  posts?: unknown[];
}

const world = (w: World = {}): Handler => {
  const read = () => (typeof w.list === 'function' ? w.list() : (w.list ?? passedList()));
  let created = false;
  return async (route, path, method) => {
    if (method === 'GET' && path === '/me/provider-keys') {
      await ok(route, keyRows('active'));
      return true;
    }
    if (method === 'GET' && /^\/media\/[0-9a-f-]{36}\/url$/.test(path)) {
      await ok(route, { url: 'about:blank' });
      return true;
    }
    if (method === 'GET' && path === `/assemblies/${ASSEMBLY_ID}`) {
      await ok(
        route,
        assemblyFixture(created && !w.assembly ? 'rendering' : (w.assembly ?? 'queued')),
      );
      return true;
    }
    if (!path.startsWith('/campaigns/')) return false;
    if (method === 'GET') await w.gate;
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}`) {
      await ok(route, campaignFixture({ latestAssemblyId: w.assembly ? ASSEMBLY_ID : null }));
      return true;
    }
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/video-jobs`) {
      await ok(route, read());
      return true;
    }
    if (method === 'POST' && path === `/campaigns/${CAMPAIGN_ID}/assemblies`) {
      w.posts?.push(JSON.parse(route.request().postData() ?? 'null'));
      if (w.create) await w.create(route);
      else {
        created = true;
        await ok(route, assemblyFixture('pending'), 202);
      }
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
  await expect(page).toHaveScreenshot(`fe-screen-009a-${state}-${size.name}.png`, {
    fullPage: true,
  });
}

type Arrange = (page: Page) => Promise<void>;
const list = (page: Page) => page.getByRole('list', { name: 'Clips for the final ad' });
const assemble = (page: Page) => page.getByRole('button', { name: 'Assemble final ad' });

const STATES: { state: string; world: () => World; arrange: Arrange }[] = [
  {
    state: 'default',
    world: () => ({ list: passedList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(list(page)).toBeVisible();
      await expect(page.getByText('3 clips · 0:45')).toBeVisible();
      await expect(assemble(page)).toBeEnabled();
    },
  },
  {
    state: 'no-clips',
    world: () => ({ list: noClipsList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByRole('heading', { name: 'No completed clips yet' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to clips' })).toBeVisible();
    },
  },
  {
    state: 'selecting',
    world: () => ({ list: exceptionList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText('QC failed')).toBeVisible();
      await expect(
        page.getByText(/2 selected clips have a failed or skipped audio check/),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Move segment 2 up' }).click();
      await page.getByRole('button', { name: 'Move segment 2 down' }).click();
    },
  },
  {
    state: 'qc-confirm',
    world: () => ({ list: exceptionList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await assemble(page).click();
      await expect(
        page.getByRole('dialog', { name: 'Assemble with audio checks that did not pass?' }),
      ).toBeVisible();
    },
  },
  {
    state: 'qc-confirm-required',
    world: () => {
      let reads = 0;
      return {
        // The checks pass on the first read and have failed by the time of the second.
        list: () => (++reads === 1 ? passedList() : exceptionList()),
        create: async (route) =>
          void (await fail(route, 422, 'qc_confirmation_required', 'Segment 2 failed its check.')),
      };
    },
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(list(page)).toBeVisible();
      await assemble(page).click();
      const dialog = page.getByRole('dialog', {
        name: 'Confirm clips that did not pass the check',
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Segment 2: check failed')).toBeVisible();
    },
  },
  {
    state: 'assembling',
    world: () => ({ assembly: 'rendering' }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByRole('heading', { name: 'Assembling your final ad' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Assembly progress' })).toHaveAttribute(
        'aria-valuetext',
        'Rendering',
      );
    },
  },
  {
    state: 'failed',
    world: () => ({ assembly: 'failed' }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByRole('heading', { name: 'Assembly failed' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Assemble again' })).toBeEnabled();
    },
  },
  {
    state: 'cap-reached',
    world: () => ({
      create: async (route) => void (await fail(route, 422, 'assembly_daily_limit')),
    }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await assemble(page).click();
      await expect(page.getByText('Daily assembly limit reached')).toBeVisible();
      await expect(assemble(page)).toBeDisabled();
    },
  },
];

test.describe('@TASK-096 SCREEN-009 final ad through the built web app', () => {
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

    test(`loading at ${size.name} px: busy status in the final layout, then the data replaces it`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await relay(page, world({ gate }));
      await page.goto(URL_PATH);
      await expect(page.getByText('Loading the final ad')).toBeVisible();
      await expect(page.locator('[data-screen=SCREEN-009]')).toHaveAttribute('aria-busy', 'true');
      await capture(page, 'loading', size, info);
      release();
      await expect(list(page)).toBeVisible();
    });
  }

  test('keyboard only: reorder with the keys, confirm the exceptions, assemble; the body carries the order and the confirmation', async ({
    page,
  }) => {
    const posts: unknown[] = [];
    const keys: (string | null)[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') keys.push(r.headers()['idempotency-key'] ?? null);
    });
    await relay(page, world({ list: exceptionList(), posts }));
    await page.goto(URL_PATH);
    await expect(list(page)).toBeVisible();
    const up = page.getByRole('button', { name: 'Move segment 3 up' });
    await up.focus();
    await page.keyboard.press('Enter');
    // Segment 3 is now second; focus stays on a control of the moved clip.
    await expect(page.locator('[data-clip]').nth(1)).toHaveAttribute('data-clip', '3');
    await expect(page.locator('[data-move="3-up"]')).toBeFocused();
    await assemble(page).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', {
      name: 'Assemble with audio checks that did not pass?',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Assemble anyway' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Assembling your final ad' })).toBeVisible();
    expect(posts).toEqual([
      {
        clips: [jobId(1), jobId(3), jobId(2)],
        confirmations: { qcOverride: [jobId(3), jobId(2)] },
      },
    ]);
    expect(keys.every((k) => k && k.length === 36)).toBe(true);
  });

  test('polling: the assembly is refreshed every 3 s until it is done', async ({ page }) => {
    let reads = 0;
    await relay(page, async (route, path, method) => {
      if (method === 'GET' && path === `/assemblies/${ASSEMBLY_ID}`) {
        reads += 1;
        await ok(route, assemblyFixture(reads === 1 ? 'fetching' : 'failed'));
        return true;
      }
      return world({ assembly: 'queued' })(route, path, method);
    });
    await page.goto(URL_PATH);
    await expect(page.getByRole('progressbar', { name: 'Assembly progress' })).toHaveAttribute(
      'aria-valuetext',
      'Fetching clips',
    );
    await expect(page.getByRole('heading', { name: 'Assembly failed' })).toBeVisible({
      timeout: 8000,
    });
  });

  test('every call is one of the listed operations', async ({ page }) => {
    const seen: string[] = [];
    await relay(page, world({ list: passedList() }), seen);
    await page.goto(URL_PATH);
    await expect(list(page)).toBeVisible();
    await assemble(page).click();
    await expect(page.getByRole('heading', { name: 'Assembling your final ad' })).toBeVisible();
    await expect.poll(() => seen.some((c) => c.startsWith('GET /assemblies/'))).toBe(true);
    const shapes = new Set(seen.map((c) => c.replace(/[0-9a-f-]{36}/g, ':id')));
    expect(shapes).toEqual(
      new Set([
        'GET /campaigns/:id',
        'GET /campaigns/:id/video-jobs',
        'GET /me/provider-keys',
        'POST /campaigns/:id/assemblies',
        'GET /assemblies/:id',
      ]),
    );
  });

  test('the real api answers: a call without an operator token sends the visitor to sign-in, never shows a clip', async ({
    page,
  }) => {
    const seen: string[] = [];
    await relay(page, async () => false, seen);
    await page.goto(URL_PATH);
    await page.waitForURL('**/sign-in**');
    expect(new URL(page.url()).searchParams.get('return')).toBe(URL_PATH);
    expect(seen).toContain(`GET /campaigns/${CAMPAIGN_ID}/video-jobs`);
    await expect(page.locator('[data-clip]')).toHaveCount(0);
  });

  test('document title and noindex', async ({ page }) => {
    await relay(page, world());
    await page.goto(URL_PATH);
    await expect(list(page)).toBeVisible();
    expect(await page.title()).toMatch(/^Final ad · .*ShrooMap$/);
    expect(
      await page
        .locator('meta[name=robots]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('content'))),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/noindex/)]));
  });

  test('anonymous visitor is sent to sign-in with the return path', async ({
    browser,
    baseURL,
  }) => {
    const anon = await browser.newContext({ baseURL });
    const page = await anon.newPage();
    await page.goto(URL_PATH);
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(new URL(page.url()).searchParams.get('return')).toBe(URL_PATH);
    await anon.close();
  });
});
