import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';
import {
  accountFixtures,
  erasureFixtures,
  meFixture,
  meta,
  metaPage,
} from '../src/features/fe-screen-011/fixtures';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-099';

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
// relayed through this handler, which adds them. The SCREEN-011 operations are answered by `script` with
// contract-shaped fixtures (the real api has no admin session in this environment); every other request, and any
// operation the script declines, goes to the real api. The real-integration proof is the flow ticket.
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
    const wrapped = {
      fulfill: route.fulfill.bind(route),
    };
    const answer = await script(
      Object.assign(Object.create(route), {
        fulfill: (o: Parameters<Route['fulfill']>[0]) =>
          wrapped.fulfill({ ...o, headers: { ...(o?.headers ?? {}), ...cors } }),
      }) as Route,
      path,
      request.method(),
    );
    if (answer) return;
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}

const ok = (route: Route, data: unknown, metaData: unknown = meta, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data, metaData }),
  });
const fail = (route: Route, status: number, code: string, message = 'x') =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      success: false,
      error: { code, message },
      metaData: { requestId: 'req-e2e-1' },
    }),
  });

interface World {
  users?: ReturnType<typeof accountFixtures>;
  /** Holds the reads until released (the loading state). */
  gate?: Promise<void>;
  listFails?: boolean;
  inviteStatus?: { status: number; code: string };
  actionStatus?: { status: number; code: string };
}

const world = (w: World = {}): Handler => {
  const users = w.users ?? accountFixtures();
  const runs = erasureFixtures();
  return async (route, path, method) => {
    if (method === 'GET' && path === '/me') return (void (await ok(route, meFixture())), true);
    if (!path.startsWith('/admin/')) return false;
    if (method === 'GET') await w.gate;
    if (method === 'GET' && path === '/admin/users') {
      if (w.listFails) return (void (await fail(route, 500, 'internal_error')), true);
      return (void (await ok(route, users, metaPage(users.length))), true);
    }
    if (method === 'GET' && path === '/admin/erasures')
      return (void (await ok(route, runs, metaPage(runs.length))), true);
    if (method === 'POST' && path === '/admin/invitations') {
      if (w.inviteStatus)
        return (void (await fail(route, w.inviteStatus.status, w.inviteStatus.code)), true);
      return (
        void (await ok(
          route,
          {
            email: 'new@shroomap.example',
            message: 'If this address can be invited, an invitation is on its way.',
          },
          meta,
          202,
        )),
        true
      );
    }
    if (method === 'POST' && /\/admin\/users\/[^/]+\/(suspend|reinstate|remove)$/.test(path)) {
      if (w.actionStatus)
        return (void (await fail(route, w.actionStatus.status, w.actionStatus.code)), true);
      if (path.endsWith('/remove'))
        return (
          void (await ok(route, { deletionRunId: runs[0]!.id, state: 'running' }, meta, 202)),
          true
        );
      return (void (await ok(route, users[1])), true);
    }
    if (method === 'PUT' && /\/admin\/users\/[^/]+\/role$/.test(path))
      return (void (await ok(route, { ...users[1], role: 'admin', version: 4 })), true);
    return false;
  };
};

const SHOTS = VIEWPORTS;

// A weight that is first used after a tab change may still be downloading on a cold start: request each one.
const settle = async (page: Page) => {
  await page.evaluate(async () => {
    await Promise.all(
      ['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 16px Inter`)),
    );
    await document.fonts.ready;
    // CMP-014's tab list (overflow-x: auto) can be scrolled 1 px vertically by the click that selects a tab.
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
  // Every row action must be reachable on screen, not clipped by the table's scroll area.
  const actions = page.getByRole('button', {
    name: /^(Suspend |Reinstate |More actions for)/,
  });
  const viewport = page.viewportSize()!;
  for (const button of await actions.all()) {
    if (!(await button.isVisible())) continue;
    const box = (await button.boundingBox())!;
    expect(box.x, 'row action starts inside the viewport').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'row action ends inside the viewport').toBeLessThanOrEqual(
      viewport.width,
    );
  }
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
  await expect(page).toHaveScreenshot(`fe-screen-011-${state}-${size.name}.png`, {
    fullPage: true,
  });
}

type Arrange = (page: Page) => Promise<void>;

const open = async (page: Page, search = '') => {
  await page.goto(`/admin/accounts${search}`);
  await expect(page.getByText('marcus.oyelaran@shroomap.example')).toBeVisible();
};

const STATES: { state: string; world: () => World; arrange: Arrange }[] = [
  {
    state: 'default',
    world: () => ({}),
    arrange: async (page) => {
      await open(page);
      await expect(
        page.getByRole('tab', { name: /Account erasures/ }).getByText('3'),
      ).toBeVisible();
    },
  },
  {
    state: 'error',
    world: () => ({ listFails: true }),
    arrange: async (page) => {
      await page.goto('/admin/accounts');
      await expect(page.getByRole('heading', { name: 'Accounts could not be loaded' })).toBeVisible(
        { timeout: 15_000 },
      );
    },
  },
  {
    state: 'only-you',
    world: () => ({ users: [accountFixtures()[0]!] }),
    arrange: async (page) => {
      await page.goto('/admin/accounts');
      await expect(page.getByText(/You are the only person here/)).toBeVisible();
    },
  },
  {
    state: 'invite-dialog',
    world: () => ({ inviteStatus: { status: 422, code: 'invite_domain_not_allowed' } }),
    arrange: async (page) => {
      await open(page);
      await page.getByRole('button', { name: 'Invite person' }).first().click();
      await page.getByLabel('Email address').fill('sam@gmail.com');
      await page.getByRole('button', { name: 'Send invitation' }).click();
      await expect(
        page.getByText(
          'Invitations are limited to approved email domains. Use an approved address.',
        ),
      ).toBeVisible();
    },
  },
  {
    state: 'suspend-confirm',
    world: () => ({}),
    arrange: async (page) => {
      await open(page);
      await page.getByRole('button', { name: 'Suspend marcus.oyelaran@shroomap.example' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    state: 'remove-confirm',
    world: () => ({}),
    arrange: async (page) => {
      await open(page);
      await page
        .getByRole('button', { name: 'More actions for tom.lindqvist@shroomap.example' })
        .click();
      await page.getByRole('menuitem', { name: 'Remove' }).click();
      await page.getByLabel(/^Type/).fill('tom.lindqvist@shroomap');
      await expect(page.getByRole('button', { name: 'Remove account' })).toBeDisabled();
    },
  },
  {
    state: 'last-admin',
    world: () => ({ actionStatus: { status: 422, code: 'last_admin' } }),
    arrange: async (page) => {
      await open(page);
      await page.getByRole('button', { name: 'Suspend dana.whitfield@shroomap.example' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Suspend account' }).click();
      await expect(
        page.getByText(
          'This is the last administrator. Make another account an administrator first.',
        ),
      ).toBeVisible();
    },
  },
  {
    state: 'erasures',
    world: () => ({}),
    arrange: async (page) => {
      await open(page);
      await page.getByRole('tab', { name: /Account erasures/ }).click();
      await expect(page.getByText('u_8f3a…c21d')).toBeVisible();
    },
  },
  {
    state: 'menu-open',
    world: () => ({}),
    arrange: async (page) => {
      await open(page);
      await page
        .getByRole('button', { name: 'More actions for marcus.oyelaran@shroomap.example' })
        .click();
      await expect(page.getByRole('menuitem', { name: 'Grant admin' })).toBeVisible();
    },
  },
];

test.describe('@TASK-099 SCREEN-011 accounts through the built web app', () => {
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

    test(`loading at ${size.name} px: skeleton with aria-busy, then the data replaces it`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await relay(page, world({ gate }));
      await page.goto('/admin/accounts');
      await expect(page.getByRole('table', { name: 'Accounts' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await capture(page, 'loading', size, info);
      release();
      await expect(page.getByText('marcus.oyelaran@shroomap.example')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Accounts' })).not.toHaveAttribute(
        'aria-busy',
        'true',
      );
    });
  }

  test('keyboard only: the row menu opens by Enter, arrows move, Enter suspends through the dialog, Escape returns focus', async ({
    page,
  }) => {
    const seen: string[] = [];
    await relay(page, world(), seen);
    await open(page);

    const trigger = page.getByRole('button', {
      name: 'More actions for marcus.oyelaran@shroomap.example',
    });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Suspend' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Grant admin' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Administrator access granted.')).toBeVisible();

    const suspend = page.getByRole('button', { name: 'Suspend marcus.oyelaran@shroomap.example' });
    await suspend.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(suspend).toBeFocused();
    expect(seen.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
  });

  test('every call is one of the listed operations and carries the contract shape', async ({
    page,
  }) => {
    const seen: string[] = [];
    const sent: { path: string; body: unknown; ifMatch: string | null }[] = [];
    const inner = world();
    await relay(
      page,
      async (route, path, method) => {
        if (method !== 'GET') {
          const request = route.request();
          sent.push({
            path: path.replace(/[0-9a-f-]{36}/g, ':id'),
            body: request.postDataJSON(),
            ifMatch: await request.headerValue('if-match'),
          });
        }
        return inner(route, path, method);
      },
      seen,
    );
    await open(page);
    await page.getByRole('button', { name: 'Invite person' }).first().click();
    await page.getByLabel('Email address').fill('new@shroomap.example');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible();
    await page.getByRole('button', { name: 'Suspend marcus.oyelaran@shroomap.example' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Suspend account' }).click();
    await expect(page.getByText('Account suspended.')).toBeVisible();
    await page.getByRole('button', { name: 'Reinstate tom.lindqvist@shroomap.example' }).click();
    await expect(page.getByText('Account reinstated.')).toBeVisible();
    await page
      .getByRole('button', { name: 'More actions for priya.raman@shroomap.example' })
      .click();
    await page.getByRole('menuitem', { name: 'Grant admin' }).click();
    await expect(page.getByText('Administrator access granted.')).toBeVisible();
    await page
      .getByRole('button', { name: 'More actions for tom.lindqvist@shroomap.example' })
      .click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await page.getByLabel(/^Type/).fill('tom.lindqvist@shroomap.example');
    await page.getByRole('button', { name: 'Remove account' }).click();
    await expect(page.getByText(/Removal started/)).toBeVisible();

    expect(sent).toEqual([
      { path: '/admin/invitations', body: { email: 'new@shroomap.example' }, ifMatch: null },
      { path: '/admin/users/:id/suspend', body: null, ifMatch: null },
      { path: '/admin/users/:id/reinstate', body: null, ifMatch: null },
      { path: '/admin/users/:id/role', body: { role: 'admin' }, ifMatch: '"2"' },
      {
        path: '/admin/users/:id/remove',
        body: { confirmation: 'tom.lindqvist@shroomap.example' },
        ifMatch: null,
      },
    ]);
    const shapes = new Set(seen.map((c) => c.replace(/[0-9a-f-]{36}/g, ':id')));
    expect(shapes).toEqual(
      new Set([
        'GET /admin/users',
        'GET /admin/erasures',
        'GET /me',
        'POST /admin/invitations',
        'POST /admin/users/:id/suspend',
        'POST /admin/users/:id/reinstate',
        'PUT /admin/users/:id/role',
        'POST /admin/users/:id/remove',
      ]),
    );
  });

  test('the real api answers: a call without an administrator token is refused and the visitor is sent to sign-in, never shown data', async ({
    page,
  }) => {
    const seen: string[] = [];
    await relay(page, async () => false, seen);
    await page.goto('/admin/accounts');
    await page.waitForURL('**/sign-in**');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/admin/accounts');
    expect(seen).toContain('GET /admin/users');
    await expect(page.getByText('marcus.oyelaran@shroomap.example')).toHaveCount(0);
  });

  test('document title and noindex', async ({ page }) => {
    await relay(page, world());
    await open(page);
    expect(await page.title()).toBe('Accounts · ShrooMap');
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
    await page.goto('/admin/accounts');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/admin/accounts');
    await anon.close();
  });
});
