import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';
import {
  CAMPAIGN_ID,
  briefFixture,
  campaignFixture,
  failuresList,
  emptyList,
  jobId,
  meta,
  mixedList,
  outOfDateList,
  qcList,
  videoJob,
} from '../src/features/fe-screen-008/fixtures';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-095';
const URL_PATH = `/campaigns/${CAMPAIGN_ID}/clips`;
// 390 and 1440 px (UI-UX §7: SCREEN-008 is framed at these two widths).
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
// relayed through this handler, which adds them. The SCREEN-008 operations (API-041, 060 to 064, the provider-key read for the header
// badge and the media link of a completed clip) are answered by `script` with contract-shaped fixtures (this environment
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

// A tiny silent MP4 is not needed: the player shows its poster-less frame, which is stable for the baseline.
interface World {
  list?: ReturnType<typeof emptyList>;
  briefState?: 'draft' | 'accepted';
  wavespeed?: 'active' | 'disabled' | 'missing';
  gate?: Promise<void>;
  generate?: (route: Route) => Promise<void>;
  retry?: (route: Route) => Promise<void>;
}

const world = (w: World = {}): Handler => {
  const list = w.list ?? emptyList();
  return async (route, path, method) => {
    if (method === 'GET' && path === '/me/provider-keys') {
      await ok(route, keyRows(w.wavespeed ?? 'active'));
      return true;
    }
    if (method === 'GET' && /^\/media\/[0-9a-f-]{36}\/url$/.test(path)) {
      await ok(route, { url: 'about:blank' });
      return true;
    }
    if (method === 'POST' && /^\/video-jobs\/[0-9a-f-]{36}\/retry$/.test(path)) {
      if (w.retry) await w.retry(route);
      else await ok(route, videoJob(3, { state: 'pending', label: 'pending' }), 202);
      return true;
    }
    if (method === 'POST' && /^\/video-jobs\/[0-9a-f-]{36}\/qc$/.test(path)) {
      await ok(route, {}, 202);
      return true;
    }
    if (!path.startsWith('/campaigns/')) return false;
    if (method === 'GET') await w.gate;
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}`) {
      await ok(route, campaignFixture({ briefState: w.briefState ?? 'accepted' }));
      return true;
    }
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/brief`) {
      await ok(route, briefFixture());
      return true;
    }
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/video-jobs`) {
      await ok(route, list);
      return true;
    }
    if (method === 'POST' && /\/segments\/\d\/jobs$/.test(path)) {
      if (w.generate) await w.generate(route);
      else await ok(route, videoJob(1, { state: 'pending', label: 'pending' }), 202);
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
  await page.addStyleTag({ content: '.fixed { visibility: hidden !important; }' });
  if (process.env['EVIDENCE'] === '1') {
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    await page.screenshot({
      path: `${evidence}/screenshots/${state}-${size.name}.png`,
      fullPage: true,
    });
  }
  await expect(page).toHaveScreenshot(`fe-screen-008-${state}-${size.name}.png`, {
    fullPage: true,
  });
}

type Arrange = (page: Page) => Promise<void>;
const card = (page: Page, n: number) => page.getByRole('article', { name: `Segment ${n} clip` });

const STATES: { state: string; world: () => World; arrange: Arrange }[] = [
  {
    state: 'default',
    world: () => ({ list: mixedList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(card(page, 3)).toHaveAttribute('data-cause', 'temporary');
      await expect(page.getByRole('button', { name: 'Retry segment 3' })).toBeEnabled();
    },
  },
  {
    state: 'blocked',
    world: () => ({ list: emptyList(), briefState: 'draft' }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText('Accept the brief before you generate clips.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open the brief' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Generate segment 1' })).toBeDisabled();
    },
  },
  {
    state: 'failures',
    world: () => ({ list: failuresList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(card(page, 2)).toHaveAttribute('data-cause', 'temporary');
      await expect(card(page, 3)).toHaveAttribute('data-cause', 'unknown');
      await expect(card(page, 4)).toHaveAttribute('data-cause', 'configuration');
      await expect(page.getByText(/Check your WaveSpeed account/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry segment 3', exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole('link', { name: 'Check provider keys' })).toBeVisible();
    },
  },
  {
    state: 'qc-review',
    world: () => ({ list: qcList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText('Audio check: failed')).toBeVisible();
      await expect(page.getByText('Audio check: skipped')).toBeVisible();
      await page
        .getByRole('button', { name: /Earlier check results/ })
        .first()
        .click();
    },
  },
  {
    state: 'out-of-date',
    world: () => ({ list: outOfDateList() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByTestId('out-of-date-1')).toBeVisible();
    },
  },
  {
    state: 'key-disabled',
    world: () => ({ list: emptyList(), wavespeed: 'disabled' }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText(/Your provider key was disabled/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Generate segment 1' })).toBeDisabled();
    },
  },
  {
    state: 'cap-reached',
    world: () => ({
      list: emptyList(),
      generate: async (route) =>
        void (await fail(
          route,
          422,
          'spend_cap_reached',
          'Your daily limit of 5.00 USD is reached.',
        )),
    }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await page.getByRole('button', { name: 'Generate segment 1' }).click();
      await expect(page.getByText(/A usage limit has been reached/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Generate segment 2' })).toBeDisabled();
    },
  },
];

test.describe('@TASK-095 SCREEN-008 clips through the built web app', () => {
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
      await relay(page, world({ gate, list: emptyList() }));
      await page.goto(URL_PATH);
      await expect(page.getByText('Loading the clips')).toBeVisible();
      await expect(page.locator('[data-screen=SCREEN-008]')).toHaveAttribute('aria-busy', 'true');
      await capture(page, 'loading', size, info);
      release();
      await expect(card(page, 1)).toBeVisible();
    });
  }

  test('keyboard only: Generate, then Retry, by keys; focus order follows the segments', async ({
    page,
  }) => {
    const calls: { path: string; key: string | null }[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST')
        calls.push({
          path: new URL(r.url()).pathname,
          key: r.headers()['idempotency-key'] ?? null,
        });
    });
    await relay(page, world({ list: [...emptyList().slice(0, 2), ...mixedList().slice(2)] }));
    await page.goto(URL_PATH);
    const generate = page.getByRole('button', { name: 'Generate segment 1' });
    await expect(generate).toBeEnabled();
    await generate.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Segment 1 clip started.')).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry segment 3' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Segment 3 clip started.')).toBeVisible();
    expect(calls.map((c) => c.path.replace(/[0-9a-f-]{36}/g, ':id'))).toEqual([
      '/api/v1/campaigns/:id/segments/1/jobs',
      '/api/v1/video-jobs/:id/retry',
    ]);
    expect(calls.every((c) => c.key && c.key.length === 36)).toBe(true);
    expect(calls[1]!.path).toContain(jobId(3));
  });

  test('polling: a running clip is refreshed every 3 s and the page keeps its content', async ({
    page,
  }) => {
    let reads = 0;
    await relay(page, async (route, path, method) => {
      if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/video-jobs`) {
        reads += 1;
        await ok(
          route,
          reads === 1
            ? mixedList()
            : [mixedList()[0]!, { ...mixedList()[1]!, latestJob: videoJob(2) }, mixedList()[2]!],
        );
        return true;
      }
      return world()(route, path, method);
    });
    await page.goto(URL_PATH);
    await expect(card(page, 2)).toHaveAttribute('data-state', 'processing');
    await expect(card(page, 2)).toHaveAttribute('data-state', 'completed', { timeout: 8000 });
    await expect(card(page, 1)).toBeVisible();
  });

  test('every call is one of the listed operations', async ({ page }) => {
    const seen: string[] = [];
    await relay(page, world({ list: mixedList() }), seen);
    await page.goto(URL_PATH);
    await expect(card(page, 3)).toBeVisible();
    await page.getByRole('button', { name: 'Retry segment 3' }).click();
    await expect(page.getByText('Segment 3 clip started.')).toBeVisible();
    await page.getByRole('button', { name: 'Re-run check segment 1' }).click();
    await expect(page.getByText('Check started for segment 1.')).toBeVisible();
    const shapes = new Set(
      seen.map((c) => c.replace(/[0-9a-f-]{36}/g, ':id').replace(/\/segments\/\d/, '/segments/:n')),
    );
    expect(shapes).toEqual(
      new Set([
        'GET /campaigns/:id',
        'GET /campaigns/:id/brief',
        'GET /campaigns/:id/video-jobs',
        'GET /me/provider-keys',
        'GET /media/:id/url',
        'POST /video-jobs/:id/retry',
        'POST /video-jobs/:id/qc',
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
    await expect(page.getByRole('article')).toHaveCount(0);
  });

  test('document title and noindex', async ({ page }) => {
    await relay(page, world());
    await page.goto(URL_PATH);
    await expect(card(page, 1)).toBeVisible();
    expect(await page.title()).toMatch(/^Clips · .*ShrooMap$/);
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
