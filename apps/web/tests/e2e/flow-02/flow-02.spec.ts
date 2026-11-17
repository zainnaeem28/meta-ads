import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';
import {
  CAMPAIGN_ID,
  briefFixture,
  campaignFixture,
  generatingBrief,
  highRisk,
  meta,
  otherIssue,
  segment,
} from '../../../src/features/fe-screen-007b/fixtures';
import { emptyList } from '../../../src/features/fe-screen-008/fixtures';
import type { Brief } from '@shroomap/contracts';

// TC-FLW-02 (FLOW-02, J-02): SCREEN-006 step 4 to SCREEN-007 (fix a high-risk flag by editing, clear an other-class flag
// with a reason, accept, copy prompts) to SCREEN-008, through the built web app (`next start`) and the built api.
// The signed-in api answers are a labelled contract mock (API-024, 041, 050, 051, 052, 054, 062 shapes, taken from the
// screens' own contract fixtures): the built web sends no bearer without an identity provider and the api's local
// identity mints tokens only in-process, so no operator token exists out of process, and the worker, FFmpeg and provider
// stubs are not reachable through an unauthenticated api. The 401 steps are the real api. No mock answer is invented.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-105';
const DRAFT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEDIA_ID = '8f3a0000-0000-4000-8000-00000000e001';
const BRIEF_URL = `/campaigns/${CAMPAIGN_ID}/brief`;
const CLIPS_URL = `/campaigns/${CAMPAIGN_ID}/clips`;
const WIZARD_URL = `/campaigns/new?draft=${DRAFT_ID}`;
const T = '2026-11-16T09:00:00Z';
const FIXED = 'A calm and steady routine helps me start each day on my own terms, with coffee and quiet light, before the run begins.';

const draft = (over: Record<string, unknown> = {}) => ({
  id: DRAFT_ID, version: 2, step: 4, adStyle: 'ugc', intakeMode: 'description',
  productName: 'Morning Focus Blend',
  productDescription: "Lion's Mane and Cordyceps capsules for a steady start to the day. 60 capsules, vegan, third-party tested.",
  audience: { ageMin: 35, ageMax: 52, gender: 'all', interests: ['morning routines', 'nootropics', 'trail running'] },
  direction: { goal: 'conversion', tone: 'Calm and grounded', segmentCount: 3 },
  concept: 'A calm morning routine: she takes the capsules with breakfast, then heads out for a trail run.',
  script: null, productMediaId: MEDIA_ID, campaignId: null, durationSeconds: 45, createdAt: T, updatedAt: T, ...over,
});

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
const ok = (data: unknown, status = 200, version?: number): Answer => ({
  status,
  headers: { etag: `"v${String(version ?? (data as { version?: number }).version ?? 1)}"` },
  body: { success: true, data, metaData: meta },
});
const failure = (status: number, code: string): Answer => ({
  status, body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});
const keyRows = (openai: boolean) =>
  ['openai', 'wavespeed'].map((provider) => ({
    provider, configured: provider === 'wavespeed' || openai, status: provider === 'openai' && !openai ? null : 'active',
    last4: null, fingerprint: null, version: 1, createdAt: null, updatedAt: null, lastValidatedAt: null, inFlightJobCount: 0,
  }));

/** The api as the journey sees it: one stateful brief, so each answer follows from the calls before it. */
interface World {
  brief: Brief;
  openaiKey: boolean;
  /** Brief reads answered `generating` before the first finished one (the worker is running). */
  generatingReads: number;
  submit: 'ok' | 'key_missing';
  accept: 'ok' | 'unauthenticated';
  regenerateTo: Brief;
  /** The campaign belongs to someone else: every read of it is a 404. */
  unavailable: boolean;
  calls: string[];
}
const world = (over: Partial<World> = {}): World => ({
  brief: briefFixture(), openaiKey: true, generatingReads: 2, submit: 'ok', accept: 'ok', regenerateTo: briefFixture(), unavailable: false, calls: [], ...over,
});

const bump = (w: World, over: Partial<Brief>) => (w.brief = { ...w.brief, ...over, version: w.brief.version + 1, updatedAt: T });

function answer(w: World, method: string, path: string, body: unknown): Answer | 'real' {
  const brief = `/campaigns/${CAMPAIGN_ID}/brief`;
  if (w.unavailable && path.startsWith('/campaigns/')) return failure(404, 'not_found');
  if (method === 'GET' && path === '/me/provider-keys') return ok(keyRows(w.openaiKey));
  if (method === 'GET' && path === '/me') return ok({ linkState: 'linked', id: '8f3a0000-0000-4000-8000-00000000c21d', role: 'user', status: 'active', mfa: { required: true, satisfied: true }, recentAuth: { satisfied: true, maxAgeSeconds: 600 }, keyNotices: [] });
  if (method === 'GET' && path === '/me/key-events') return { status: 200, body: { success: true, data: [], metaData: { ...meta, pagination: { type: 'cursor', limit: 20, returnedCount: 0, hasNextPage: false, nextCursor: null } } } };
  if (method === 'GET' && path === `/drafts/${DRAFT_ID}`) return ok(draft());
  if (method === 'PATCH' && path === `/drafts/${DRAFT_ID}`) return ok(draft({ version: 3 }));
  if (method === 'POST' && path === `/drafts/${DRAFT_ID}/submit`) {
    if (w.submit === 'key_missing') return failure(422, 'key_missing');
    return ok({ campaignId: CAMPAIGN_ID, briefJob: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'pending', label: 'brief_generation', causeClass: null, causeMessage: null, createdAt: T, updatedAt: T, reused: false } }, 202);
  }
  if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}`) return ok(campaignFixture({ briefState: w.brief.state }));
  if (method === 'GET' && path === brief) {
    if (w.generatingReads > 0) {
      w.generatingReads -= 1;
      return ok(generatingBrief());
    }
    return ok(w.brief);
  }
  if (method === 'PATCH' && path === brief) {
    const edits = (body as { segments: { position: number; dialogue: string }[] }).segments;
    const segments = w.brief.segments.map((s) => {
      const edit = edits.find((e) => e.position === s.position);
      return edit ? { ...s, dialogue: edit.dialogue, revision: s.revision + 1 } : s;
    });
    // The brand checks run again on the saved text: an edit that removes the wording closes the high-risk flag.
    const issues = w.brief.issues.filter((i) => !(i.id === highRisk.id && segments[1]!.dialogue === FIXED));
    return ok(bump(w, { segments, issues }));
  }
  if (method === 'POST' && path === `/claim-issues/${otherIssue.id}/clear`) {
    bump(w, { issues: w.brief.issues.filter((i) => i.id !== otherIssue.id) });
    return ok({ ...otherIssue, resolution: 'cleared', clearReason: (body as { reason: string }).reason });
  }
  if (method === 'POST' && path === `${brief}/accept`) {
    if (w.accept === 'unauthenticated') return failure(401, 'unauthenticated');
    return ok(bump(w, { state: 'accepted', acceptedAt: T }));
  }
  if (method === 'POST' && path === `${brief}/regenerate`) {
    const job = generatingBrief().generationJob;
    w.brief = { ...w.regenerateTo, version: w.brief.version + 1 };
    w.generatingReads = 1;
    return ok({ briefState: 'generating', job }, 202, w.brief.version);
  }
  if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/video-jobs`) return ok(emptyList());
  return failure(404, 'not_found');
}

const signedIn = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([{
    name: LOCAL_SESSION_COOKIE,
    value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp: Math.floor(Date.now() / 1000) + 600 }),
    url: baseURL,
  }]);

/** Relays the browser's api calls with CORS headers and answers each from `w`, or from the running api when `real`. */
async function api(page: Page, w: World, real = false) {
  const origin = process.env.E2E_API_URL!;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*', 'access-control-allow-methods': '*' } });
    }
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    w.calls.push(`${request.method()} ${path}`);
    const a = real ? 'real' : answer(w, request.method(), path, request.method() === 'GET' ? null : request.postDataJSON());
    if (a === 'real') {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    }
    return route.fulfill({ status: a.status, headers: { ...cors, ...(a.headers ?? {}) }, contentType: 'application/json', body: JSON.stringify(a.body) });
  });
}

const VIEWPORTS = [{ name: '390', width: 390, height: 844 }, { name: '1440', width: 1440, height: 900 }] as const;
const shape = (calls: string[]) => [...new Set(calls.map((c) => c.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')))];

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`@TASK-105 @TC-FLW-02 FLOW-02 brief generation, edit, accept at ${name} px`, () => {
    test.use({ viewport: { width, height } });
    test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

    const shot = async (page: Page, label: string) => {
      await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await Promise.all(['400', '500', '600', '700'].map((x) => document.fonts.load(`${x} 16px Inter`)));
        await document.fonts.ready;
      });
      await expectNoAxeViolations(page, `${evidence}/axe/${label}-${name}.json`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      // The fixed bottom navigation of the phone layout would hide content in a full-page capture; it is hidden for the picture only.
      const hide = await page.addStyleTag({ content: '.fixed { visibility: hidden !important; }' });
      await page.screenshot({ path: `${evidence}/screenshots/${label}-${name}.png`, fullPage: true });
      await hide.evaluate((el) => el.remove());
    };
    const reviewed = (page: Page) => expect(page.getByRole('heading', { name: '2 issues to resolve' })).toBeVisible({ timeout: 20_000 });
    const accepted = (page: Page) => expect(page.getByRole('heading', { name: 'Brief accepted · all checks closed' })).toBeVisible();

    test('the whole journey: generate from step 4, fix the high-risk flag, clear the other flag with a reason, accept, copy prompts, continue to clips', async ({ page, context, baseURL }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
      const w = world();
      await api(page, w);

      // 1. SCREEN-006 step 4: the concept is shown and Generate brief submits the draft.
      await page.goto(WIZARD_URL);
      await expect(page.getByRole('heading', { level: 2, name: 'Concept and script' })).toBeVisible();
      await shot(page, '1-wizard-step-4');
      await page.getByRole('button', { name: 'Generate brief' }).click();

      // 2. SCREEN-007 while the worker generates (Campaign ID carried in the URL), then the draft with its flags.
      await page.waitForURL(`**${BRIEF_URL}`);
      await expect(page.getByText('Generating your brief')).toBeVisible();
      await shot(page, '2-brief-generating');
      await reviewed(page);
      await shot(page, '3-brief-with-issues');

      // 3. An open high-risk issue blocks acceptance and cannot be cleared with a reason.
      await expect(page.getByRole('button', { name: 'Clear with reason, segment 2' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Accept brief' }).click({ force: true });
      await expect(page.getByText('The brief cannot be accepted yet')).toBeVisible();
      await expect(page.getByText(/including 1 that must be fixed by editing the text/).first()).toBeVisible();
      await shot(page, '4-accept-blocked');
      expect(w.calls.filter((c) => c.endsWith('/brief/accept'))).toEqual([]);

      // 4. Fix the high-risk flag by editing the segment text, then save: the checks run again.
      await page.getByRole('link', { name: 'Edit segment 2' }).click();
      const box = page.getByRole('textbox', { name: 'Segment 2 dialogue' });
      await expect(box).toBeFocused();
      await box.fill(FIXED);
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Changes saved. Brand checks ran again.')).toBeVisible();
      await expect(page.getByRole('heading', { name: '1 issue to resolve' })).toBeVisible();
      await shot(page, '5-high-risk-fixed');

      // 5. Clear the other-class flag with a reason (the cancel path first: nothing is sent).
      await page.getByRole('button', { name: 'Clear with reason, segment 1' }).click();
      await page.getByRole('button', { name: 'Cancel' }).click();
      expect(w.calls.filter((c) => c.includes('/claim-issues/'))).toEqual([]);
      await page.getByRole('button', { name: 'Clear with reason, segment 1' }).click();
      await page.getByRole('textbox', { name: /Reason for clearing/ }).fill('The brand approver agreed in review.');
      await shot(page, '6-clear-reason');
      await page.getByRole('button', { name: 'Clear issue', exact: true }).click();
      await expect(page.getByText('Issue cleared. Your reason is recorded.')).toBeVisible();

      // 6. Accept: the prompts become available.
      await page.getByRole('button', { name: 'Accept brief' }).click();
      await accepted(page);
      await expect(page.getByRole('button', { name: 'Copy segment prompts' })).toBeEnabled();
      await shot(page, '7-brief-accepted');
      await page.getByRole('button', { name: 'Copy segment prompts' }).click();
      await expect(page.getByText('Segment prompts copied.')).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain('Segment 1 · 0:00 to 0:15\n' + segment(1).prompt);
      expect(copied).toContain('Segment 3 · 0:30 to 0:45\n' + segment(3).prompt);

      // 7. SCREEN-008 with the same Campaign ID; Back returns to the accepted brief, not to a half-built state.
      await page.getByRole('link', { name: /Continue to clips/ }).click();
      await page.waitForURL(`**${CLIPS_URL}`);
      await expect(page.getByRole('button', { name: 'Generate segment 1' })).toBeEnabled();
      await shot(page, '8-clips');
      await page.goBack();
      await accepted(page);

      const sent = shape(w.calls);
      for (const call of ['PATCH /drafts/:id', 'POST /drafts/:id/submit', 'GET /campaigns/:id/brief', 'PATCH /campaigns/:id/brief', 'POST /claim-issues/:id/clear', 'POST /campaigns/:id/brief/accept', 'GET /campaigns/:id/video-jobs']) {
        expect(sent).toContain(call);
      }
      expect(w.calls.indexOf(`POST /campaigns/${CAMPAIGN_ID}/brief/accept`)).toBeGreaterThan(w.calls.indexOf(`PATCH /campaigns/${CAMPAIGN_ID}/brief`));
    });

    test('failed generation shows the cause and Try again; the retry generates the brief', async ({ page }) => {
      const failed = briefFixture({
        state: 'failed', segments: [], issues: [],
        generationJob: { ...generatingBrief().generationJob!, state: 'failed', label: 'failed', causeClass: 'credit', causeMessage: 'Your OpenAI account reported that it is out of credit. Nothing was charged. Add credit at OpenAI, then try again. Your answers are saved.' },
      });
      const w = world({ brief: failed, generatingReads: 0 });
      await api(page, w);
      await page.goto(BRIEF_URL);
      await expect(page.getByRole('heading', { name: 'The brief could not be generated' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Edit answers' })).toHaveAttribute('href', WIZARD_URL);
      await expect(page.getByRole('button', { name: 'Accept brief' })).toHaveCount(0);
      await shot(page, '9-failed-generation');
      w.regenerateTo = briefFixture();
      await page.getByRole('button', { name: 'Try again' }).click();
      await reviewed(page);
      expect(w.calls).toContain(`POST /campaigns/${CAMPAIGN_ID}/brief/regenerate`);
      await shot(page, '10-retry-generated');
    });

    test('a missing OpenAI key goes to the key screen: from step 4 on Generate, and from the brief on Regenerate', async ({ page }) => {
      const w = world({ submit: 'key_missing', openaiKey: false });
      await api(page, w);
      await page.goto(WIZARD_URL);
      await page.getByRole('button', { name: 'Generate brief' }).click();
      await expect(page.getByText('Add your OpenAI key to generate the brief')).toBeVisible();
      await expect(page).toHaveURL(/\/campaigns\/new/);
      await shot(page, '11-key-missing-step-4');
      await page.getByRole('link', { name: 'Add OpenAI key' }).click();
      await page.waitForURL('**/settings/provider-keys');
      await expect(page.getByRole('heading', { level: 1, name: 'Provider keys' })).toBeVisible();
      await shot(page, '12-key-screen');

      w.generatingReads = 0;
      await page.goto(BRIEF_URL);
      await expect(page.getByText('Regenerating needs your OpenAI key')).toBeVisible();
      // The brief stays editable without the key.
      await expect(page.getByRole('textbox', { name: 'Segment 1 dialogue' })).toBeEditable();
      await shot(page, '13-key-missing-brief');
      await page.getByRole('link', { name: 'Add OpenAI key' }).click();
      await page.waitForURL('**/settings/provider-keys');
      expect(w.calls.filter((c) => c.endsWith('/submit'))).toHaveLength(1);
    });

    test('cancel paths: Keep this brief on the regenerate confirm sends nothing and the edits stay', async ({ page }) => {
      const w = world({ generatingReads: 0 });
      await api(page, w);
      await page.goto(BRIEF_URL);
      await reviewed(page);
      await page.getByRole('textbox', { name: 'Segment 3 dialogue' }).fill('Short unsaved text.');
      await page.getByRole('button', { name: 'Regenerate brief' }).click();
      await expect(page.getByRole('dialog', { name: 'Regenerate this brief?' })).toBeVisible();
      await page.getByRole('button', { name: 'Keep this brief' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(page.getByRole('textbox', { name: 'Segment 3 dialogue' })).toHaveValue('Short unsaved text.');
      expect(w.calls.filter((c) => c.endsWith('/regenerate'))).toEqual([]);
      // Unsaved text is not accepted: accepting is blocked with the reason.
      await page.getByRole('button', { name: 'Accept brief' }).click({ force: true });
      await expect(page.getByText('The brief cannot be accepted yet')).toBeVisible();
    });

    test('session expiry in the journey: the api answers 401 on Accept, the visitor goes to sign-in with this brief as the return path and nothing is accepted', async ({ page }) => {
      const w = world({ generatingReads: 0, brief: briefFixture({ issues: [] }), accept: 'unauthenticated' });
      await api(page, w);
      await page.goto(BRIEF_URL);
      await page.getByRole('button', { name: 'Accept brief' }).click();
      await page.waitForURL('**/sign-in**');
      const url = new URL(page.url());
      expect(url.searchParams.get('return')).toBe(BRIEF_URL);
      expect(url.searchParams.get('reason')).toBe('session-expired');
      await expect(page.getByText('Brief accepted')).toHaveCount(0);
      await shot(page, '14-session-expired-on-accept');
    });

    test('permission path: a campaign that is not the operator\'s is answered 404 and no brief is shown', async ({ page }) => {
      const w = world({ generatingReads: 0, unavailable: true });
      await api(page, w);
      await page.goto(BRIEF_URL);
      await expect(page.getByRole('heading', { name: '2 issues to resolve' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Accept brief' })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: /Segment 1 dialogue/ })).toHaveCount(0);
      await shot(page, '15-campaign-unavailable');
    });

    test('session expiry at the door: the running api answers 401 without a bearer; sign-in carries the return path, no brief is shown', async ({ page }) => {
      const w = world();
      await api(page, w, true);
      await page.goto(BRIEF_URL);
      await page.waitForURL('**/sign-in**');
      expect(new URL(page.url()).searchParams.get('return')).toBe(BRIEF_URL);
      expect(w.calls).toContain(`GET /campaigns/${CAMPAIGN_ID}/brief`);
      await expect(page.getByText('Segment 1')).toHaveCount(0);
      await shot(page, '16-session-expired-sign-in');
    });
  });
}

test.describe('@TASK-105 @TC-FLW-02 FLOW-02 keyboard only', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

  test('Generate, edit, Save, clear with a reason, Accept and Continue to clips, every step by keys', async ({ page }) => {
    const w = world();
    await api(page, w);
    await page.goto(WIZARD_URL);
    await expect(page.getByRole('heading', { level: 2, name: 'Concept and script' })).toBeVisible();
    await page.getByRole('button', { name: 'Generate brief' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(`**${BRIEF_URL}`);
    await expect(page.getByRole('heading', { name: '2 issues to resolve' })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('link', { name: 'Edit segment 2' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Segment 2 dialogue' })).toBeFocused();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(FIXED);
    await page.getByRole('button', { name: 'Save changes' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Changes saved. Brand checks ran again.')).toBeVisible();

    await page.getByRole('button', { name: 'Clear with reason, segment 1' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: /Reason for clearing/ })).toBeFocused();
    await page.keyboard.type('The brand approver agreed in review.');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Clear issue', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Issue cleared. Your reason is recorded.')).toBeVisible();

    await page.getByRole('button', { name: 'Accept brief' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Brief accepted · all checks closed' })).toBeVisible();
    const next = page.getByRole('link', { name: /Continue to clips/ });
    await next.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(`**${CLIPS_URL}`);
    await expect(page.getByRole('button', { name: 'Generate segment 1' })).toBeEnabled();
  });
});
