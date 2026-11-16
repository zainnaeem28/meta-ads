import { mkdirSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

type Fulfill = Route['fulfill'];
import { expectNoAxeViolations } from '../tests/support/axe';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-083';
const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
];

// The built web app against the running built api. The api sets no CORS headers yet, so browser requests to it are
// relayed through the test's route handler, which adds them. Answers for the assembly endpoint are scripted
// (contract-shaped) because the real api cannot be made to fail on demand; GET /me is answered by the real api.
async function relay(
  page: Page,
  assembly?: (fulfill: Fulfill, count: number, key: string | null) => Promise<void>,
  scripted = '/assemblies',
) {
  const api = process.env.E2E_API_URL!;
  let count = 0;
  await page.route(`${api}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-headers':
            (await request.headerValue('access-control-request-headers')) ?? '*',
        },
      });
    }
    if (assembly && request.url().includes(scripted)) {
      count += 1;
      return assembly(
        (o) => route.fulfill({ ...o, headers: { ...(o?.headers ?? {}), ...cors } }),
        count,
        await request.headerValue('idempotency-key'),
      );
    }
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}

const envelope = (code: string, message: string, extra: object = {}) =>
  JSON.stringify({
    success: false,
    error: { code, message, ...extra },
    metaData: { requestId: 'req-e2e-1' },
  });

test.describe('@TASK-083 error presentation through the built web app', () => {
  // The real api answers GET /me without a session with 401 unauthenticated: the session-expired row redirects to
  // sign-in with a safe return path. The sign-in screen does not exist yet, so its target is stubbed.
  test('real api unauthenticated on a page load redirects to sign-in with a safe return path', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'chromium');
    await relay(page);
    await page.route('**/sign-in**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Sign in stub</main>' }),
    );
    await page.goto('/error-probe?scenario=load');
    await expect(page).toHaveURL(
      /\/sign-in\?reason=session-expired&return=%2Ferror-probe%3Fscenario%3Dload$/,
    );
    await expect(page.getByText('Sign in stub')).toBeVisible();
  });

  for (const viewport of VIEWPORTS) {
    test(`not_found on a page load renders the unavailable state with Go Home at ${viewport.name}`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'chromium');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await relay(
        page,
        async (fulfill) =>
          fulfill({
            status: 404,
            contentType: 'application/json',
            body: envelope('not_found', 'no such row in table users'),
          }),
        '/api/v1/me',
      );
      await page.goto('/error-probe?scenario=load');
      const alert = page
        .getByRole('alert')
        .filter({ hasText: 'This page or item is not available.' });
      await expect(alert).toBeVisible();
      await expect(alert.getByRole('link', { name: 'Go Home' })).toHaveAttribute('href', '/');
      await expect(page.locator('main')).not.toContainText(/\b404\b|stack|not_found|table/i);
      await page.evaluate(() => document.fonts.ready);
      await expectNoAxeViolations(page, `${evidence}/axe/not-found-${viewport.name}.json`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await page.screenshot({ path: `${evidence}/screenshots/not-found-${viewport.name}.png` });
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`503 with Retry-After on a job-creating write: countdown, reference, same idempotency key on retry at ${viewport.name}`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'chromium');
      const keys: (string | null)[] = [];
      await relay(page, async (fulfill, count, key) => {
        keys.push(key);
        if (count === 1)
          return fulfill({
            status: 503,
            contentType: 'application/json',
            headers: { 'Retry-After': '3', 'X-Request-ID': 'req-e2e-1' },
            body: envelope('service_unavailable', 'upstream is down'),
          });
        return fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: {} }),
        });
      });
      {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        keys.length = 0;
        await page.goto('/error-probe?scenario=assemble');
        await page.waitForLoadState('networkidle');
        await page.getByRole('button', { name: 'Assemble' }).click();
        const alert = page
          .getByRole('status')
          .filter({ hasText: 'ShrooMap is temporarily unavailable.' });
        await expect(alert).toContainText('You can try again in 3 seconds.');
        await expect(alert).toContainText('Check the list before you repeat this.');
        await expect(alert).toContainText('req-e2e-1');
        await expect(alert).not.toContainText('upstream is down');
        const retry = alert.getByRole('button', { name: /^Try again/ });
        await expect(retry).toBeDisabled();
        await expect(retry).toHaveText(/Try again in [123]s/);
        await page.evaluate(() => document.fonts.ready);
        await expectNoAxeViolations(page, `${evidence}/axe/unavailable-${viewport.name}.json`);
        await page.screenshot({ path: `${evidence}/screenshots/unavailable-${viewport.name}.png` });
        await expect(retry).toBeEnabled({ timeout: 6000 });
        await retry.click();
        await expect(page.getByText('Assembled')).toBeVisible();
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBeTruthy();
        expect(keys[1]).toBe(keys[0]);
      }
    });
  }

  test('500 shows the reference, an enabled Try again and the three-failure hint', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'chromium');
    await relay(page, async (fulfill) =>
      fulfill({
        status: 500,
        contentType: 'application/json',
        headers: { 'X-Request-ID': 'req-e2e-1' },
        body: envelope('internal_error', 'relation "assemblies" does not exist'),
      }),
    );
    await page.goto('/error-probe?scenario=assemble');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Assemble' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong on our side.' });
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await expect(alert).not.toContainText('relation');
    await expect(alert).not.toContainText('If this continues');
    for (let i = 0; i < 3; i += 1) await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(alert).toContainText('If this continues, contact your administrator.');
  });

  test('session expired redirects to sign-in with a safe return path', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium');
    await relay(page, async (fulfill) =>
      fulfill({
        status: 401,
        contentType: 'application/json',
        body: envelope('unauthenticated', 'token expired'),
      }),
    );
    await page.goto('/error-probe?scenario=assemble&draft=7');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Assemble' }).click();
    await expect(page).toHaveURL(
      /\/sign-in\?reason=session-expired&return=%2Ferror-probe%3Fscenario%3Dassemble%26draft%3D7$/,
    );
  });

  for (const viewport of VIEWPORTS) {
    test(`qc_confirmation_required opens the recovery dialog; confirming resubmits with the override at ${viewport.name}`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'chromium');
      const bodies: unknown[] = [];
      await relay(page, async (fulfill, count) => {
        bodies.push(count);
        if (count === 1)
          return fulfill({
            status: 422,
            contentType: 'application/json',
            body: envelope('qc_confirmation_required', 'Segment 2 did not pass the check.'),
          });
        return fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: {} }),
        });
      });
      {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto('/error-probe?scenario=assemble');
        await page.waitForLoadState('networkidle');
        await page.getByRole('button', { name: 'Assemble' }).click();
        const dialog = page.getByRole('dialog', {
          name: 'Confirm clips that did not pass the check',
        });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('The final ad will include these clips as they are.');
        await page.evaluate(() => document.fonts.ready);
        await expectNoAxeViolations(page, `${evidence}/axe/qc-confirm-${viewport.name}.json`);
        await page.screenshot({ path: `${evidence}/screenshots/qc-confirm-${viewport.name}.png` });
        await dialog.getByRole('button', { name: 'Include these clips and assemble' }).click();
        await expect(page.getByText('Assembled')).toBeVisible();
      }
    });
  }
});
