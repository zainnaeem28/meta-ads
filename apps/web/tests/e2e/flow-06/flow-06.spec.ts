import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { CampaignSummary, Draft } from '@shroomap/contracts';
import { expectNoAxeViolations } from '../../support/axe';
import { VIEWPORTS } from '../../support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';
import { CAMPAIGN_ID, briefFixture, campaignFixture, meta } from '../../../src/features/fe-screen-007a/fixtures';
import { emptyList } from '../../../src/features/fe-screen-008/fixtures';
import { ASSEMBLY_ID, assemblyFixture, passedList } from '../../../src/features/fe-screen-009a/fixtures';

// TC-FLW-06 (FLOW-06, J-05): SCREEN-005 (search, filter, paging, drafts) to SCREEN-007, 008 or 009 and back, and resume a
// draft, through the built web app (`next start`) and the built api. The signed-in api answers are a labelled contract
// mock (API-040, 020, 042, 025, 024, 050, 051 shapes from the screens' own contract fixtures): the built web sends no
// bearer without an identity provider and the api's local identity mints tokens only in-process, so no operator token
// exists out of process. The 401 steps are the real api. No mock answer is invented; the list honours q, filter and cursor.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-109';
const SIZES = VIEWPORTS.filter((v) => v.name !== '768');
const T = '2026-11-16T09:00:00Z';
const id = (n: number) => `00000000-0000-4000-8000-0000000c${String(n).padStart(4, '0')}`;
const FINAL_ID = id(2);
const BRIEF_ID = id(3);
const GONE_ID = id(5);
const DRAFT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_DRAFT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEDIA_ID = '8f3a0000-0000-4000-8000-00000000e001';

const summary = (n: number): CampaignSummary => {
  const base = {
    id: id(n), productName: `Mushroom Blend ${n}`, productDescriptionExcerpt: `Blend number ${n}.`, progress: n % 2 ? 'completed' : 'in_progress',
    briefState: 'accepted', segmentCount: 3, finalAvailable: false, createdAt: T,
    updatedAt: new Date(Date.parse('2026-11-16T09:00:00Z') - n * 3_600_000).toISOString(),
  } as CampaignSummary;
  if (n === 1) return { ...base, id: CAMPAIGN_ID, productName: 'Evening Calm Gummies', progress: 'in_progress' };
  if (n === 2) return { ...base, productName: 'Calm Focus Tea', progress: 'completed', finalAvailable: true };
  if (n === 3) return { ...base, productName: 'Serum Brief Ready', briefState: 'draft', progress: 'in_progress' };
  if (n === 4) return { ...base, productName: 'Capsule Launch', progress: 'failed' };
  if (n === 5) return { ...base, productName: 'Vanished Tonic' };
  return base;
};
const ALL = Array.from({ length: 23 }, (_, i) => summary(i + 1));

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: DRAFT_ID, version: 2, step: 3, adStyle: 'ugc', intakeMode: 'description', productName: 'Morning Focus Blend',
  productDescription: "Lion's Mane and Cordyceps capsules for a steady start to the day. 60 capsules, vegan, third-party tested.",
  audience: { ageMin: 35, ageMax: 52, gender: 'all', interests: ['morning routines', 'nootropics', 'trail running'] },
  direction: { goal: 'conversion', tone: 'Calm and grounded', segmentCount: 3 },
  concept: null, script: null, productMediaId: MEDIA_ID, campaignId: null, durationSeconds: 45, createdAt: T, updatedAt: T, ...over,
});

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
const ok = (data: unknown, status = 200, version?: number): Answer => ({
  status, headers: { etag: `"v${String(version ?? (data as { version?: number }).version ?? 1)}"` }, body: { success: true, data, metaData: meta },
});
const failure = (status: number, code: string): Answer => ({
  status, body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});
const page = (rows: unknown[], limit: number, offset: number, total: number): Answer => ({
  status: 200,
  body: {
    success: true, data: rows,
    metaData: { ...meta, pagination: { type: 'cursor', limit, returnedCount: rows.length, hasNextPage: offset + rows.length < total, nextCursor: offset + rows.length < total ? `o${offset + rows.length}` : null } },
  },
});
const keyRows = () =>
  ['openai', 'wavespeed'].map((provider) => ({ provider, configured: true, status: 'active', last4: null, fingerprint: null, version: 1, createdAt: null, updatedAt: null, lastValidatedAt: null, inFlightJobCount: 0 }));

/** The api as the journey sees it: the account's campaigns and drafts, so each answer follows from the calls before it. */
interface World {
  campaigns: CampaignSummary[];
  drafts: Draft[];
  /** Failing history page reads left (500 internal_error); the screen retries a read three times before it shows the error. */
  listFailures: number;
  /** The signed-in session ended: every call answers 401. */
  ended: boolean;
  calls: string[];
}
const world = (over: Partial<World> = {}): World => ({
  campaigns: [...ALL], drafts: [draft(), draft({ id: OTHER_DRAFT_ID, productName: 'Evening Calm Gummies', step: 1, productDescription: null })],
  listFailures: 0, ended: false, calls: [], ...over,
});

const matches = (c: CampaignSummary, q: string | null, filter: string | null) =>
  (!q || `${c.productName}\n${c.productDescriptionExcerpt}`.toLowerCase().includes(q.toLowerCase())) &&
  (!filter || filter === 'all' || (filter === 'failed' ? c.progress === 'failed' : filter === 'completed' ? c.progress === 'completed' : c.progress === 'in_progress' || c.progress === 'processing'));

function answer(w: World, method: string, url: URL): Answer {
  const path = url.pathname.replace('/api/v1', '');
  if (w.ended) return failure(401, 'unauthenticated');
  if (method === 'GET' && path === '/me/provider-keys') return ok(keyRows());
  if (method === 'GET' && path === '/me') return ok({ linkState: 'linked', id: '8f3a0000-0000-4000-8000-00000000c21d', role: 'user', status: 'active', mfa: { required: true, satisfied: true }, recentAuth: { satisfied: true, maxAgeSeconds: 600 }, keyNotices: [] });
  if (method === 'GET' && path === '/me/key-events') return page([], 20, 0, 0);
  if (method === 'GET' && path === '/campaigns') {
    // Only the history page read fails; the chip counts (limit 50) answer, so the page shows the error alone.
    if (w.listFailures > 0 && url.searchParams.get('limit') === '10') {
      w.listFailures -= 1;
      return failure(500, 'internal_error');
    }
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const offset = Number((url.searchParams.get('cursor') ?? 'o0').slice(1));
    const rows = w.campaigns.filter((c) => matches(c, url.searchParams.get('q'), url.searchParams.get('filter')));
    return page(rows.slice(offset, offset + limit), limit, offset, rows.length);
  }
  if (method === 'GET' && path === '/drafts') return page(w.drafts, Number(url.searchParams.get('limit') ?? 20), 0, w.drafts.length);
  const draftId = /^\/drafts\/([^/]+)$/.exec(path)?.[1];
  if (draftId) {
    const found = w.drafts.find((d) => d.id === draftId);
    if (!found) return failure(404, 'not_found');
    if (method === 'GET') return ok(found);
    if (method === 'DELETE') {
      w.drafts = w.drafts.filter((d) => d.id !== draftId);
      return { status: 204 };
    }
  }
  const campaignId = /^\/campaigns\/([^/]+)/.exec(path)?.[1];
  if (campaignId) {
    const found = w.campaigns.find((c) => c.id === campaignId);
    // The campaign is gone or not this account's: the api answers a plain 404, never which of the two.
    if (!found || found.id === GONE_ID) return failure(404, 'not_found');
    const full = campaignFixture({ ...found, draftId: DRAFT_ID, latestAssemblyId: found.finalAvailable ? ASSEMBLY_ID : null });
    if (method === 'GET' && path === `/campaigns/${found.id}`) return ok(full);
    if (method === 'GET' && path === `/campaigns/${found.id}/brief`) return ok(briefFixture({ state: found.briefState === 'accepted' ? 'accepted' : 'draft', issues: [] }));
    if (method === 'GET' && path === `/campaigns/${found.id}/video-jobs`) return ok(found.finalAvailable ? passedList() : emptyList());
    if (method === 'DELETE' && path === `/campaigns/${found.id}`) {
      w.campaigns = w.campaigns.filter((c) => c.id !== found.id);
      return ok({ deletionRunId: id(900), status: 'accepted' }, 202);
    }
  }
  if (method === 'GET' && path === `/assemblies/${ASSEMBLY_ID}`) return ok(assemblyFixture('done'));
  return failure(404, 'not_found');
}

const signedIn = async (context: BrowserContext, baseURL: string, expiresIn = 600) =>
  context.addCookies([{ name: LOCAL_SESSION_COOKIE, value: await signLocalSession({ sub: 'user_local_e2e', email: 'e2e@example.com', exp: Math.floor(Date.now() / 1000) + expiresIn }), url: baseURL }]);

/** Relays the browser's api calls with CORS headers and answers each from `w`. */
async function api(p: Page, w: World) {
  const origin = process.env.E2E_API_URL!;
  await p.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '*', 'access-control-allow-methods': '*' } });
    }
    const url = new URL(request.url());
    w.calls.push(`${request.method()} ${url.pathname.replace('/api/v1', '')}${url.search}`);
    const a = answer(w, request.method(), url);
    return route.fulfill({ status: a.status, headers: { ...cors, ...(a.headers ?? {}) }, contentType: 'application/json', body: a.body === undefined ? undefined : JSON.stringify(a.body) });
  });
}

/** The step's screenshot at both design widths plus axe, taken on the page as it stands. */
async function capture(p: Page, step: string, project: string) {
  const original = p.viewportSize();
  for (const { name, width, height } of SIZES) {
    await p.setViewportSize({ width, height });
    await p.evaluate(async () => {
      window.scrollTo(0, 0);
      await Promise.all(['400', '500', '600', '700'].map((x) => document.fonts.load(`${x} 16px Inter`)));
      await document.fonts.ready;
    });
    await expectNoAxeViolations(p, `${evidence}/axe/${project}-${step}-${name}.json`);
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    // The fixed bottom navigation of the phone layout would hide content in a full-page capture; hidden for the picture only.
    const hide = await p.addStyleTag({ content: '.fixed { visibility: hidden !important; }' });
    await p.screenshot({ path: `${evidence}/screenshots/${step}-${name}.png`, fullPage: true });
    await hide.evaluate((el) => el.remove());
  }
  if (original) await p.setViewportSize(original);
}

const query = (p: Page) => new URL(p.url()).search;
const listed = (p: Page) => p.getByRole('list', { name: 'Campaign history' }).getByRole('listitem');
const settled = (p: Page) => expect(p.getByText('Loading campaigns')).toHaveCount(0, { timeout: 20_000 });

test.describe('@TASK-109 @TC-FLW-06 @FLOW-06 history, drafts and search end to end', () => {
  test.beforeEach(async ({ context, baseURL }) => signedIn(context, baseURL!));

  test('search, filter and page, open a campaign at its stage (SCREEN-008), Back returns with the query carried', async ({ page: p }, info) => {
    const w = world();
    await api(p, w);
    await p.goto('/campaigns');
    await expect(p.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
    await expect(listed(p)).toHaveCount(10);
    await capture(p, '1-history-list', info.project.name);

    // Paging: page 2 is in the URL and shows the next ten, none repeated from page 1.
    await p.getByRole('button', { name: 'Next' }).click();
    await expect.poll(() => query(p)).toBe('?page=2');
    await expect(p.getByRole('link', { name: /Mushroom Blend 11/ })).toBeVisible();
    await expect(p.getByRole('link', { name: /Evening Calm Gummies/ })).toHaveCount(0);
    await capture(p, '2-history-page-2', info.project.name);

    // Search: a new search returns to page 1 and lands in the URL.
    await p.getByRole('searchbox', { name: 'Search by product name or description' }).fill('calm');
    await expect.poll(() => query(p)).toBe('?q=calm');
    await expect(listed(p)).toHaveCount(2);
    await p.getByRole('button', { name: /^Completed/ }).click();
    await expect.poll(() => query(p)).toBe('?q=calm&status=completed');
    await expect(listed(p)).toHaveCount(1);
    await expect(p.getByRole('link', { name: /Calm Focus Tea/ })).toBeVisible();
    await expect(w.calls.some((c) => c.includes('q=calm') && c.includes('filter=completed'))).toBe(true);
    await capture(p, '3-search-and-filter', info.project.name);

    // Open a campaign whose clips are being made: SCREEN-008, carrying the campaign id.
    await p.getByRole('button', { name: /^All/ }).click();
    await p.getByRole('link', { name: /Evening Calm Gummies/ }).click();
    await p.waitForURL(`**/campaigns/${CAMPAIGN_ID}/clips`);
    await expect(p.getByRole('heading', { level: 1, name: 'Evening Calm Gummies' })).toBeVisible();
    await settled(p);
    await capture(p, '4-clips-from-history', info.project.name);

    // Back: the list returns with the same search and filter.
    await p.goBack();
    await p.waitForURL('**/campaigns?q=calm');
    await expect(p.getByRole('searchbox', { name: 'Search by product name or description' })).toHaveValue('calm');
    await expect(listed(p)).toHaveCount(2);
  });

  test('a completed campaign opens SCREEN-009 and a brief awaiting review opens SCREEN-007; the breadcrumb returns to the list', async ({ page: p }, info) => {
    await api(p, world());
    await p.goto('/campaigns?q=calm');
    await p.getByRole('link', { name: /Calm Focus Tea/ }).click();
    await p.waitForURL(`**/campaigns/${FINAL_ID}/final`);
    await expect(p.getByRole('heading', { level: 1, name: 'Calm Focus Tea' })).toBeVisible();
    await capture(p, '5-final-from-history', info.project.name);
    await p.getByRole('navigation', { name: /breadcrumb/i }).getByRole('link', { name: 'Campaigns' }).click();
    await p.waitForURL('**/campaigns');

    await p.getByRole('link', { name: /Serum Brief Ready/ }).click();
    await p.waitForURL(`**/campaigns/${BRIEF_ID}/brief`);
    await expect(p.getByRole('heading', { level: 1, name: 'Serum Brief Ready' })).toBeVisible();
    await capture(p, '6-brief-from-history', info.project.name);
  });

  test('keyboard only: the search box, the status chips and a campaign link are reachable and open the campaign', async ({ page: p }) => {
    await api(p, world());
    await p.goto('/campaigns');
    await expect(listed(p)).toHaveCount(10);
    await p.getByRole('searchbox', { name: 'Search by product name or description' }).focus();
    await p.keyboard.type('calm');
    await expect(listed(p)).toHaveCount(2);
    const link = p.getByRole('link', { name: /Evening Calm Gummies/ });
    await link.focus();
    await expect(link).toBeFocused();
    await p.keyboard.press('Enter');
    await p.waitForURL(`**/campaigns/${CAMPAIGN_ID}/clips`);
  });

  test('drafts: resume a draft at its saved step; the draft tab and its search are in the URL; Back returns', async ({ page: p }, info) => {
    const w = world();
    await api(p, w);
    await p.goto('/campaigns');
    await p.getByRole('tab', { name: /Drafts/ }).click();
    await expect.poll(() => query(p)).toBe('?tab=drafts');
    await expect(p.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toHaveCount(2);
    await expect(p.getByText('Step 3 of 4: Audience and direction')).toBeVisible();
    await expect(p.getByText('Untitled draft')).toHaveCount(0);
    await capture(p, '7-drafts-list', info.project.name);

    await p.getByRole('searchbox', { name: 'Search by product name or description' }).fill('morning');
    await expect.poll(() => query(p)).toBe('?tab=drafts&q=morning');
    await expect(p.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toHaveCount(1);

    await p.getByRole('link', { name: /Morning Focus Blend/ }).click();
    await p.waitForURL(`**/campaigns/new?draft=${DRAFT_ID}`);
    await expect(p.getByRole('heading', { level: 2, name: 'Audience and direction' })).toBeVisible();
    await expect(w.calls).toContain(`GET /drafts/${DRAFT_ID}`);
    await capture(p, '8-draft-resumed', info.project.name);

    await p.goBack();
    await p.waitForURL('**/campaigns?tab=drafts&q=morning');
    await expect(p.getByRole('tab', { name: /Drafts/ })).toHaveAttribute('aria-selected', 'true');
    await expect(p.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toHaveCount(1);
  });

  test('empty and no-results are different states, in History and in Drafts', async ({ page: p }, info) => {
    await api(p, world({ campaigns: [], drafts: [] }));
    await p.goto('/campaigns');
    await expect(p.getByRole('heading', { name: 'No campaigns yet' })).toBeVisible();
    await expect(p.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
    await expect(p.getByRole('link', { name: 'New brief' }).first()).toBeVisible();
    await capture(p, '9-empty-history', info.project.name);
    await p.getByRole('tab', { name: /Drafts/ }).click();
    await expect(p.getByRole('heading', { name: 'No drafts' })).toBeVisible();
    await capture(p, '10-empty-drafts', info.project.name);

  });

  test('no-results: a search that finds nothing is "no match" with a way back, not the empty state', async ({ page: p }, info) => {
    await api(p, world());
    await p.goto('/campaigns?q=zzzz');
    await expect(p.getByRole('heading', { name: 'No campaigns match "zzzz"' })).toBeVisible();
    await expect(p.getByRole('heading', { name: 'No campaigns yet' })).toHaveCount(0);
    await capture(p, '11-no-results', info.project.name);
    await p.getByRole('button', { name: 'Clear filters' }).click();
    await p.waitForURL((u) => u.search === '');
    await expect(listed(p)).toHaveCount(10);
  });

  test('error: a failed list read shows the documented error with a retry, never an empty list; retry recovers', async ({ page: p }, info) => {
    await api(p, world({ listFailures: 4 }));
    await p.goto('/campaigns');
    await expect(p.getByRole('heading', { name: 'No campaigns yet' })).toHaveCount(0);
    await expect(p.getByRole('button', { name: /Try again|Retry/i }).first()).toBeVisible({ timeout: 20_000 });
    await capture(p, '12-list-error', info.project.name);
    await p.getByRole('button', { name: /Try again|Retry/i }).first().click();
    await expect(listed(p)).toHaveCount(10);
  });

  test('cancel: Cancel on the delete dialog changes nothing; Delete draft removes it', async ({ page: p }, info) => {
    const w = world();
    await api(p, w);
    await p.goto('/campaigns?tab=drafts');
    await p.getByRole('button', { name: 'Delete draft Morning Focus Blend' }).click();
    await expect(p.getByRole('dialog')).toBeVisible();
    await capture(p, '13-delete-confirm', info.project.name);
    await p.getByRole('button', { name: 'Cancel' }).click();
    await expect(p.getByRole('dialog')).toHaveCount(0);
    expect(w.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    await expect(p.getByRole('link', { name: /Morning Focus Blend/ })).toBeVisible();

    await p.getByRole('button', { name: 'Delete draft Morning Focus Blend' }).click();
    await p.getByRole('button', { name: 'Delete draft', exact: true }).click();
    await expect(p.getByText('Draft deleted. Its product image is removed.')).toBeVisible();
    await expect(p.getByRole('link', { name: /Morning Focus Blend/ })).toHaveCount(0);
    expect(w.calls).toContain(`DELETE /drafts/${DRAFT_ID}`);
  });

  // MISMATCH (UI-UX §7 FLOW-06, §9.1 "Removed/not found"): the campaign screens (SCREEN-007, 008, 009) answer an unavailable
  // record with an in-page "This page or item is not available." under a generic "Campaign" title instead of sending the
  // user to SCREEN-004 `unavailable`. They are outside this ticket's paths, so it is a correction ticket for their owners.
  // `test.fail` keeps this check honest: it passes while the mismatch exists and fails the moment the screens are fixed,
  // which is the signal to delete the annotation.
  test('unavailable link goes to SCREEN-004 (open mismatch with SCREEN-007/008/009, expected to fail until fixed)', async ({ page: p }) => {
    test.fail(true, 'SCREEN-007/008/009 render an in-page unavailable state; UI-UX FLOW-06 requires SCREEN-004');
    await api(p, world());
    await p.goto('/campaigns');
    await p.getByRole('link', { name: /Vanished Tonic/ }).click();
    await p.waitForURL((u) => u.pathname === '/not-found' && u.searchParams.get('state') === 'unavailable', { timeout: 10_000 });
    await expect(p.getByRole('heading', { level: 1, name: 'This campaign is unavailable' })).toBeVisible();
  });

  test('unavailable link: the in-page unavailable state is one message with no hint which, and Go Home returns to the list', async ({ page: p }, info) => {
    await api(p, world());
    await p.goto('/campaigns');
    // Vanished Tonic (a deleted campaign still in a stale list) is on page 1.
    await p.getByRole('link', { name: /Vanished Tonic/ }).click();
    await p.waitForURL(`**/campaigns/${GONE_ID}/**`);
    await expect(p.getByText('This page or item is not available.').first()).toBeVisible({ timeout: 20_000 });
    await capture(p, '14-unavailable-campaign', info.project.name);
    await p.getByRole('link', { name: 'Go Home' }).first().click();
    await p.waitForURL('**/campaigns');
  });

  test('SCREEN-004: the unavailable page for a record link, then Go Home returns to the list', async ({ page: p }) => {
    await api(p, world());
    await p.goto('/not-found?state=unavailable');
    await expect(p.getByRole('heading', { level: 1, name: 'This campaign is unavailable' })).toBeVisible();
    await p.getByRole('link', { name: 'Go Home' }).click();
    await p.waitForURL('**/campaigns');
  });

  test('session expiry: an ended session on the list returns to sign-in carrying the list as the return path', async ({ page: p, context, baseURL }, info) => {
    await signedIn(context, baseURL!, -60);
    await p.goto('/campaigns?q=calm');
    expect(new URL(p.url()).pathname).toBe('/sign-in');
    expect(new URL(p.url()).searchParams.get('reason')).toBe('session-expired');
    await expect(p.getByText('Your session ended. Sign in to continue.')).toBeVisible();
    await expect(p.getByRole('heading', { name: 'Campaigns' })).toHaveCount(0);
    await capture(p, '15-session-expired', info.project.name);
  });

  test('session expiry mid-use: a 401 from the api never shows an empty list and goes to sign-in with the return path', async ({ page: p }) => {
    const w = world();
    await api(p, w);
    await p.goto('/campaigns');
    await expect(listed(p)).toHaveCount(10);
    w.ended = true;
    await p.getByRole('button', { name: 'Next' }).click();
    await p.waitForURL('**/sign-in**');
    expect(new URL(p.url()).searchParams.get('return')).toMatch(/^\/campaigns/);
    await expect(p.getByRole('heading', { name: 'No campaigns yet' })).toHaveCount(0);
  });

  test('permission: anonymous cannot read the list; the real api refuses an unauthenticated list read', async ({ page: p, context, request }) => {
    await context.clearCookies();
    await p.goto('/campaigns?q=calm');
    expect(new URL(p.url()).pathname).toBe('/sign-in');
    await expect(p.getByRole('heading', { name: 'Campaigns' })).toHaveCount(0);
    const res = await request.get(`${process.env.E2E_API_URL}/api/v1/campaigns`);
    expect(res.status()).toBe(401);
    expect((await res.json()).success).toBe(false);
  });
});
