import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-101';
const SETTINGS = '/api/v1/admin/settings';
const MODE = '/api/v1/admin/settings/signup-mode';

const signedIn = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp: Math.floor(Date.now() / 1000) + 600 }),
      url: baseURL,
    },
  ]);

const settings = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    success: true,
    data: {
      signupMode: 'invited_only',
      accessRequestFormEnabled: false,
      mfaRequiredFor: 'all',
      inviteEmailDomains: [],
      openModePrerequisites: { emailVerificationRequired: false, signupRateLimitEnabled: false, abuseLimitsEnabled: false, verificationRecordId: null },
      ...over,
    },
    metaData: { requestId: 'req-e2e-13' },
  });

const refusal = JSON.stringify({
  success: false,
  error: {
    code: 'signup_open_prerequisites',
    message: 'Email verification is not enabled. No verification record exists.',
    details: [],
  },
  metaData: { requestId: 'req-e2e-13' },
});

type Reply = (o: Parameters<Route['fulfill']>[0]) => Promise<void>;
type Handler = (route: { fulfill: Reply; body: () => string | null }, method: string, path: string) => Promise<void> | void;

// The built web app calls the api origin. The api sets no CORS headers yet, so browser requests are relayed through the
// route handler, which adds them; the two admin operations are scripted (contract-shaped) because the local test
// session is not an administrator of the real api. Everything else, and every other path, reaches the real api.
async function relay(page: Page, scripted?: Handler) {
  const api = process.env.E2E_API_URL!;
  await page.route(`${api}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*' },
      });
    }
    const path = new URL(request.url()).pathname;
    if (scripted && (path === SETTINGS || path === MODE)) {
      return scripted(
        {
          fulfill: (o) => route.fulfill({ ...o, headers: { ...(o?.headers ?? {}), ...cors } }),
          body: () => request.postData(),
        },
        request.method(),
        path,
      );
    }
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}

const json = (body: string, status = 200) => ({ status, contentType: 'application/json', body });

test.describe('@TASK-101 SCREEN-013 admin settings through the built web app', () => {
  test.beforeEach(async ({ context, baseURL }, info) => {
    test.skip(info.project.name !== 'chromium');
    await signedIn(context, baseURL!);
  });

  test('real api without an administrator session sends the page to sign-in (real entry point)', async ({ page }) => {
    await relay(page);
    await page.route('**/sign-in**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Sign in stub</main>' }));
    await page.goto('/admin/settings');
    await expect(page).toHaveURL(/\/sign-in\?reason=session-expired&return=%2Fadmin%2Fsettings$/);
  });

  test('default, keyboard-only save of open mode, saved toast; only API-120 and API-121 are called', async ({ page }) => {
    const calls: string[] = [];
    let mode = 'invited_only';
    await relay(page, async (route, method, path) => {
      calls.push(`${method} ${path}`);
      if (method === 'PUT') {
        mode = JSON.parse(route.body() ?? '{}').mode;
        return route.fulfill(json(settings({ signupMode: mode })));
      }
      return route.fulfill(json(settings({ signupMode: mode })));
    });
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await page.title()).toBe('Settings · ShrooMap');
    await expect(page.getByRole('radio', { name: /Invited only/ })).toBeChecked();
    // keyboard only: the radio group, then the save button
    await page.getByRole('radio', { name: /Invited only/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Open/ })).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Save sign-up mode' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Sign-up mode saved.')).toBeVisible();
    expect(calls).toEqual(['GET ' + SETTINGS, 'PUT ' + MODE]);
  });

  test('open-refused explains what is missing and keeps Invited only; the step-up dialog is keyboard operable', async ({ page }) => {
    let step = 0;
    await relay(page, async (route, method) => {
      if (method === 'GET') return route.fulfill(json(settings()));
      step += 1;
      return route.fulfill(
        step === 1
          ? json(refusal, 422)
          : json(JSON.stringify({ success: false, error: { code: 'recent_auth_required', message: 'x', details: [] }, metaData: { requestId: 'r' } }), 403),
      );
    });
    await page.goto('/admin/settings');
    await page.locator('label', { hasText: 'Anyone can create an account' }).click();
    await page.getByRole('button', { name: 'Save sign-up mode' }).click();
    await expect(page.getByText(/Open sign-up cannot be turned on yet\. Email verification is not enabled/)).toBeVisible();
    await expect(page.getByRole('radio', { name: /Invited only/ })).toBeChecked();
    await page.locator('label', { hasText: 'Anyone can create an account' }).click();
    await page.getByRole('button', { name: 'Save sign-up mode' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('For your security, confirm it is you again to continue.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('radio', { name: /Open/ })).toBeChecked();
  });

  for (const { name, width, height } of VIEWPORTS) {
    for (const state of ['default', 'open-refused', 'saved', 'loading'] as const) {
      test(`${state} at ${name} px: no axe violations and a screenshot`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await relay(page, async (route, method) => {
          if (method === 'GET') {
            if (state === 'loading') await gate;
            return route.fulfill(json(settings()));
          }
          return route.fulfill(state === 'saved' ? json(settings({ signupMode: 'open', openModePrerequisites: { emailVerificationRequired: true, signupRateLimitEnabled: true, abuseLimitsEnabled: true, verificationRecordId: 'VR-2026-04' } })) : json(refusal, 422));
        });
        await page.goto('/admin/settings');
        if (state === 'loading') {
          await expect(page.getByText('Loading settings')).toBeVisible();
        } else {
          await expect(page.getByRole('heading', { level: 2, name: 'Sign-up' })).toBeVisible();
          if (state !== 'default') {
            await page.locator('label', { hasText: 'Anyone can create an account' }).click();
            await page.getByRole('button', { name: 'Save sign-up mode' }).click();
            await expect(page.getByText(state === 'saved' ? 'Sign-up mode saved.' : /Open sign-up cannot be turned on yet/)).toBeVisible();
          }
        }
        await page.evaluate(() => document.fonts.ready);
        await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-${state}-${name}.json`);
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        await page.screenshot({ path: `${evidence}/screenshots/${state}-${name}.png`, fullPage: true });
        await expect(page).toHaveScreenshot(`fe-screen-013-${state}-${name}.png`, { fullPage: true });
        release();
      });
    }
  }
});
