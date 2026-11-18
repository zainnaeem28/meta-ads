import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext } from '@playwright/test';
import {
  PRODUCT_A,
  PRODUCT_B,
  accountA,
  accountB,
  campaignIds,
  etagOf,
  signIn,
  sql,
  stack,
} from './stack';

// TC-ZT-07 / T-20 and the first-data rules of ADR-014, through the built web app and the running api: the server reads
// the first viewport as the signed-in user, never shows one person's records to another, never carries the bearer in
// anything it sends to the browser, hydrates without a mismatch in another time zone and locale, and a write straight
// after first paint still carries its If-Match.
const ROUTES = (id: string) => [
  '/campaigns',
  `/campaigns/${id}/brief`,
  `/campaigns/${id}/clips`,
  `/campaigns/${id}/final`,
];

/** The page's HTML and the RSC flight it carries (the dehydrated state is part of it). */
const html = async (context: BrowserContext, path: string): Promise<string> =>
  (await context.request.get(path)).text();

const bearerOf = async (context: BrowserContext): Promise<string> =>
  ((await (await context.request.get('/local-token')).json()) as { token: string }).token;

test.describe('@fe-perf-budgets server-supplied first data (ADR-014, T-20)', () => {
  test('the server renders the first viewport as the signed-in user, from the user’s own data only (T-20 two identities)', async ({
    context,
  }) => {
    await signIn(context, accountA());
    const a = await html(context, '/campaigns');
    expect(a, 'the first page of A’s history is in the HTML').toContain(PRODUCT_A);
    expect(a).not.toContain(PRODUCT_B);

    // B's request right after A's never gets A's records or A's dehydrated state.
    await signIn(context, accountB());
    const b = await html(context, '/campaigns');
    expect(b).toContain(PRODUCT_B);
    expect(b).not.toContain(PRODUCT_A);
    const rsc = await context.request.get('/campaigns', { headers: { RSC: '1' } });
    expect(rsc.headers()['cache-control']).toContain('no-store');
    expect(await rsc.text()).not.toContain(PRODUCT_A);

    // A's campaign opened as B: the api refuses, nothing of A's is rendered.
    const [aCampaign] = await campaignIds(accountA());
    for (const path of ROUTES(aCampaign!).slice(1)) {
      const page = await html(context, path);
      expect(page, path).not.toContain(PRODUCT_A);
    }
  });

  test('a same-tab switch from A to B, and back and forward after it, never show A’s records to B', async ({
    page,
    context,
  }) => {
    await signIn(context, accountA());
    await page.goto('/campaigns');
    await expect(page.getByText(PRODUCT_A).first()).toBeVisible();

    await signIn(context, accountB());
    await page.goto('/campaigns');
    await expect(page.getByText(PRODUCT_B).first()).toBeVisible();
    expect(await page.content()).not.toContain(PRODUCT_A);

    // Navigate on and use history: the page B comes back to is B's, not a stored copy of A's.
    await page.goto('/campaigns?tab=drafts');
    await page.goBack();
    await page.waitForLoadState('load');
    await expect(page.getByText(PRODUCT_B).first()).toBeVisible();
    expect(await page.content()).not.toContain(PRODUCT_A);
    await page.goForward();
    await page.goBack();
    await expect(async () => {
      expect(await page.content()).not.toContain(PRODUCT_A);
    }).toPass();
    // The router cache keeps no dynamic page: a soft navigation to the same route asks the server again.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(PRODUCT_A);
  });

  test('the user’s bearer is in no HTML, RSC payload or dehydrated state, also when the prefetch fails', async ({
    context,
  }) => {
    await signIn(context, accountA());
    const bearer = await bearerOf(context);
    expect(bearer.length).toBeGreaterThan(20);
    const [id] = await campaignIds(accountA());
    for (const path of ROUTES(id!)) {
      expect(await html(context, path), path).not.toContain(bearer);
      const rsc = await context.request.get(path, { headers: { RSC: '1' } });
      expect(await rsc.text(), `${path} RSC`).not.toContain(bearer);
    }
    // A campaign that does not exist (the api answers 404 to the server's read): the page has nothing of the bearer either.
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const path of ROUTES(missing).slice(1))
      expect(await html(context, path), path).not.toContain(bearer);
    // An id that is not a campaign id is never put into a path the bearer is forwarded to.
    for (const bad of ['..%2fme', 'not-an-id']) {
      const res = await context.request.get(`/campaigns/${bad}/brief`);
      expect(await res.text()).not.toContain(bearer);
    }
  });

  test('every first-data route is no-store, with no validator, signed in', async ({ context }) => {
    await signIn(context, accountA());
    const [id] = await campaignIds(accountA());
    for (const path of ROUTES(id!)) {
      const res = await context.request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['cache-control'], path).toContain('no-store');
      expect(res.headers()['etag'], path).toBeUndefined();
    }
  });

  test('history arrives hydrated: the browser makes no repeat GET for it within 30 s (staleTime)', async ({
    page,
    context,
  }) => {
    await signIn(context, accountA());
    const gets: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'GET' && r.url().startsWith(`${stack().apiUrl}/api/v1/`))
        gets.push(new URL(r.url()).pathname.replace('/api/v1', '') + new URL(r.url()).search);
    });
    await page.goto('/campaigns');
    await expect(page.getByText(PRODUCT_A).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    for (const prefix of ['/me', '/campaigns?'])
      expect(
        gets.filter((g) => g === prefix || g.startsWith(prefix)),
        `no GET for ${prefix}`,
      ).toEqual([]);
    // Back and forth in the app inside the 30 s: still nothing repeated.
    await page.getByRole('tab', { name: /Drafts/ }).click();
    await page.getByRole('tab', { name: /History/ }).click();
    await page.waitForLoadState('networkidle');
    expect(gets.filter((g) => g.startsWith('/campaigns?'))).toEqual([]);
  });

  test('a cold load in another time zone and locale hydrates without a mismatch on the four routes', async ({
    browser,
  }) => {
    const a = accountA();
    await sql(
      `update campaigns set updated_at = now() - interval '30 days' where owner_id = (select id from users where idp_subject = $1)`,
      [a.sub],
    );
    const context = await browser.newContext({
      baseURL: stack().webUrl,
      timezoneId: 'Pacific/Kiritimati',
      locale: 'de-DE',
    });
    try {
      await signIn(context, a);
      const [id] = await campaignIds(a);
      const problems: string[] = [];
      for (const path of ROUTES(id!)) {
        const page = await context.newPage();
        page.on('console', (m) => {
          if (/hydrat|did not match|#418|#423|#425|text content does not match/i.test(m.text()))
            problems.push(`${path}: ${m.text().slice(0, 200)}`);
        });
        page.on('pageerror', (e) => {
          if (/hydrat|#418|#423|#425/i.test(e.message)) problems.push(`${path}: ${e.message}`);
        });
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.close();
      }
      expect(problems).toEqual([]);
      // The date a visitor sees is in their own locale once the page is up (after the placeholder).
      const page = await context.newPage();
      await page.goto('/campaigns');
      await expect(page.getByText(/Updated \d{1,2}\.? \S+ 20\d\d/).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a write straight after first paint sends the If-Match of the server’s read (ADR-010)', async ({
    page,
    context,
  }) => {
    const a = accountA();
    const [id] = await campaignIds(a);
    await sql(`update briefs set state = 'draft', accepted_at = null where campaign_id = $1`, [id]);
    const etag = await etagOf(a, `/campaigns/${id}/brief`);
    expect(etag).toBeTruthy();
    await signIn(context, a);
    const seen: (string | undefined)[] = [];
    await page.route(`${stack().apiUrl}/api/v1/campaigns/${id}/brief/accept`, async (route) => {
      seen.push(route.request().headers()['if-match']);
      await route.abort();
    });
    const reads: string[] = [];
    page.on('request', (r) => {
      if (
        r.method() === 'GET' &&
        r.url().startsWith(stack().apiUrl) &&
        r.url().endsWith(`/campaigns/${id}/brief`)
      )
        reads.push(r.url());
    });
    await page.goto(`/campaigns/${id}/brief`);
    const accept = page.getByRole('button', { name: /accept/i }).first();
    await expect(accept).toBeVisible();
    await accept.click();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(etag);
    expect(reads, 'the brief arrived hydrated: the browser did not read it first').toEqual([]);
  });
});

test.describe('@fe-perf-budgets prefetch refused or failed (ADR-014)', () => {
  let server: ChildProcess | undefined;
  let url = '';
  test.beforeAll(async () => {
    // The same build, run with a different api origin than it was built with: the server must not forward the bearer
    // (SEC-L3), so it renders without first data and the browser reads, as before the prefetch existed.
    const port = 3799;
    url = `http://127.0.0.1:${port}`;
    server = spawn(
      'pnpm',
      ['exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: resolve(__dirname, '../../..'),
        env: {
          ...process.env,
          APP_ENV: 'development',
          AUTH_MODE: 'local',
          WEB_ORIGIN: url,
          NEXT_PUBLIC_API_ORIGIN: 'http://127.0.0.1:9',
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
        },
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 60; i += 1) {
      try {
        if ((await fetch(`${url}/sign-in`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('second web server did not start');
  });
  test.afterAll(() => {
    server?.kill('SIGTERM');
  });

  test('the page renders its loading state, carries no records, and the browser then reads and fills it', async ({
    browser,
  }) => {
    const a = accountA();
    const context = await browser.newContext({ baseURL: url });
    try {
      await context.addCookies([{ name: 'shroomap_local_session', value: a.cookie, url }]);
      const page = await context.newPage();
      // The browser's reads go to the stack's api (this server's origin is not its CORS origin): answered through the
      // test's route with the right headers, the api's own answers inside.
      const origin = stack().apiUrl;
      await page.route(`${origin}/**`, async (route) => {
        const request = route.request();
        const cors = {
          'access-control-allow-origin': url,
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-expose-headers': 'x-request-id,etag,retry-after',
        };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const response = await route.fetch({
          headers: { ...request.headers(), authorization: `Bearer ${a.token}` },
        });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      });
      const res = await page.request.get(`${url}/campaigns`, {
        headers: { cookie: `shroomap_local_session=${a.cookie}` },
      });
      expect(res.status()).toBe(200);
      expect(await res.text()).not.toContain(PRODUCT_A);
      await page.goto('/campaigns');
      await expect(page.getByText(PRODUCT_A).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await context.close();
    }
  });
});
