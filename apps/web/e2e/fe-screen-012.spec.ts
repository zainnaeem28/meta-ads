import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';
import {
  invitationFixtures,
  meFixture,
  meta,
  metaPage,
  requestFixtures,
  settingsFixture,
} from '../src/features/fe-screen-012/fixtures';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-100';

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
// relayed through this handler, which adds them. The eight SCREEN-012 operations are answered by `script` with
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
  invitations?: ReturnType<typeof invitationFixtures>;
  requests?: ReturnType<typeof requestFixtures>;
  settings?: Parameters<typeof settingsFixture>[0];
  /** Holds the three reads until released (the loading state). */
  gate?: Promise<void>;
  inviteStatus?: { status: number; code: string };
}

const world = (w: World = {}): Handler => {
  const invitations = w.invitations ?? invitationFixtures();
  const requests = w.requests ?? requestFixtures();
  return async (route, path, method) => {
    if (method === 'GET' && path === '/me') return (void (await ok(route, meFixture())), true);
    if (!path.startsWith('/admin/')) return false;
    if (method === 'GET') await w.gate;
    if (method === 'GET' && path === '/admin/invitations')
      return (void (await ok(route, invitations, metaPage(invitations.length))), true);
    if (method === 'GET' && path === '/admin/access-requests')
      return (void (await ok(route, requests, metaPage(requests.length))), true);
    if (method === 'GET' && path === '/admin/settings')
      return (void (await ok(route, settingsFixture(w.settings))), true);
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
    if (method === 'POST' && /\/admin\/invitations\/[^/]+\/(resend|revoke)$/.test(path))
      return (void (await ok(route, invitations[0])), true);
    if (method === 'POST' && /\/admin\/access-requests\/[^/]+\/(approve|decline)$/.test(path))
      return (void (await ok(route, requests[0])), true);
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
  // Every row action must be reachable on screen, not clipped by the table's scroll area (768 px review finding FR-1).
  const actions = page.getByRole('button', {
    name: /^(Resend to|Revoke|Invite .* again|Approve|Decline)/,
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
  await expect(page).toHaveScreenshot(`fe-screen-012-${state}-${size.name}.png`, {
    fullPage: true,
  });
}

type Arrange = (page: Page) => Promise<void>;

const STATES: { state: string; world: () => World; arrange: Arrange }[] = [
  {
    state: 'default',
    world: () => ({}),
    arrange: async (page) => {
      await page.goto('/admin/invitations');
      await expect(page.getByText('sam.okafor@shroomap.example')).toBeVisible();
      await expect(page.getByRole('tab', { name: /Access requests/ }).getByText('2')).toBeVisible();
    },
  },
  {
    state: 'requests',
    world: () => ({}),
    arrange: async (page) => {
      await page.goto('/admin/invitations');
      await page.getByRole('tab', { name: /Access requests/ }).click();
      await expect(page.getByText('nina.castellano@shroomap.example')).toBeVisible();
    },
  },
  {
    state: 'requests-off',
    world: () => ({ settings: { signupMode: 'open' } }),
    arrange: async (page) => {
      await page.goto('/admin/invitations');
      await expect(page.getByText('sam.okafor@shroomap.example')).toBeVisible();
      await page.getByRole('tab', { name: /Access requests/ }).click();
      await expect(
        page.getByRole('heading', { name: 'The request-access form is off' }),
      ).toBeVisible();
    },
  },
  {
    state: 'empty',
    world: () => ({ invitations: [] }),
    arrange: async (page) => {
      await page.goto('/admin/invitations');
      await expect(page.getByRole('heading', { name: 'No invitations yet' })).toBeVisible();
    },
  },
  {
    state: 'invite-error',
    world: () => ({ inviteStatus: { status: 422, code: 'invite_domain_not_allowed' } }),
    arrange: async (page) => {
      await page.goto('/admin/invitations');
      await expect(page.getByText('sam.okafor@shroomap.example')).toBeVisible();
      await page.getByRole('button', { name: 'Invite person' }).click();
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
    state: 'resent',
    world: () => ({}),
    arrange: async (page) => {
      await page.goto('/admin/invitations');
      await page.getByRole('button', { name: 'Resend to sam.okafor@shroomap.example' }).click();
      await expect(
        page.getByText('Invitation sent again. The 7-day period starts over.'),
      ).toBeVisible();
    },
  },
];

test.describe('@TASK-100 SCREEN-012 invitations and access requests through the built web app', () => {
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
      await page.goto('/admin/invitations');
      await expect(page.getByRole('table', { name: 'Invitations' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await capture(page, 'loading', size, info);
      release();
      await expect(page.getByText('sam.okafor@shroomap.example')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Invitations' })).not.toHaveAttribute(
        'aria-busy',
        'true',
      );
    });
  }

  test('keyboard only: tabs by arrow keys, the invite dialog traps focus and Escape returns it, Resend by Enter', async ({
    page,
  }) => {
    const seen: string[] = [];
    await relay(page, world(), seen);
    await page.goto('/admin/invitations');
    await expect(page.getByText('sam.okafor@shroomap.example')).toBeVisible();

    const invite = page.getByRole('button', { name: 'Invite person' });
    await invite.focus();
    await page.keyboard.press('Enter');
    const email = page.getByLabel('Email address');
    await expect(email).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(invite).toBeFocused();

    const invitationsTab = page.getByRole('tab', { name: /^Invitations/ });
    await invitationsTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /^Access requests/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('nina.castellano@shroomap.example')).toBeVisible();
    await page.keyboard.press('ArrowLeft');

    await page.getByRole('button', { name: 'Resend to sam.okafor@shroomap.example' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Invitation sent again. The 7-day period starts over.'),
    ).toBeVisible();
    expect(seen.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /admin/invitations/11111111-1111-4111-8111-111111111111/resend',
    ]);
  });

  test('every call is one of the listed operations; invite, revoke, approve and decline reach the api with the contract shape', async ({
    page,
  }) => {
    const seen: string[] = [];
    const bodies: unknown[] = [];
    const inner = world();
    await relay(
      page,
      async (route, path, method) => {
        if (method === 'POST' && path === '/admin/invitations')
          bodies.push(route.request().postDataJSON());
        return inner(route, path, method);
      },
      seen,
    );
    await page.goto('/admin/invitations');
    await expect(page.getByText('sam.okafor@shroomap.example')).toBeVisible();
    await page.getByRole('button', { name: 'Invite person' }).click();
    await page.getByLabel('Email address').fill('new@shroomap.example');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(
      page.getByText('If this address can be invited, an invitation is on its way.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Revoke sam.okafor@shroomap.example' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke invitation' }).click();
    await expect(page.getByText('Invitation revoked.')).toBeVisible();
    await page.getByRole('tab', { name: /Access requests/ }).click();
    await page.getByRole('button', { name: 'Approve nina.castellano@shroomap.example' }).click();
    await expect(page.getByText('Request approved.')).toBeVisible();
    await page.getByRole('button', { name: 'Decline j.mbeki@shroomap.example' }).click();
    await expect(page.getByText('Request declined.')).toBeVisible();

    expect(bodies).toEqual([{ email: 'new@shroomap.example' }]);
    const shapes = new Set(seen.map((c) => c.replace(/[0-9a-f-]{36}/g, ':id')));
    expect(shapes).toEqual(
      new Set([
        'GET /admin/invitations',
        'GET /admin/access-requests',
        'GET /admin/settings',
        'GET /me',
        'POST /admin/invitations',
        'POST /admin/invitations/:id/revoke',
        'POST /admin/access-requests/:id/approve',
        'POST /admin/access-requests/:id/decline',
      ]),
    );
  });

  test('the real api answers: a call without an administrator token is refused and the visitor is sent to sign-in, never shown data', async ({
    page,
  }) => {
    const seen: string[] = [];
    await relay(page, async () => false, seen);
    await page.goto('/admin/invitations');
    await page.waitForURL('**/sign-in**');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/admin/invitations');
    expect(seen).toContain('GET /admin/invitations');
    await expect(page.getByText('sam.okafor@shroomap.example')).toHaveCount(0);
  });

  test('document title and noindex', async ({ page }) => {
    await relay(page, world());
    await page.goto('/admin/invitations');
    await expect(page.getByText('sam.okafor@shroomap.example')).toBeVisible();
    expect(await page.title()).toBe('Invitations and requests · ShrooMap');
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
    await page.goto('/admin/invitations');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/admin/invitations');
    await anon.close();
  });
});
