import { expect, test } from '@playwright/test';

// The built web app calls the running built api through the generated hooks and the wrapped fetch.
// The api sets no CORS headers yet, so the browser request is relayed through the test's own route handler,
// which performs the same request against the real api and adds the CORS headers.
test.describe('@TASK-082 api layer through the built web app', () => {
  test('health probe and an api error reach the page as real api answers', async ({ page }) => {
    const api = process.env.E2E_API_URL!;
    const sent: { url: string; authorization: string | null }[] = [];
    await page.route(`${api}/**`, async (route) => {
      const request = route.request();
      sent.push({ url: request.url(), authorization: await request.headerValue('authorization') });
      const cors = {
        'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'x-request-id,etag',
      };
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
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });

    await page.goto('/api-probe');
    await expect(page.getByTestId('health')).toHaveText('http 200');
    await expect(page.getByTestId('me-error')).toHaveText(/^http:404:not_found:[0-9a-f-]{36}$/);
    expect(sent.some((r) => r.url === `${api}/health/live`)).toBe(true);
    expect(sent.some((r) => r.url === `${api}/api/v1/me`)).toBe(true);
  });
});
