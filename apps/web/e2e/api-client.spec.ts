import { expect, test } from '@playwright/test';

// The built web app calls the running built api through the generated hooks and the wrapped fetch,
// cross-origin against the api's real CORS configuration (no mocked headers).
test.describe('@TASK-082 api layer through the built web app', () => {
  test('health probe and an api error reach the page as real api answers', async ({ page }) => {
    const api = process.env.E2E_API_URL!;
    const sent: { url: string }[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(api)) sent.push({ url: r.url() });
    });

    await page.goto('/api-probe');
    await expect(page.getByTestId('health')).toHaveText('http 200');
    await expect(page.getByTestId('me-error')).toHaveText(
      /^http:401:unauthenticated:[0-9a-f-]{36}$/,
    );
    expect(sent.some((r) => r.url === `${api}/health/live`)).toBe(true);
    expect(sent.some((r) => r.url === `${api}/api/v1/me`)).toBe(true);
  });
});
