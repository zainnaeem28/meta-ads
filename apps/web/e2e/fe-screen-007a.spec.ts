import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';
import {
  CAMPAIGN_ID,
  acceptedBrief,
  briefFixture,
  campaignFixture,
  failedBrief,
  generatingBrief,
  meta,
} from '../src/features/fe-screen-007a/fixtures';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-093';
const URL_PATH = `/campaigns/${CAMPAIGN_ID}/brief`;
// 390 and 1440 px (UI-UX §7: SCREEN-007 is framed at these two widths).
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
// relayed through this handler, which adds them. The five SCREEN-007 operations (API-041, 050, 051, 052 and the
// provider-key read for the header badge) are answered by `script` with contract-shaped fixtures (this environment
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

const ok = (route: Route, data: unknown, etag = '"v3"', status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { etag },
    body: JSON.stringify({ success: true, data, metaData: meta }),
  });
const fail = (route: Route, status: number, code: string) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      success: false,
      error: { code, message: 'x', details: [] },
      metaData: { requestId: 'req-e2e-1' },
    }),
  });

const keyRows = (openai: boolean) =>
  ['openai', 'wavespeed'].map((provider) => ({
    provider,
    configured: provider === 'openai' ? openai : true,
    status: provider === 'openai' && !openai ? null : 'active',
    last4: null,
    fingerprint: null,
    version: 1,
    createdAt: null,
    updatedAt: null,
    lastValidatedAt: null,
    inFlightJobCount: 0,
  }));

interface World {
  brief?: ReturnType<typeof briefFixture>;
  openaiKey?: boolean;
  gate?: Promise<void>;
  patch?: (route: Route, body: unknown, ifMatch: string | null) => Promise<void>;
  accept?: (route: Route, ifMatch: string | null) => Promise<void>;
}

const world = (w: World = {}): Handler => {
  let brief = w.brief ?? briefFixture();
  return async (route, path, method) => {
    if (method === 'GET' && path === '/me/provider-keys') {
      await ok(route, keyRows(w.openaiKey ?? true));
      return true;
    }
    if (!path.startsWith('/campaigns/')) return false;
    if (method === 'GET') await w.gate;
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}`) {
      await ok(route, campaignFixture({ briefState: brief.state }));
      return true;
    }
    if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/brief`) {
      await ok(route, brief);
      return true;
    }
    const request = route.request();
    if (method === 'PATCH' && path === `/campaigns/${CAMPAIGN_ID}/brief`) {
      if (w.patch)
        await w.patch(route, request.postDataJSON(), await request.headerValue('if-match'));
      else {
        brief = briefFixture({ version: 4, issues: [], segments: brief.segments });
        await ok(route, brief, '"v4"');
      }
      return true;
    }
    if (method === 'POST' && path === `/campaigns/${CAMPAIGN_ID}/brief/accept`) {
      if (w.accept) await w.accept(route, await request.headerValue('if-match'));
      else {
        brief = acceptedBrief();
        await ok(route, brief, '"v5"');
      }
      return true;
    }
    return false;
  };
};

// A weight first used after a state change may still be downloading on a cold start: request each one.
const settle = async (page: Page) => {
  await page.evaluate(async () => {
    await Promise.all(
      ['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 16px Inter`)),
    );
    await document.fonts.ready;
    document.querySelectorAll('[role=tablist]').forEach((el) => (el.scrollTop = 0));
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
  if (process.env['EVIDENCE'] === '1') {
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    await page.screenshot({
      path: `${evidence}/screenshots/${state}-${size.name}.png`,
      fullPage: true,
    });
  }
  await expect(page).toHaveScreenshot(`fe-screen-007a-${state}-${size.name}.png`, {
    fullPage: true,
  });
}

type Arrange = (page: Page) => Promise<void>;

const ready = (page: Page) => page.getByRole('heading', { level: 1, name: 'Morning Focus Blend' });

const STATES: { state: string; world: () => World; arrange: Arrange }[] = [
  {
    state: 'default',
    world: () => ({}),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByRole('heading', { name: '2 issues to resolve' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Accept brief' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    },
  },
  {
    state: 'accept-blocked',
    world: () => ({}),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByRole('heading', { name: '2 issues to resolve' })).toBeVisible();
      // aria-disabled, not disabled: the press is allowed and explains why it cannot proceed (Playwright waits for enabled).
      await page.getByRole('button', { name: 'Accept brief' }).click({ force: true });
      await expect(page.getByText('The brief cannot be accepted yet')).toBeVisible();
    },
  },
  {
    state: 'accepted',
    world: () => ({ brief: acceptedBrief() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(
        page.getByRole('heading', { name: 'Brief accepted · all checks closed' }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: /Continue to clips/ })).toBeVisible();
    },
  },
  {
    state: 'failed',
    world: () => ({ brief: failedBrief() }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(
        page.getByRole('heading', { name: 'The brief could not be generated' }),
      ).toBeVisible();
    },
  },
  {
    state: 'key-missing',
    world: () => ({ openaiKey: false }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      await expect(page.getByText('Regenerating needs your OpenAI key')).toBeVisible();
    },
  },
  {
    state: 'conflict',
    world: () => ({
      patch: async (route) => void (await fail(route, 409, 'version_conflict')),
    }),
    arrange: async (page) => {
      await page.goto(URL_PATH);
      const box = page.getByRole('textbox', { name: 'Segment 1 dialogue' });
      await box.fill('My own unsaved text for the first segment.');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText(/This was changed somewhere else/)).toBeVisible();
      await expect(box).toHaveValue('My own unsaved text for the first segment.');
    },
  },
];

test.describe('@TASK-093 SCREEN-007 brief through the built web app', () => {
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
      await relay(page, world({ gate, brief: generatingBrief() }));
      await page.goto(URL_PATH);
      await expect(
        page.getByText('Generating your brief').or(page.getByText('Loading the brief')),
      ).toBeVisible();
      await expect(page.locator('[data-screen=SCREEN-007]')).toHaveAttribute('aria-busy', 'true');
      await capture(page, 'loading', size, info);
      release();
      await expect(page.getByText('Generating your brief')).toBeVisible();
    });
  }

  test('keyboard only: tabs, Edit segment, edit, Save, then Accept, in every step by keys', async ({
    page,
  }) => {
    const calls: { method: string; body: unknown; ifMatch: string | null }[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' || r.method() === 'POST')
        calls.push({
          method: r.method(),
          body: r.postDataJSON(),
          ifMatch: r.headers()['if-match'] ?? null,
        });
    });
    await relay(page, world());
    await page.goto(URL_PATH);
    await expect(page.getByRole('heading', { name: '2 issues to resolve' })).toBeVisible();

    // The disabled Clips tab is skipped by the arrow keys.
    await page.getByRole('tab', { name: /1 Brief/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /1 Brief/ })).toBeFocused();

    const edit = page.getByRole('link', { name: 'Edit segment 2' });
    await edit.focus();
    await page.keyboard.press('Enter');
    const box = page.getByRole('textbox', { name: 'Segment 2 dialogue' });
    await expect(box).toBeFocused();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(
      'A calm and steady routine helps me start each day on my own terms, with coffee and quiet light, before the run begins.',
    );
    const save = page.getByRole('button', { name: 'Save changes' });
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Changes saved. Brand checks ran again.')).toBeVisible();
    const accept = page.getByRole('button', { name: 'Accept brief' });
    await accept.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Brief accepted · all checks closed' }),
    ).toBeVisible();
    const text =
      'A calm and steady routine helps me start each day on my own terms, with coffee and quiet light, before the run begins.';
    expect(calls.filter((c) => c.method === 'PATCH' || c.method === 'POST')).toEqual([
      { method: 'PATCH', body: { segments: [{ position: 2, dialogue: text }] }, ifMatch: '"v3"' },
      { method: 'POST', body: null, ifMatch: '"v4"' },
    ]);
  });

  test('counter: the hard maximum of 45 words blocks Save and is announced politely', async ({
    page,
  }) => {
    await relay(page, world({ brief: briefFixture({ issues: [] }) }));
    await page.goto(URL_PATH);
    const box = page.getByRole('textbox', { name: 'Segment 1 dialogue' });
    await box.fill(Array.from({ length: 46 }, (_, i) => `w${i}`).join(' '));
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await expect(
      page
        .locator('[role=status][aria-live=polite]', { hasText: 'over the 45 word limit' })
        .first(),
    ).toBeAttached({ timeout: 3000 });
  });

  test('every call is one of the listed operations', async ({ page }) => {
    const seen: string[] = [];
    await relay(page, world(), seen);
    await page.goto(URL_PATH);
    await expect(page.getByRole('heading', { name: '2 issues to resolve' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Segment 3 dialogue' }).fill('Short text.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved. Brand checks ran again.')).toBeVisible();
    await page.getByRole('button', { name: 'Accept brief' }).click();
    await expect(
      page.getByRole('heading', { name: 'Brief accepted · all checks closed' }),
    ).toBeVisible();
    const shapes = new Set(seen.map((c) => c.replace(/[0-9a-f-]{36}/g, ':id')));
    expect(shapes).toEqual(
      new Set([
        'GET /campaigns/:id',
        'GET /campaigns/:id/brief',
        'PATCH /campaigns/:id/brief',
        'POST /campaigns/:id/brief/accept',
        'GET /me/provider-keys',
      ]),
    );
  });

  test('the real api answers: a call without an operator token sends the visitor to sign-in, never shows a brief', async ({
    page,
  }) => {
    const seen: string[] = [];
    await relay(page, async () => false, seen);
    await page.goto(URL_PATH);
    await page.waitForURL('**/sign-in**');
    expect(new URL(page.url()).searchParams.get('return')).toBe(URL_PATH);
    expect(seen).toContain(`GET /campaigns/${CAMPAIGN_ID}/brief`);
    await expect(page.getByText('Segment 1')).toHaveCount(0);
  });

  test('document title and noindex', async ({ page }) => {
    await relay(page, world());
    await page.goto(URL_PATH);
    await expect(ready(page)).toBeVisible();
    expect(await page.title()).toMatch(/^Brief · .*ShrooMap$/);
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
