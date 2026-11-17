import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { VIEWPORTS } from '../../support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

// TC-FLW-07 (FLOW-07): SCREEN-005 delete-confirm -> deleted toast; opening the deleted record shows SCREEN-004 unavailable.
// Runs against the built web app (`next start`) and the compiled api process. The api's identity is Clerk (the self-contained
// web build sends no bearer), so the data answers are a STATEFUL, contract-shaped stand-in for API-040, 020, 042, 025 and the
// record reads (labelled mock, one in-memory store the whole flow shares); the one `real api` test proves the entry point
// reaches the running api. The real-database delete is covered by the api integration suites, not here.
const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-110';
const SIZES = VIEWPORTS.filter((v) => v.name !== '768');
const NOW = '2026-11-16T12:00:00.000Z';
const meta = { requestId: 'req-e2e', timestamp: NOW };
const id = (prefix: string, n: number) =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const campaign = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('c', n),
  productName: `Product ${n}`,
  productDescriptionExcerpt: 'Description',
  progress: 'processing',
  briefState: 'accepted',
  segmentCount: 3,
  finalAvailable: false,
  createdAt: '2026-11-15T12:00:00.000Z',
  updatedAt: '2026-11-16T11:48:00.000Z',
  ...over,
});
const draft = (n: number, over: Record<string, unknown>) => ({
  id: id('d', n),
  version: 1,
  step: 3,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: null,
  productDescription: null,
  audience: null,
  direction: null,
  concept: null,
  script: null,
  productMediaId: null,
  campaignId: null,
  durationSeconds: 45,
  createdAt: '2026-11-10T11:00:00.000Z',
  updatedAt: '2026-11-16T11:55:00.000Z',
  ...over,
});
const key = (provider: string) => ({
  provider,
  configured: true,
  status: 'active',
  last4: '7Q2d',
  fingerprint: '4f9a1c07b21e',
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastValidatedAt: null,
  inFlightJobCount: 0,
});

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
const ok = (data: unknown, m: unknown = meta): Answer => ({
  status: 200,
  body: { success: true, data, metaData: m },
});
const failure = (status: number, code: string, headers: Record<string, string> = {}): Answer => ({
  status,
  headers,
  body: { success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta },
});
const page1 = (rows: unknown[]): Answer =>
  ok(rows, {
    ...meta,
    pagination: {
      type: 'cursor',
      limit: 10,
      returnedCount: rows.length,
      hasNextPage: false,
      nextCursor: null,
    },
  });

/** One shared in-memory store: deleting removes the record from every later read, as the api does (BR-22). */
function store() {
  const campaigns = [
    campaign(1, { productName: 'Morning Focus Blend' }),
    campaign(2, {
      productName: 'Evening Calm Gummies',
      progress: 'completed',
      finalAvailable: true,
      segmentCount: 4,
      updatedAt: '2026-11-16T10:00:00.000Z',
    }),
    campaign(3, {
      productName: 'Reishi Night Tincture',
      progress: 'in_progress',
      briefState: 'draft',
      updatedAt: '2026-11-15T08:00:00.000Z',
    }),
  ];
  const drafts = [
    draft(1, { productName: "Lion's Mane Sampler Pack", step: 3 }),
    draft(2, {
      productName: 'Chaga Chai Latte Mix',
      step: 4,
      durationSeconds: 60,
      updatedAt: '2026-11-12T11:00:00.000Z',
    }),
  ];
  return { campaigns, drafts, deleted: new Set<string>() };
}
type Store = ReturnType<typeof store>;
interface Faults {
  /** The answer to the next delete calls (each use consumes one); undefined lets the store decide. */
  deleteAnswers?: Answer[];
}

const signedIn = async (context: BrowserContext, baseURL: string, expiresIn = 600) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({
        sub: 'user_local_e2e',
        email: 'e2e@example.com',
        exp: Math.floor(Date.now() / 1000) + expiresIn,
      }),
      url: baseURL,
    },
  ]);

const linked = ok({
  linkState: 'linked',
  id: id('a', 1),
  role: 'user',
  status: 'active',
  mfa: { required: true, satisfied: true },
  recentAuth: { satisfied: true, maxAgeSeconds: 600 },
  keyNotices: [],
});

async function mockApi(page: Page, data: Store, faults: Faults = {}) {
  const origin = process.env.E2E_API_URL!;
  const calls: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
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
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}`);
    const del = request.method() === 'DELETE';
    const target = /\/(campaigns|drafts)\/([^/]+)/.exec(url.pathname);
    let answer: Answer;
    if (url.pathname.endsWith('/me/provider-keys')) answer = ok([key('openai'), key('wavespeed')]);
    else if (url.pathname.endsWith('/me')) answer = linked;
    else if (del && target) {
      const injected = faults.deleteAnswers?.shift();
      const [, kind, recordId] = target as unknown as [string, 'campaigns' | 'drafts', string];
      const pool = kind === 'campaigns' ? data.campaigns : data.drafts;
      const index = pool.findIndex((r) => r.id === recordId);
      if (injected) answer = injected;
      else if (index < 0) answer = failure(404, 'not_found');
      else {
        pool.splice(index, 1);
        data.deleted.add(recordId);
        answer =
          kind === 'campaigns'
            ? {
                status: 202,
                body: {
                  success: true,
                  data: { deletionRunId: id('e', 1), state: 'running' },
                  metaData: meta,
                },
              }
            : { status: 204 };
      }
    } else if (target && !del && target[1] === 'campaigns') {
      // A record read (brief, clips, final): a deleted or unknown campaign is the one `not_found` answer (BR-22).
      answer = failure(404, 'not_found');
    } else if (url.pathname.endsWith('/drafts')) answer = page1(data.drafts);
    else if (url.pathname.endsWith('/campaigns')) {
      const limit = url.searchParams.get('limit');
      answer = limit === '50' ? page1(data.campaigns.slice(0, 50)) : page1(data.campaigns);
    } else answer = failure(404, 'not_found');
    return route.fulfill({
      status: answer.status,
      headers: { ...cors, ...(answer.headers ?? {}) },
      ...(answer.status === 204
        ? {}
        : { contentType: 'application/json', body: JSON.stringify(answer.body) }),
    });
  });
  return { calls, deletes: () => calls.filter((c) => c.startsWith('DELETE')) };
}

/** The step's screenshot at both design widths plus axe, taken on the page as it stands. */
async function capture(page: Page, step: string, project: string) {
  const original = page.viewportSize();
  for (const { name, width, height } of SIZES) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await expectNoAxeViolations(page, `${evidence}/axe/${project}-${step}-${name}.json`);
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    await page.screenshot({ path: `${evidence}/screenshots/${step}-${name}.png`, fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

const list = (page: Page) => page.getByRole('list', { name: 'Campaign history' });
const noindex = (page: Page) =>
  page.locator('meta[name=robots]').evaluateAll((els) => els.map((e) => e.getAttribute('content')));
const DELETED_TOAST = 'Campaign deleted. Its media is being removed in the background.';
const DRAFT_TOAST = 'Draft deleted. Its product image is removed.';

test.describe('@TASK-110 @FLOW-07 delete a draft or campaign end to end', () => {
  test.use({ timezoneId: 'UTC' });
  test.setTimeout(120_000);
  test.beforeEach(async ({ context, baseURL, page }) => {
    await signedIn(context, baseURL!);
    await page.clock.setFixedTime(NOW);
  });

  test('real api: the delete entry point reaches the running api; without a bearer it answers 401 and the user goes to sign-in', async ({
    page,
  }) => {
    const origin = process.env.E2E_API_URL!;
    const sent: string[] = [];
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const cors = {
        'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'x-request-id',
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
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    await page.goto('/campaigns');
    await page.waitForURL('**/sign-in**');
    expect(sent).toContain('GET /api/v1/campaigns');
    // The running api refuses an unauthenticated delete with its error envelope, never a success.
    const res = await page.request.delete(`${origin}/api/v1/campaigns/${id('c', 1)}`);
    expect(res.status()).toBe(401);
    expect((await res.json()).success).toBe(false);
  });

  test('campaign: SCREEN-005 delete-confirm (keyboard only) -> deleted toast; the list no longer holds the record', async ({
    page,
  }, info) => {
    const data = store();
    const { deletes } = await mockApi(page, data);
    await page.goto('/campaigns');
    await expect(list(page).getByRole('listitem')).toHaveCount(3);
    const openHref = await list(page)
      .getByRole('link', { name: 'Reishi Night Tincture' })
      .getAttribute('href');
    expect(openHref).toBe(`/campaigns/${id('c', 3)}/brief`);
    await capture(page, '1-campaign-list', info.project.name);

    // Keyboard only: focus the row's delete button, open the dialog, Tab to the confirm button, Enter.
    const trigger = page.getByRole('button', { name: 'Delete Reishi Night Tincture' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Delete "Reishi Night Tincture"?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'including its brief, its clips, any final video and the product image',
    );
    await expect(dialog).toContainText(
      'Credit already spent at WaveSpeed or OpenAI cannot be recovered',
    );
    await expect(dialog).toContainText('This cannot be undone.');
    expect(deletes(), 'opening the dialog deletes nothing').toEqual([]);
    await capture(page, '2-delete-confirm-campaign', info.project.name);

    // The dialog traps focus: Tab reaches the confirm button within its few controls (nothing outside is reachable).
    const focused = () =>
      page.evaluate(
        () =>
          `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim() ?? ''}`,
      );
    const seen: string[] = [await focused()];
    for (let i = 0; i < 6 && !seen.at(-1)!.includes('Delete campaign'); i += 1) {
      await page.keyboard.press('Tab');
      seen.push(await focused());
    }
    expect(seen.at(-1), `focus order inside the dialog: ${seen.join(' > ')}`).toContain(
      'Delete campaign',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByText(DELETED_TOAST)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(list(page).getByRole('link', { name: 'Reishi Night Tincture' })).toHaveCount(0);
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    expect(deletes()).toEqual([`DELETE /api/v1/campaigns/${id('c', 3)}`]);
    await capture(page, '3-deleted-toast', info.project.name);

    expect(data.deleted).toEqual(new Set([id('c', 3)]));
  });

  /** Open the brief of a campaign that was deleted: the api answers the one not_found message (BR-22). */
  async function openDeleted(page: Page) {
    const data = store();
    const gone = data.campaigns.splice(2, 1)[0]!;
    data.deleted.add(gone.id);
    const { calls } = await mockApi(page, data);
    const res = await page.goto(`/campaigns/${gone.id}/brief`);
    expect(res?.status()).toBe(200);
    await expect
      .poll(() => calls.some((c) => c === `GET /api/v1/campaigns/${gone.id}/brief`))
      .toBe(true);
  }

  test('deleted record: the one not-available message with Go Home, no data and no hint (BR-22)', async ({
    page,
  }, info) => {
    await openDeleted(page);
    await expect(
      page.getByRole('heading', { name: 'This page or item is not available.' }),
    ).toBeVisible();
    await expect(page.getByText('Reishi Night Tincture')).toHaveCount(0);
    await capture(page, '4-deleted-record-not-available', info.project.name);
    await page.getByRole('link', { name: 'Go Home' }).click();
    await page.waitForURL('**/campaigns');
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    await expect(list(page).getByRole('link', { name: 'Reishi Night Tincture' })).toHaveCount(0);
  });

  // OPEN FINDING F-07-1 (UI-UX section 7 FLOW-07 and section 9.1 `not_found`): a page load of a deleted record must show
  // SCREEN-004 `unavailable`; SCREEN-007 shows the page-level not-found alert instead. The record screens and the shared
  // error presentation are owned by TASK-0xx tickets, outside this ticket's paths. `test.fail` keeps this check honest:
  // it turns red the day the screens redirect, and the annotation is then removed.
  test('deleted record opens SCREEN-004 unavailable (open finding F-07-1)', async ({
    page,
  }, info) => {
    test.fail(
      true,
      'F-07-1: the record screens show the page-level not-found alert, not SCREEN-004',
    );
    await openDeleted(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'This campaign is unavailable' }),
    ).toBeVisible({ timeout: 3000 });
    await expect(page.getByText("We can't tell you which.")).toBeVisible();
    expect(await noindex(page)).toEqual(expect.arrayContaining([expect.stringMatching(/noindex/)]));
    await capture(page, '4-deleted-record-unavailable', info.project.name);
  });

  test('draft: delete-confirm -> deleted toast; the draft is gone from the list', async ({
    page,
  }, info) => {
    const data = store();
    const { deletes } = await mockApi(page, data);
    await page.goto('/campaigns?tab=drafts');
    await page.getByRole('tab', { name: /Drafts/ }).click();
    await expect(page.getByText("Lion's Mane Sampler Pack")).toBeVisible();
    await page.getByRole('button', { name: "Delete draft Lion's Mane Sampler Pack" }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete draft "Lion\'s Mane Sampler Pack"?' });
    await expect(dialog).toContainText('This removes the draft and its product image.');
    await capture(page, '5-delete-confirm-draft', info.project.name);
    await dialog.getByRole('button', { name: 'Delete draft' }).click();
    await expect(page.getByText(DRAFT_TOAST)).toBeVisible();
    await expect(page.getByText("Lion's Mane Sampler Pack")).toHaveCount(0);
    await expect(page.getByText('Chaga Chai Latte Mix')).toBeVisible();
    expect(deletes()).toEqual([`DELETE /api/v1/drafts/${id('d', 1)}`]);
    await capture(page, '6-deleted-toast-draft', info.project.name);
  });

  test('cancel path: Cancel, Escape and the close control keep the record and call nothing', async ({
    page,
  }, info) => {
    const data = store();
    const { deletes } = await mockApi(page, data);
    await page.goto('/campaigns');
    await expect(list(page).getByRole('listitem')).toHaveCount(3);
    const trigger = page.getByRole('button', { name: 'Delete Morning Focus Blend' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Delete "Morning Focus Blend"?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(list(page).getByRole('link', { name: 'Morning Focus Blend' })).toBeVisible();
    await expect(page.getByText(DELETED_TOAST)).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await capture(page, '7-cancel-dialog-open', info.project.name);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(list(page).getByRole('link', { name: 'Morning Focus Blend' })).toBeVisible();
    expect(deletes(), 'cancelling never reaches the api').toEqual([]);
    expect(data.deleted.size).toBe(0);
    await page.reload();
    await expect(list(page).getByRole('listitem')).toHaveCount(3);
  });

  test('error path: a failed delete keeps the dialog and the record with the documented message, never a success; retry works', async ({
    page,
  }, info) => {
    const data = store();
    const { deletes } = await mockApi(page, data, {
      deleteAnswers: [failure(500, 'internal_error')],
    });
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Delete Evening Calm Gummies' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete "Evening Calm Gummies"?' });
    await dialog.getByRole('button', { name: 'Delete campaign' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(page.getByText(DELETED_TOAST)).toHaveCount(0);
    await expect(list(page).getByRole('link', { name: 'Evening Calm Gummies' })).toBeVisible();
    expect(data.deleted.size).toBe(0);
    await capture(page, '8-delete-error', info.project.name);
    await dialog.getByRole('button', { name: 'Delete campaign' }).click();
    await expect(page.getByText(DELETED_TOAST)).toBeVisible();
    await expect(list(page).getByRole('link', { name: 'Evening Calm Gummies' })).toHaveCount(0);
    expect(deletes()).toHaveLength(2);
  });

  test('already deleted meanwhile (404): the record leaves the list, no false success toast', async ({
    page,
  }, info) => {
    const data = store();
    const { deletes } = await mockApi(page, data, { deleteAnswers: [failure(404, 'not_found')] });
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Delete Morning Focus Blend' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete "Morning Focus Blend"?' });
    // The record is removed by someone else before the confirm.
    data.campaigns.splice(0, 1);
    await dialog.getByRole('button', { name: 'Delete campaign' }).click();
    await expect(page.getByText(DELETED_TOAST)).toHaveCount(0);
    await expect(list(page).getByRole('link', { name: 'Morning Focus Blend' })).toHaveCount(0);
    await capture(page, '9-already-deleted', info.project.name);
    expect(deletes()).toHaveLength(1);
  });

  // OPEN FINDING F-07-3 (UI-UX section 9.1 `not_found`, "An action on a record deleted meanwhile"): the dialog must close and
  // the same message appear as a toast; SCREEN-005 keeps the dialog open with the message in it. Owned by TASK-090.
  test('already deleted meanwhile: the dialog closes and the not-available message shows as a toast (open finding F-07-3)', async ({
    page,
  }) => {
    test.fail(true, 'F-07-3: SCREEN-005 keeps the delete dialog open on a 404');
    const data = store();
    await mockApi(page, data, { deleteAnswers: [failure(404, 'not_found')] });
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Delete Morning Focus Blend' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete campaign' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 3000 });
    await expect(
      page.getByRole('status').getByText('This page or item is not available.'),
    ).toBeVisible({ timeout: 3000 });
  });

  test('permission path: a refused delete (403) keeps the record and shows no success', async ({
    page,
  }, info) => {
    const data = store();
    await mockApi(page, data, { deleteAnswers: [failure(403, 'forbidden_role')] });
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Delete Morning Focus Blend' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete "Morning Focus Blend"?' });
    await dialog.getByRole('button', { name: 'Delete campaign' }).click();
    await expect(dialog.getByText('You do not have permission to do this.')).toBeVisible();
    await expect(page.getByText(DELETED_TOAST)).toHaveCount(0);
    await expect(list(page).getByRole('link', { name: 'Morning Focus Blend' })).toBeVisible();
    await capture(page, '10-delete-forbidden', info.project.name);
  });

  // OPEN FINDING F-07-2 (UI-UX section 9.1 `unauthenticated`): a 401 on the delete must end at sign-in with the
  // session-ended message; SCREEN-005 keeps the dialog open with the message instead. Owned by TASK-090.
  test('session expiry: a 401 on the delete returns to sign-in with the path to come back to (open finding F-07-2)', async ({
    page,
  }) => {
    test.fail(true, 'F-07-2: SCREEN-005 does not redirect to sign-in on a 401 from the delete');
    const data = store();
    await mockApi(page, data, { deleteAnswers: [failure(401, 'unauthenticated')] });
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Delete Morning Focus Blend' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete campaign' }).click();
    await page.waitForURL('**/sign-in**', { timeout: 5000 });
    expect(new URL(page.url()).searchParams.get('return')).toBe('/campaigns');
    expect(data.deleted.size).toBe(0);
  });

  test('session expiry before the page: an ended session goes to sign-in, not to the list', async ({
    page,
    context,
    baseURL,
  }) => {
    await signedIn(context, baseURL!, -60);
    await page.goto('/campaigns');
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(new URL(page.url()).searchParams.get('reason')).toBe('session-expired');
    await expect(page.getByText('Your session ended. Sign in to continue.')).toBeVisible();
  });

  test('back path: back from the unavailable page returns to the list, which still omits the deleted record', async ({
    page,
  }) => {
    const data = store();
    await mockApi(page, data);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Delete Reishi Night Tincture' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete campaign' }).click();
    await expect(page.getByText(DELETED_TOAST)).toBeVisible();
    await page.goto(`/campaigns/${id('c', 3)}/brief`);
    await expect(
      page.getByRole('heading', { name: 'This page or item is not available.' }),
    ).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
    await expect(list(page).getByRole('link', { name: 'Reishi Night Tincture' })).toHaveCount(0);
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
  });
});
