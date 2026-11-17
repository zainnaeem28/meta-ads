import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

// TC-FLW-11 (FLOW-11, J-06): SCREEN-010 provider keys through the built web app (`next start`) and the built api.
// The signed-in api answers are a labelled, stateful contract mock (API-001, 010, 011, 012, 013 shapes, taken from the
// screen's own contract tests): the built web sends no bearer without an identity provider and the api's local identity
// mints tokens only in-process, so no operator token exists out of process, and the worker, provider stubs and a
// running job are not reachable through an unauthenticated api. The running job and the worker's repeated refusals
// are therefore state in the mock (`World.jobs`, `World.refuse`), never a claim of a real job. The 401 door is the real api.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-112';
const PATH = '/settings/provider-keys';
const NOW = '2026-11-16T12:00:00.000Z';
const meta = { requestId: 'req-e2e', timestamp: NOW };
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz';
const BAD = 'sk-proj-wrongwrongwrongwrong0000';
const NEW = 'sk-proj-ZZZZZZZZZZZZZZZZZZZZ1234';

type Provider = 'openai' | 'wavespeed';
type Outcome = 'valid' | 'unknown' | 'key_invalid' | 'rate_limited' | 'step_up' | 'unauthenticated';
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
interface KeyRow {
  provider: Provider;
  configured: boolean;
  status: string | null;
  last4: string | null;
  fingerprint: string | null;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastValidatedAt: string | null;
  inFlightJobCount: number;
}
interface Event {
  id: string;
  provider: Provider;
  kind: string;
  at: string;
}
interface Job {
  id: string;
  provider: Provider;
  state: 'running' | 'failed';
  cause: string | null;
}

const none = (provider: Provider): KeyRow => ({
  provider,
  configured: false,
  status: null,
  last4: null,
  fingerprint: null,
  version: null,
  createdAt: null,
  updatedAt: null,
  lastValidatedAt: null,
  inFlightJobCount: 0,
});

/** The api as the journey sees it: keys, key events and stub jobs in one state, so each answer follows from the calls before it. */
class World {
  keys: Record<Provider, KeyRow> = { openai: none('openai'), wavespeed: none('wavespeed') };
  events: Event[] = [];
  jobs: Job[] = [];
  plan: Record<Provider, Outcome[]> = { openai: [], wavespeed: [] };
  /** The wait the rate-limit answer states, in seconds. */
  retryAfter = 420;
  /** Every key sent to the api (PUT bodies), to prove what left the browser. */
  sent: string[] = [];
  calls: string[] = [];
  private clock = 0;

  constructor(seed: Partial<Record<Provider, { last4: string; jobs?: number }>> = {}) {
    for (const [provider, s] of Object.entries(seed) as [
      Provider,
      { last4: string; jobs?: number },
    ][]) {
      this.keys[provider] = this.row(provider, s.last4, 1);
      for (let i = 0; i < (s.jobs ?? 0); i += 1)
        this.jobs.push({ id: `job-${provider}-${i}`, provider, state: 'running', cause: null });
      this.sync();
    }
  }

  private stamp = () =>
    new Date(Date.parse('2026-11-16T09:00:00.000Z') + (this.clock += 60_000)).toISOString();
  private row(provider: Provider, last4: string, version: number): KeyRow {
    const at = '2026-11-03T09:14:00.000Z';
    return {
      provider,
      configured: true,
      status: 'active',
      last4,
      fingerprint: `${provider === 'openai' ? '4f9a1c07' : 'b21e88d0'}${last4.toLowerCase().padEnd(4, '0')}`,
      version,
      createdAt: at,
      updatedAt: this.stamp(),
      lastValidatedAt: this.stamp(),
      inFlightJobCount: 0,
    };
  }
  private event = (provider: Provider, kind: string) =>
    this.events.unshift({
      id: `00000000-0000-4000-8000-${String(this.events.length + 1).padStart(12, '0')}`,
      provider,
      kind,
      at: this.stamp(),
    });
  /** A stub job starts on the provider's key (the worker is not reachable, see the header). */
  startJob(provider: Provider) {
    this.jobs.push({
      id: `job-stub-${this.jobs.length + 1}`,
      provider,
      state: 'running',
      cause: null,
    });
    this.sync();
  }
  private sync() {
    for (const p of ['openai', 'wavespeed'] as const)
      this.keys[p].inFlightJobCount = this.jobs.filter(
        (j) => j.provider === p && j.state === 'running',
      ).length;
  }

  /** The worker saw the provider refuse the stored key five times in a row: the key is disabled (REQ-018). */
  refuse(provider: Provider) {
    for (let i = 0; i < 5; i += 1) this.event(provider, 'auth_failed');
    this.keys[provider] = { ...this.keys[provider], status: 'disabled' };
    this.event(provider, 'disabled');
  }

  put(provider: Provider, apiKey: string): Answer {
    this.sent.push(apiKey);
    const outcome = this.plan[provider].shift() ?? 'valid';
    if (outcome === 'step_up') return failure(403, 'recent_auth_required');
    if (outcome === 'unauthenticated') return failure(401, 'unauthenticated');
    if (outcome === 'rate_limited') {
      this.event(provider, 'attempt_rate_limited');
      return failure(429, 'rate_limited', { 'retry-after': String(this.retryAfter) });
    }
    if (outcome === 'key_invalid') {
      this.event(provider, 'test_failed');
      return failure(422, 'key_invalid');
    }
    const had = this.keys[provider].configured;
    const next = this.row(provider, apiKey.slice(-4), (this.keys[provider].version ?? 0) + 1);
    this.keys[provider] = {
      ...next,
      createdAt: had ? this.keys[provider].createdAt : next.createdAt,
    };
    // Replacing a key under a running job fails that job cleanly (REQ-017): no partial result, a named cause.
    for (const job of this.jobs)
      if (job.provider === provider && job.state === 'running')
        Object.assign(job, { state: 'failed', cause: 'key replaced during the job' });
    this.sync();
    this.event(provider, had ? 'replaced' : 'added');
    this.event(provider, outcome === 'valid' ? 'test_passed' : 'stored_untested');
    return ok({ ...this.keys[provider], probe: outcome });
  }

  del(provider: Provider): Answer {
    for (const job of this.jobs)
      if (job.provider === provider && job.state === 'running')
        Object.assign(job, { state: 'failed', cause: 'key deleted during the job' });
    this.keys[provider] = none(provider);
    this.sync();
    this.event(provider, 'deleted');
    return { status: 204 };
  }
}

const ok = (data: unknown, status = 200): Answer => ({
  status,
  body: { success: true, data, metaData: meta },
});
const failure = (status: number, code: string, headers: Record<string, string> = {}): Answer => ({
  status,
  headers,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});
const me = ok({
  linkState: 'linked',
  id: '8f3a0000-0000-4000-8000-00000000c21d',
  role: 'user',
  status: 'active',
  mfa: { required: true, satisfied: true },
  recentAuth: { satisfied: true, maxAgeSeconds: 600 },
  keyNotices: [],
});

function answer(
  w: World,
  method: string,
  path: string,
  body: unknown,
  listError: Answer | null,
): Answer {
  if (path === '/me') return me;
  if (path === '/me/provider-keys') return listError ?? ok([w.keys.openai, w.keys.wavespeed]);
  if (path === '/me/key-events') {
    return {
      status: 200,
      body: {
        success: true,
        data: w.events,
        metaData: {
          ...meta,
          pagination: {
            type: 'cursor',
            limit: 20,
            returnedCount: w.events.length,
            hasNextPage: false,
            nextCursor: null,
          },
        },
      },
    };
  }
  const target = /^\/me\/provider-keys\/(openai|wavespeed)$/.exec(path)?.[1] as
    Provider | undefined;
  if (target && method === 'PUT') return w.put(target, (body as { apiKey: string }).apiKey);
  if (target && method === 'DELETE') return w.del(target);
  return failure(404, 'not_found');
}

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

/** Relays the browser's api calls with CORS headers and answers each from `w`, or from the running api when `real`. */
async function api(page: Page, w: World, opts: { real?: boolean; listError?: Answer } = {}) {
  const origin = process.env.E2E_API_URL!;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-headers':
            (await request.headerValue('access-control-request-headers')) ?? '*',
          'access-control-allow-methods': '*',
        },
      });
    }
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    w.calls.push(`${request.method()} ${path}`);
    if (opts.real) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    }
    const a = answer(
      w,
      request.method(),
      path,
      request.method() === 'GET' || request.method() === 'DELETE' ? null : request.postDataJSON(),
      opts.listError ?? null,
    );
    return route.fulfill({
      status: a.status,
      headers: { ...cors, ...(a.headers ?? {}) },
      ...(a.status === 204
        ? {}
        : { contentType: 'application/json', body: JSON.stringify(a.body) }),
    });
  });
}

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const puts = (w: World) => w.calls.filter((c) => c.startsWith('PUT '));
const region = (page: Page, name: string) => page.getByRole('region', { name });
const open = (page: Page, name: string) => page.getByRole('button', { name }).click();

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`@TASK-112 @TC-FLW-11 FLOW-11 manage provider keys at ${name} px`, () => {
    test.use({ viewport: { width, height }, timezoneId: 'UTC' });
    test.beforeEach(async ({ context, baseURL, page }) => {
      await signedIn(context, baseURL!);
      await page.clock.setFixedTime(NOW);
    });

    const shot = async (page: Page, label: string) => {
      await page.evaluate(() => document.fonts.ready);
      await expectNoAxeViolations(page, `${evidence}/axe/${label}-${name}.json`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      // The fixed bottom navigation of the phone layout would sit over the content: size the viewport to the page for the picture.
      const full = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width, height: Math.max(height, full) });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `${evidence}/screenshots/${label}-${name}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width, height });
    };
    const field = (page: Page, label: string, value: string) => page.getByLabel(label).fill(value);

    test('the whole journey: add both keys, a failed test keeps the old key, replace under a running job, delete, rate limit, step-up', async ({
      page,
    }) => {
      const w = new World();
      await api(page, w);

      // 1. Nothing configured: both keys are asked for, and the trail is empty.
      await page.goto(PATH);
      await expect(page.getByRole('heading', { level: 1, name: 'Provider keys' })).toBeVisible();
      await expect(page.getByText('Add both keys to create ads')).toBeVisible();
      await expect(page.getByText('No key activity yet.')).toBeVisible();
      await shot(page, '1-empty');

      // 2. Cancel path: closing the add dialog sends nothing.
      await open(page, 'Add OpenAI key');
      await expect(page.getByRole('dialog', { name: 'Add OpenAI key' })).toBeVisible();
      await field(page, 'OpenAI API key', KEY);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
      expect(puts(w)).toEqual([]);

      // 3. Error path: a key the provider refuses is not stored, the field says so, and the trail records the failed test.
      w.plan.openai = ['key_invalid'];
      await open(page, 'Add OpenAI key');
      await field(page, 'OpenAI API key', BAD);
      await page.getByRole('button', { name: 'Test and save' }).click();
      await expect(page.getByText(/did not accept this key/)).toBeVisible();
      await expect(page.getByLabel('OpenAI API key')).toHaveValue('');
      await shot(page, '2-add-key-refused');
      expect(w.keys.openai.configured).toBe(false);

      // 4. A valid key is tested, stored and shown by hint and fingerprint only.
      await field(page, 'OpenAI API key', KEY);
      await page.getByRole('button', { name: 'Test and save' }).click();
      await expect(page.getByText('OpenAI key saved', { exact: true })).toBeVisible();
      await expect(page.getByText(/It ends in …wxyz/)).toBeVisible();
      await expect(page.locator('body')).not.toContainText(KEY);
      await expect(page.getByText('OpenAI key added')).toBeVisible();
      await shot(page, '3-openai-saved');

      // 5. Step-up: the api wants a recent sign-in; the confirm dialog shows, Escape sends nothing again, the retry then succeeds.
      w.plan.wavespeed = ['step_up'];
      await open(page, 'Add WaveSpeed key');
      await field(page, 'WaveSpeed API key', KEY);
      await page.getByRole('button', { name: 'Test and save' }).click();
      const step = page.getByRole('dialog', { name: 'Confirm it is you' });
      await expect(step).toContainText('For your security, confirm it is you again to continue.');
      await shot(page, '4-step-up');
      await page.keyboard.press('Escape');
      await expect(step).toBeHidden();
      expect(puts(w)).toHaveLength(3);
      expect(w.keys.wavespeed.configured).toBe(false);
      await open(page, 'Add WaveSpeed key');
      await field(page, 'WaveSpeed API key', KEY);
      await page.getByRole('button', { name: 'Test and save' }).click();
      await expect(page.getByText('WaveSpeed key saved', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Add both keys to create ads' })).toHaveCount(
        0,
      );
      await shot(page, '5-both-keys');

      // 6. Replace under a running job: the warning comes first, a failed test keeps the old key, a good one replaces it, the job fails cleanly.
      w.startJob('openai');
      await page.reload();
      await expect(region(page, 'OpenAI')).toBeVisible();
      await region(page, 'OpenAI').getByRole('button', { name: 'Replace key' }).click();
      await expect(page.getByText(/1 job is running on the current key/)).toBeVisible();
      await expect(page.getByText(/will fail with "key replaced during the job"/)).toBeVisible();
      await shot(page, '6-replace-warning');
      w.plan.openai = ['key_invalid'];
      await field(page, 'New OpenAI API key', BAD);
      await page.getByRole('button', { name: 'Test and replace' }).click();
      await expect(page.getByText(/did not accept this key/)).toBeVisible();
      expect(w.keys.openai.last4).toBe('wxyz');
      expect(w.keys.openai.version).toBe(1);
      expect(w.jobs[0]!.state).toBe('running');
      await shot(page, '7-replace-refused-old-key-kept');
      await field(page, 'New OpenAI API key', NEW);
      await page.getByRole('button', { name: 'Test and replace' }).click();
      await expect(page.getByText(/It ends in …1234/)).toBeVisible();
      expect(w.keys.openai.version).toBe(2);
      expect(w.jobs[0]).toMatchObject({ state: 'failed', cause: 'key replaced during the job' });
      await expect(page.getByText('OpenAI key replaced')).toBeVisible();
      await shot(page, '8-replaced');

      // 7. Delete: Back-out first (nothing sent), then the confirmation states the backup retention.
      await open(page, 'Delete WaveSpeed key');
      await page.getByRole('button', { name: 'Cancel' }).click();
      expect(w.calls.filter((c) => c.startsWith('DELETE '))).toEqual([]);
      await open(page, 'Delete WaveSpeed key');
      const dialog = page.getByRole('dialog', { name: 'Delete WaveSpeed key?' });
      await expect(dialog).toContainText('Backups age out within 30 days.');
      await shot(page, '9-delete-confirm');
      await dialog.getByRole('button', { name: 'Delete key' }).click();
      await expect(page.getByText('WaveSpeed key deleted.')).toBeVisible();
      await expect(page.getByText('WaveSpeed key deleted', { exact: true })).toBeVisible();
      expect(w.keys.wavespeed.configured).toBe(false);
      await shot(page, '10-wavespeed-deleted');

      // 8. Attempt limit: too many attempts shows the wait, and nothing is stored.
      w.plan.wavespeed = ['rate_limited'];
      await open(page, 'Add WaveSpeed key');
      await field(page, 'WaveSpeed API key', KEY);
      await page.getByRole('button', { name: 'Test and save' }).click();
      await expect(page.getByText('Too many attempts. Try again in 7 minutes.')).toBeVisible();
      expect(w.keys.wavespeed.configured).toBe(false);
      await shot(page, '11-rate-limited');
      await page.getByRole('button', { name: 'Cancel' }).click();

      // The trail records the refusals. (Finding for TASK-098, Low: a refused save does not refetch the trail, so the
      // refusal shows after the next load, not at once; a saved or deleted key refreshes it immediately.)
      await page.reload();
      await expect(page.getByText('Too many WaveSpeed key attempts')).toBeVisible();
      await expect(page.getByText('OpenAI key test failed (authentication)').first()).toBeVisible();
      await shot(page, '12-key-trail');

      // The trail never carries a key value.
      await expect(page.locator('body')).not.toContainText(/sk-proj/);
      expect(w.sent).toEqual([BAD, KEY, KEY, KEY, BAD, NEW, KEY]);
      const shape = new Set(w.calls);
      for (const call of [
        'GET /me',
        'GET /me/provider-keys',
        'GET /me/key-events',
        'PUT /me/provider-keys/openai',
        'PUT /me/provider-keys/wavespeed',
        'DELETE /me/provider-keys/wavespeed',
      ])
        expect(shape).toContain(call);
    });

    test('repeated refusals disable the key: the notice stays until it is replaced, and the replacement clears it', async ({
      page,
    }) => {
      const w = new World({ openai: { last4: '7Q2d' }, wavespeed: { last4: '9fK2' } });
      await api(page, w);
      await page.goto(PATH);
      await expect(region(page, 'WaveSpeed')).toBeVisible();
      await expect(page.getByText('Your WaveSpeed key was disabled')).toHaveCount(0);
      w.refuse('wavespeed');
      await page.reload();
      await expect(page.getByText('Your WaveSpeed key was disabled')).toBeVisible();
      await expect(page.getByText('It failed authentication 5 times in a row.')).toBeVisible();
      await expect(page.getByText('WaveSpeed key disabled after repeated refusals')).toBeVisible();
      await shot(page, '13-key-disabled');
      await page.reload();
      await expect(page.getByText('Your WaveSpeed key was disabled')).toBeVisible();
      await region(page, 'WaveSpeed').getByRole('button', { name: 'Replace key' }).click();
      await field(page, 'New WaveSpeed API key', NEW);
      await page.getByRole('button', { name: 'Test and replace' }).click();
      await expect(page.getByText('WaveSpeed key saved', { exact: true })).toBeVisible();
      await expect(page.getByText('Your WaveSpeed key was disabled')).toHaveCount(0);
      await shot(page, '14-disabled-replaced');
    });

    test('a key stored without a test says the first job will check it', async ({ page }) => {
      const w = new World({ openai: { last4: '7Q2d' } });
      w.plan.wavespeed = ['unknown'];
      await api(page, w);
      await page.goto(PATH);
      await open(page, 'Add WaveSpeed key');
      await field(page, 'WaveSpeed API key', KEY);
      await page.getByRole('button', { name: 'Test and save' }).click();
      await expect(page.getByText('WaveSpeed key saved', { exact: true })).toBeVisible();
      await expect(page.getByText(/could not be tested without a charge/).first()).toBeVisible();
      await expect(page.getByText('WaveSpeed key stored without a test')).toBeVisible();
      await shot(page, '15-stored-untested');
    });

    test('session expiry: a 401 on saving stores nothing and says the session ended', async ({
      page,
    }) => {
      const w = new World({ openai: { last4: '7Q2d' } });
      w.plan.wavespeed = ['unauthenticated'];
      await api(page, w);
      await page.goto(PATH);
      await open(page, 'Add WaveSpeed key');
      await field(page, 'WaveSpeed API key', KEY);
      await page.getByRole('button', { name: 'Test and save' }).click();
      // MISMATCH (returned to TASK-098): the error registry marks `unauthenticated` as a redirect to sign-in with the
      // return path, but SCREEN-010's save only shows the message in the dialog, with no Sign-in action. No false success.
      await expect(
        page
          .getByRole('dialog', { name: 'Add WaveSpeed key' })
          .getByText('Your session ended. Sign in to continue.'),
      ).toBeVisible();
      await expect(page.getByText('WaveSpeed key saved', { exact: true })).toHaveCount(0);
      expect(w.keys.wavespeed.configured).toBe(false);
      await shot(page, '16-session-expired');
    });

    test('step-up: Confirm sends the user to sign in again and brings them back to this screen', async ({
      page,
    }) => {
      const w = new World({ openai: { last4: '7Q2d' } });
      w.plan.wavespeed = ['step_up'];
      await api(page, w);
      await page.goto(PATH);
      await open(page, 'Add WaveSpeed key');
      await field(page, 'WaveSpeed API key', KEY);
      await page.getByRole('button', { name: 'Test and save' }).click();
      await page
        .getByRole('dialog', { name: 'Confirm it is you' })
        .getByRole('button', { name: /^(Confirm|Continue|Sign in)/ })
        .click();
      await page.waitForURL('**/sign-in**');
      expect(new URL(page.url()).searchParams.get('return')).toBe(PATH);
    });

    test('permission path: a key list the api refuses shows no key cards and no key action', async ({
      page,
    }) => {
      const w = new World();
      await api(page, w, { listError: failure(403, 'forbidden') });
      await page.goto(PATH);
      await expect(page.getByRole('alert').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Add|Replace|Delete) .*key/ })).toHaveCount(
        0,
      );
      await shot(page, '17-keys-forbidden');
    });

    test('back path: Back from the key screen returns to the screen the user came from', async ({
      page,
    }) => {
      const w = new World({ openai: { last4: '7Q2d' }, wavespeed: { last4: '9fK2' } });
      await api(page, w);
      await page.goto('/campaigns');
      await page.goto(PATH);
      await expect(page.getByRole('heading', { level: 1, name: 'Provider keys' })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/campaigns$/);
    });

    test('session expiry at the door: the running api answers 401 without a bearer; sign-in carries the return path and no key is shown', async ({
      page,
    }) => {
      const w = new World();
      await api(page, w, { real: true });
      await page.goto(PATH);
      await page.waitForURL('**/sign-in**');
      expect(new URL(page.url()).searchParams.get('return')).toBe(PATH);
      expect(w.calls).toContain('GET /me/provider-keys');
      await expect(page.getByTestId('key-hint')).toHaveCount(0);
    });
  });
}

test.describe('@TASK-112 @TC-FLW-11 FLOW-11 keyboard only', () => {
  test.use({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  test.beforeEach(async ({ context, baseURL, page }) => {
    await signedIn(context, baseURL!);
    await page.clock.setFixedTime(NOW);
  });

  test('add, replace and delete a key, and leave a dialog, every step by keys', async ({
    page,
  }) => {
    const w = new World({ openai: { last4: '7Q2d' } });
    await api(page, w);
    await page.goto(PATH);
    await expect(page.getByRole('heading', { level: 1, name: 'Provider keys' })).toBeVisible();

    // Add: Enter opens the dialog with the field focused, type, Enter submits.
    await page.getByRole('button', { name: 'Add WaveSpeed key' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('WaveSpeed API key')).toBeFocused();
    await page.keyboard.type(KEY);
    await page.keyboard.press('Enter');
    await expect(page.getByText('WaveSpeed key saved', { exact: true })).toBeVisible();

    // Replace: Escape leaves without sending, then the key is replaced by keys alone.
    await region(page, 'OpenAI').getByRole('button', { name: 'Replace key' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('New OpenAI API key')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(puts(w)).toHaveLength(1);
    await region(page, 'OpenAI').getByRole('button', { name: 'Replace key' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type(NEW);
    await page.keyboard.press('Enter');
    await expect(page.getByText(/It ends in …1234/)).toBeVisible();

    // Delete: Tab moves to the destructive confirm, Enter confirms.
    await page.getByRole('button', { name: 'Delete WaveSpeed key' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Delete WaveSpeed key?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete key' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('WaveSpeed key deleted.')).toBeVisible();
    expect(w.keys.wavespeed.configured).toBe(false);
    await expectNoAxeViolations(page);
  });
});
