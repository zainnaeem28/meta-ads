import { expect, test, type BrowserContext, type Response } from '@playwright/test';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

// Built artifacts (`next start` in AUTH_MODE=local and the compiled api in IDENTITY_MODE=local): the signed-in screen
// sends the api's local-mode bearer and the real api accepts it. No api answer is mocked.
const signIn = async (context: BrowserContext, baseURL: string, email: string) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({
        sub: 'user_local_e2e',
        email,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      url: baseURL,
    },
  ]);

test('a signed-in local user reaches the real api with a bearer (owner email becomes the first administrator)', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL!, 'owner@example.com');
  const api = process.env.E2E_API_URL!;
  const calls: { path: string; status: number; bearer: boolean }[] = [];
  page.on('response', (r: Response) => {
    if (!r.url().startsWith(`${api}/api/`)) return;
    void r
      .request()
      .allHeaders()
      .then((h) =>
        calls.push({
          path: new URL(r.url()).pathname,
          status: r.status(),
          bearer: /^Bearer .+/.test(h['authorization'] ?? ''),
        }),
      );
  });
  await page.goto('/admin/accounts');
  await expect
    .poll(() => calls.filter((c) => c.bearer).length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const signed = calls.filter((c) => c.bearer);
  expect(
    signed.every((c) => c.status !== 401),
    JSON.stringify(calls),
  ).toBe(true);
  expect(
    signed.some((c) => c.status === 200),
    JSON.stringify(calls),
  ).toBe(true);
});

test('without a session no bearer is sent', async ({ page }) => {
  const api = process.env.E2E_API_URL!;
  const bearers: boolean[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${api}/api/`))
      void r.allHeaders().then((h) => bearers.push('authorization' in h));
  });
  await page.goto('/admin/accounts');
  await page.waitForLoadState('networkidle');
  expect(bearers.every((b) => !b)).toBe(true);
});
