import { copyFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { EVIDENCE, ensureDir, failure, meta, relay, settle, signedIn } from './support';

/**
 * Inventory states that no per-screen spec captures (docs/evidence/TASK-118/README.md, "Gap states"):
 *  - SCREEN-001 `loading` and `error`: the CMP-032 shell that app/(auth)/loading.tsx and error.tsx render, in the
 *    gallery cells that show it (a provider load cannot be held open or failed from outside in local mode);
 *  - SCREEN-006 `details-summary`: step 4 of the wizard after API-024 refuses with eight `details[]` entries.
 * Each is captured at 390 and 1440 px with axe and a baseline in __baselines__/chromium.
 */
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

async function record(
  page: Page,
  info: { project: { name: string }; snapshotPath: (n: string) => string },
  key: string,
  width: string,
  locator?: string,
) {
  await settle(page);
  await expectNoAxeViolations(
    page,
    `${EVIDENCE}/axe/${info.project.name}-${key}-${width}.json`,
    locator,
  );
  await page.addStyleTag({ content: '.fixed { visibility: hidden !important; }' });
  const baseline = `a11y-${key}-${width}.png`;
  if (locator) await expect(page.locator(locator)).toHaveScreenshot(baseline);
  else await expect(page).toHaveScreenshot(baseline, { fullPage: true });
  if (process.env.EVIDENCE === '1') {
    ensureDir(`${EVIDENCE}/screenshots`);
    copyFileSync(info.snapshotPath(baseline), `${EVIDENCE}/screenshots/${key}-${width}.png`);
  }
}

test.describe('@a11y @TASK-118 gap states of the screen inventory', () => {
  test.beforeEach(async ({ browserName }) => {
    test.skip(browserName !== 'chromium');
  });

  for (const size of SIZES) {
    for (const state of ['loading', 'error'] as const) {
      test(`SCREEN-001 ${state} at ${size.name} px`, async ({ page }, info) => {
        await page.setViewportSize(size);
        await page.goto('/gallery');
        const cell = `[data-cell=auth-${state}]`;
        await expect(page.locator(cell)).toBeVisible();
        if (state === 'loading')
          await expect(page.locator(`${cell} [aria-busy=true]`)).toBeAttached();
        else
          await expect(page.locator(cell).getByRole('button', { name: 'Try again' })).toBeVisible();
        await record(page, info, `screen-001-${state}`, size.name, cell);
      });
    }

    test(`SCREEN-006 details-summary at ${size.name} px`, async ({
      page,
      context,
      baseURL,
    }, info) => {
      await signedIn(context, baseURL!);
      await page.setViewportSize(size);
      await page.clock.setFixedTime('2026-11-16T12:00:00.000Z');
      const ID = '8f3a0000-0000-4000-8000-00000000d001';
      const draft = {
        id: ID,
        version: 1,
        step: 4,
        adStyle: 'ugc',
        intakeMode: 'description',
        productName: 'Morning Focus Blend',
        productDescription: 'Capsules.',
        audience: { ageMin: 35, ageMax: 52, gender: 'all', interests: ['morning routines'] },
        direction: { goal: 'conversion', tone: 'Calm', segmentCount: 3 },
        concept: 'A calm morning routine.',
        script: null,
        productMediaId: null,
        campaignId: null,
        durationSeconds: 45,
        createdAt: '2026-11-16T08:00:00.000Z',
        updatedAt: '2026-11-16T08:00:00.000Z',
      };
      const read = {
        status: 200,
        headers: { etag: '"1"' },
        body: { success: true, data: draft, metaData: meta },
      };
      const details = [
        { field: 'productName', code: 'required', message: 'Enter the product name.' },
        {
          field: 'productDescription',
          code: 'required',
          message: 'Describe the product so the script can feature it.',
        },
        {
          field: 'productMediaId',
          code: 'too_large',
          message: 'This image is larger than 10 MB. Choose a smaller file.',
        },
        {
          field: 'segments.0.dialogue',
          code: 'too_long',
          message:
            'The dialogue is longer than 15 seconds. Shorten it or move words to the next segment.',
        },
        {
          field: 'segments.1.overlay',
          code: 'claim',
          message:
            'The call-out text contains a claim that cannot be made. Edit the text until the check passes.',
        },
        {
          field: 'segments.2.dialogue',
          code: 'too_long',
          message: 'The dialogue is longer than 15 seconds.',
        },
        { field: 'segments.3.dialogue', code: 'required', message: 'The dialogue is empty.' },
        {
          field: 'segments.3.shot',
          code: 'required',
          message: 'The shot description is required.',
        },
      ];
      await relay(page, (method, path) => {
        if (method === 'GET' && path === '/me')
          return {
            status: 200,
            body: {
              success: true,
              data: {
                linkState: 'linked',
                id: ID,
                role: 'user',
                status: 'active',
                mfa: { required: true, satisfied: true },
                recentAuth: { satisfied: true, maxAgeSeconds: 600 },
                keyNotices: [],
              },
              metaData: meta,
            },
          };
        if (method === 'GET' && path === '/me/provider-keys')
          return { status: 200, body: { success: true, data: [], metaData: meta } };
        if (method === 'GET' && path === `/drafts/${ID}`) return read;
        if (method === 'PATCH' && path === `/drafts/${ID}`)
          return {
            ...read,
            headers: { etag: '"2"' },
            body: { success: true, data: { ...draft, version: 2 }, metaData: meta },
          };
        if (method === 'POST' && path === `/drafts/${ID}/submit`)
          return failure(422, 'validation_failed', details);
      });
      await page.goto(`/campaigns/new?draft=${ID}`);
      await expect(
        page.getByRole('heading', { level: 2, name: 'Concept and script' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Generate brief' }).click();
      await expect(
        page.getByRole('heading', {
          level: 2,
          name: 'Check the highlighted fields and try again.',
        }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /and 3 more/ })).toBeVisible();
      await record(page, info, 'screen-006-details-summary', size.name);
    });
  }
});
