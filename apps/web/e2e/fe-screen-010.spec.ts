import { copyFileSync, mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-098';
const NOW = '2026-11-16T12:00:00.000Z';
const meta = { requestId: 'req-e2e', timestamp: NOW };
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz';

const key = (provider: string, over: Record<string, unknown> = {}) => ({
  provider,
  configured: true,
  status: 'active',
  last4: provider === 'openai' ? '7Q2d' : '9fK2',
  fingerprint: provider === 'openai' ? '4f9a1c07b21e' : 'b21e88d0aa11',
  version: 1,
  createdAt: '2026-11-03T09:14:00.000Z',
  updatedAt: '2026-11-03T09:14:00.000Z',
  lastValidatedAt: '2026-11-12T09:41:00.000Z',
  inFlightJobCount: 0,
  ...over,
});
const none = (provider: string) =>
  key(provider, { configured: false, status: null, last4: null, fingerprint: null, version: null, createdAt: null, updatedAt: null, lastValidatedAt: null });

const EVENTS = [
  { id: '11111111-1111-4111-8111-111111111111', provider: 'wavespeed', kind: 'deleted', at: '2026-11-12T16:05:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', provider: 'wavespeed', kind: 'test_failed', at: '2026-11-12T16:02:00.000Z' },
  { id: '33333333-3333-4333-8333-333333333333', provider: 'openai', kind: 'added', at: '2026-11-03T09:14:00.000Z' },
];
const ok = (data: unknown) => ({ status: 200, body: { success: true, data, metaData: meta } });
const events = { status: 200, body: { success: true, data: EVENTS, metaData: { ...meta, pagination: { type: 'cursor', limit: 20, returnedCount: 3, hasNextPage: false, nextCursor: null } } } };
const failure = (status: number, code: string, headers: Record<string, string> = {}) => ({ status, headers, body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta } });
const linked = ok({ linkState: 'linked', id: '8f3a0000-0000-4000-8000-00000000c21d', role: 'user', status: 'active', mfa: { required: true, satisfied: true }, recentAuth: { satisfied: true, maxAgeSeconds: 600 }, keyNotices: [] });

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';
interface Api {
  keys: Answer;
  put?: (provider: string, body: { apiKey?: string }) => Answer;
  del?: (provider: string) => Answer;
}

const signedIn = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp: Math.floor(Date.now() / 1000) + 600 }),
      url: baseURL,
    },
  ]);

/**
 * Contract-shaped answers for API-001 and API-010 to API-013 (labelled mocks: the browser is relayed with CORS headers,
 * the answer is fixed). The real-integration proof is the flow ticket; `real api` below only proves the entry point.
 */
async function mockApi(page: Page, api: Api) {
  const origin = process.env.E2E_API_URL!;
  const calls: string[] = [];
  const bodies: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*' } });
    }
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    const target = /\/me\/provider-keys\/([^/]+)$/.exec(url.pathname)?.[1];
    let answer: Answer;
    if (url.pathname.endsWith('/me/key-events')) answer = events;
    else if (url.pathname.endsWith('/me')) answer = linked;
    else if (url.pathname.endsWith('/me/provider-keys')) answer = api.keys;
    else if (target && request.method() === 'PUT') {
      const body = request.postDataJSON() as { apiKey?: string };
      bodies.push(JSON.stringify(body));
      answer = api.put?.(target, body) ?? 'hang';
    } else if (target && request.method() === 'DELETE') answer = api.del?.(target) ?? 'hang';
    else answer = failure(404, 'not_found');
    if (answer === 'hang') return new Promise<void>(() => undefined);
    return route.fulfill({
      status: answer.status,
      headers: { ...cors, ...(answer.headers ?? {}) },
      ...(answer.status === 204 ? {} : { contentType: 'application/json', body: JSON.stringify(answer.body) }),
    });
  });
  return { calls, bodies };
}

const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
};
const both = ok([key('openai'), key('wavespeed')]);
const wsMissing = ok([key('openai'), none('wavespeed')]);
const putOk = (provider: string, over: Record<string, unknown> = {}, probe = 'valid'): Answer =>
  ok({ ...key(provider, over), probe });

const open = (page: Page, name: string) => page.getByRole('button', { name }).click();

test.describe('@TASK-098 SCREEN-010 provider keys through the built web app', () => {
  test.use({ timezoneId: 'UTC' });
  test.beforeEach(async ({ context, baseURL, page }) => {
    await signedIn(context, baseURL!);
    await page.clock.setFixedTime(NOW);
  });

  test('real api: the page calls API-010 on the running api; without a bearer it answers 401 and the user goes to sign-in', async ({ page }) => {
    const origin = process.env.E2E_API_URL!;
    const sent: string[] = [];
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const cors = { 'access-control-allow-origin': (await request.headerValue('origin')) ?? '*', 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'x-request-id' };
      if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*' } });
      }
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    await page.goto('/settings/provider-keys');
    await page.waitForURL('**/sign-in**');
    expect(sent).toContain('GET /api/v1/me/provider-keys');
    expect(new URL(page.url()).searchParams.get('return')).toBe('/settings/provider-keys');
  });

  test('default: hint and fingerprint only, only the listed operations, no third-party script, keyboard-only replace', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'script' && !r.url().startsWith(page.url().split('/settings')[0]!)) scripts.push(r.url());
    });
    const { calls, bodies } = await mockApi(page, { keys: both, put: (p) => putOk(p, { last4: 'Zz09', version: 2 }) });
    await page.goto('/settings/provider-keys');
    await expect(page.getByRole('heading', { level: 1, name: 'Provider keys' })).toBeVisible();
    expect(await page.title()).toBe('Provider keys · ShrooMap');
    await expect(page.getByTestId('key-hint').first()).toHaveText('…7Q2d');
    await expect(page.getByText('4f9a1c07b21e')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('sk-');
    await page.getByRole('button', { name: 'Replace OpenAI key' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Replace OpenAI key?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('New OpenAI API key')).toBeFocused();
    await page.keyboard.type(KEY);
    await page.keyboard.press('Enter');
    await expect(page.getByText('OpenAI key saved', { exact: true })).toBeVisible();
    await expect(page.getByText(/It ends in …Zz09/)).toBeVisible();
    expect(bodies).toEqual([JSON.stringify({ apiKey: KEY })]);
    await expect(page.locator('body')).not.toContainText(KEY);
    expect(new Set(calls.map((c) => c.split('?')[0]))).toEqual(new Set(['GET /api/v1/me', 'GET /api/v1/me/provider-keys', 'GET /api/v1/me/key-events', 'PUT /api/v1/me/provider-keys/openai']));
    expect(scripts).toEqual([]);
  });

  test('delete: the confirmation states the backup retention and calls API-012', async ({ page }) => {
    const { calls } = await mockApi(page, { keys: both, del: () => ({ status: 204 }) });
    await page.goto('/settings/provider-keys');
    await open(page, 'Delete WaveSpeed key');
    const dialog = page.getByRole('dialog', { name: 'Delete WaveSpeed key?' });
    await expect(dialog).toContainText('Backups age out within 30 days.');
    await dialog.getByRole('button', { name: 'Delete key' }).click();
    await expect(page.getByText('WaveSpeed key deleted.')).toBeVisible();
    expect(calls).toContain('DELETE /api/v1/me/provider-keys/wavespeed');
  });

  test('step-up: recent_auth_required shows the section 9.1 dialog and submits nothing again', async ({ page }) => {
    const { calls } = await mockApi(page, { keys: wsMissing, put: () => failure(403, 'recent_auth_required') });
    await page.goto('/settings/provider-keys');
    await open(page, 'Add WaveSpeed key');
    await page.getByLabel('WaveSpeed API key').fill(KEY);
    await page.getByRole('button', { name: 'Test and save' }).click();
    const step = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(step).toContainText('For your security, confirm it is you again to continue.');
    await page.keyboard.press('Escape');
    await expect(step).toBeHidden();
    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
  });

  const OPEN_ADD = async (page: Page) => {
    await open(page, 'Add WaveSpeed key');
    await expect(page.getByRole('dialog', { name: 'Add WaveSpeed key' })).toBeVisible();
  };
  const SUBMIT = async (page: Page) => {
    await page.getByLabel('WaveSpeed API key').fill(KEY);
    await page.getByRole('button', { name: 'Test and save' }).click();
  };

  const STATES: { state: string; api: () => Api; ready: (p: Page) => Promise<void> }[] = [
    { state: 'default', api: () => ({ keys: wsMissing }), ready: (p) => expect(p.getByRole('heading', { name: 'OpenAI' })).toBeVisible() },
    { state: 'loading', api: () => ({ keys: 'hang' }), ready: (p) => expect(p.getByText('Loading provider keys')).toBeVisible() },
    { state: 'empty', api: () => ({ keys: ok([none('openai'), none('wavespeed')]) }), ready: (p) => expect(p.getByText('Add both keys to create ads')).toBeVisible() },
    { state: 'add-dialog', api: () => ({ keys: wsMissing }), ready: OPEN_ADD },
    { state: 'testing', api: () => ({ keys: wsMissing, put: () => 'hang' }), ready: async (p) => { await OPEN_ADD(p); await SUBMIT(p); await expect(p.getByText(/Testing the key/)).toBeVisible(); } },
    { state: 'validation-error', api: () => ({ keys: wsMissing, put: () => failure(422, 'key_invalid') }), ready: async (p) => { await OPEN_ADD(p); await SUBMIT(p); await expect(p.getByText(/did not accept this key/)).toBeVisible(); } },
    { state: 'rate-limited', api: () => ({ keys: wsMissing, put: () => failure(429, 'rate_limited', { 'retry-after': '420' }) }), ready: async (p) => { await OPEN_ADD(p); await SUBMIT(p); await expect(p.getByText('Too many attempts. Try again in 7 minutes.')).toBeVisible(); } },
    { state: 'step-up', api: () => ({ keys: wsMissing, put: () => failure(403, 'recent_auth_required') }), ready: async (p) => { await OPEN_ADD(p); await SUBMIT(p); await expect(p.getByRole('dialog', { name: 'Confirm it is you' })).toBeVisible(); } },
    { state: 'saved', api: () => ({ keys: wsMissing, put: (provider) => putOk(provider, { last4: '9fK2' }) }), ready: async (p) => { await OPEN_ADD(p); await SUBMIT(p); await expect(p.getByText('WaveSpeed key saved', { exact: true })).toBeVisible(); } },
    { state: 'untested', api: () => ({ keys: ok([key('openai'), key('wavespeed', { status: 'untested', lastValidatedAt: null })]) }), ready: (p) => expect(p.getByTestId('untested-wavespeed')).toBeVisible() },
    { state: 'replace-warning', api: () => ({ keys: ok([key('openai', { inFlightJobCount: 1 }), key('wavespeed')]) }), ready: async (p) => { await open(p, 'Replace OpenAI key'); await expect(p.getByText(/1 job is running on the current key/)).toBeVisible(); } },
    { state: 'delete-confirm', api: () => ({ keys: both }), ready: async (p) => { await open(p, 'Delete OpenAI key'); await expect(p.getByRole('dialog', { name: 'Delete OpenAI key?' })).toBeVisible(); } },
    { state: 'disabled', api: () => ({ keys: ok([key('openai'), key('wavespeed', { status: 'disabled' })]) }), ready: (p) => expect(p.getByText('Your WaveSpeed key was disabled')).toBeVisible() },
  ];

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    for (const { state, api, ready } of STATES) {
      test(`${state} at ${name} px: axe, screenshot, baseline`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        await mockApi(page, api());
        await page.goto('/settings/provider-keys');
        await ready(page);
        await settle(page);
        await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-${state}-${name}.json`);
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        const baseline = `fe-screen-010-${state}-${name}.png`;
        await expect(page).toHaveScreenshot(baseline, { fullPage: true });
        // The evidence copy is the verified baseline, so a rerun leaves the committed files unchanged (spinner jitter).
        copyFileSync(info.snapshotPath(baseline), `${evidence}/screenshots/${state}-${name}.png`);
      });
    }
  }
});
