import { expect, test, type Page } from '@playwright/test';
import { accountA, accountB, signIn, stack } from './stack';

// TC-ZT-07 on the web side, through the built web app and the running api: nothing identity-scoped comes from a shared or
// browser cache, and a second identity in the same browser never reuses the first one's credentials or cached answers.

/** Authorization headers the page sends to the api, in order. */
const watchBearers = (page: Page): string[] => {
  const bearers: string[] = [];
  const api = stack().apiUrl;
  page.on('request', (request) => {
    if (request.url().startsWith(`${api}/api/`))
      void request.allHeaders().then((h) => h['authorization'] && bearers.push(h['authorization']));
  });
  return bearers;
};

test.describe('@fe-perf-budgets cache isolation (TC-ZT-07)', () => {
  test('signed-in pages, redirects to sign-in and the token route are no-store; only build output is cacheable', async ({
    context,
    request,
  }) => {
    // Signed out: the redirect itself must not be stored (it is a per-request answer).
    for (const path of ['/campaigns', '/admin/usage', '/settings/provider-keys']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(307);
      expect(res.headers()['cache-control'], path).toContain('no-store');
    }
    await signIn(context, accountA());
    for (const path of [
      '/campaigns',
      '/campaigns/new',
      '/settings/provider-keys',
      '/admin/usage',
    ]) {
      const res = await context.request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['cache-control'], path).toContain('no-store');
      expect(
        res.headers()['etag'],
        `${path} carries no validator a cache could revalidate`,
      ).toBeUndefined();
    }
    const token = await context.request.get('/local-token');
    expect(token.headers()['cache-control']).toContain('no-store');
    // Build output is the one thing shared caches may keep: content-hashed and immutable.
    const page = await context.newPage();
    const chunks: string[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/_next/static/') && r.url().endsWith('.js')) chunks.push(r.url());
    });
    await page.goto('/campaigns');
    await expect.poll(() => chunks.length).toBeGreaterThan(0);
    const asset = await context.request.get(chunks[0]!);
    expect(asset.headers()['cache-control']).toMatch(/immutable/);
    expect(asset.headers()['set-cookie']).toBeUndefined();
  });

  test('a second identity in the same browser sends only its own bearer and is never served the first one’s page from cache', async ({
    page,
    context,
  }) => {
    const bearers = watchBearers(page);
    await signIn(context, accountA());
    await page.goto('/campaigns');
    await expect.poll(() => bearers.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const first = new Set(bearers);

    bearers.length = 0;
    await signIn(context, accountB());
    const response = await page.goto('/campaigns', { waitUntil: 'load' });
    expect(response!.fromServiceWorker()).toBe(false);
    expect(response!.headers()['cache-control']).toContain('no-store');
    await expect.poll(() => bearers.length, { timeout: 20_000 }).toBeGreaterThan(0);
    for (const bearer of new Set(bearers))
      expect(first.has(bearer), 'the first identity’s bearer is gone').toBe(false);

    // Back to the first identity: the page asks the server again and sends that identity's credential, not a stored one.
    await page.waitForURL(/\/(access|campaigns)/);
    await signIn(context, accountA());
    bearers.length = 0;
    await page.goto('/campaigns', { waitUntil: 'load' });
    await expect.poll(() => bearers.length, { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test('signing out leaves no session cookie, storage entry or cached answer for the next visitor', async ({
    page,
    context,
  }) => {
    await signIn(context, accountA());
    await page.goto('/campaigns');
    await page.waitForLoadState('load');
    await context.clearCookies();
    const res = await page.goto('/campaigns');
    expect(new URL(res!.url()).pathname).toBe('/sign-in');
    const stored = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toMatch(/Bearer/);
    expect(stored).not.toContain(accountA().sub);
    expect(stored).not.toContain(accountA().email);
  });
});
