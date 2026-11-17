import { expect, test } from '@playwright/test';

// Real browser, real api CORS config: no route handler adds headers, so a missing or wrong CORS header fails here.
// The api allows no credentials mode (auth is the Authorization bearer header), so the mutator must send credentials 'omit'.
test.describe('@AIU-269 cross-origin api calls from the browser', () => {
  test('generated-client mutator passes preflight and reads the api answer', async ({ page }) => {
    const api = process.env.E2E_API_URL!;
    const requests: { method: string; url: string }[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(api)) requests.push({ method: r.method(), url: r.url() });
    });
    const failures: string[] = [];
    page.on('requestfailed', (r) => failures.push(`${r.url()} ${r.failure()?.errorText}`));

    await page.goto('/api-probe');
    await expect(page.getByTestId('health')).toHaveText('http 200');
    await expect(page.getByTestId('me-error')).toHaveText(
      /^http:401:unauthenticated:[0-9a-f-]{36}$/,
    );
    expect(failures).toEqual([]);
    expect(requests.some((r) => r.url === `${api}/health/live`)).toBe(true);
  });

  test('credentials omit passes the real preflight, credentials include is blocked by it', async ({
    page,
  }) => {
    const api = process.env.E2E_API_URL!;
    const preflights: { status: number; allowCredentials: string | undefined }[] = [];
    const answers: number[] = [];
    const blocked: string[] = [];
    page.on('response', (r) => {
      if (!r.url().startsWith(`${api}/api/v1/me?probe=`)) return;
      if (r.request().method() === 'OPTIONS')
        preflights.push({
          status: r.status(),
          allowCredentials: r.headers()['access-control-allow-credentials'],
        });
      else answers.push(r.status());
    });
    page.on('requestfailed', (r) => {
      if (r.url().includes('?probe=')) blocked.push(r.method());
    });
    await page.goto('/api-probe');
    // The page wraps window.fetch, so each attempt is observed through the network events, not its result.
    for (const credentials of ['omit', 'include'] as const) {
      answers.length = 0;
      blocked.length = 0;
      await page
        .evaluate(
          async ([base, mode]) => {
            await fetch(`${base}/api/v1/me?probe=${mode}`, {
              credentials: mode as RequestCredentials,
              headers: { authorization: 'Bearer not-a-real-token' },
            }).catch(() => undefined);
          },
          [api, credentials],
        )
        .catch(() => undefined);
      if (credentials === 'omit') {
        expect(blocked).toEqual([]);
        expect(answers).toEqual([401]); // the request itself reached the api and its answer was readable
      } else {
        expect(answers).toEqual([]); // no request after a failed preflight
        expect(blocked.length).toBeGreaterThan(0);
      }
    }
    expect(preflights.every((p) => p.allowCredentials === undefined)).toBe(true);
  });
});
