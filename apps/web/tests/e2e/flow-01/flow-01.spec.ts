import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { API, heading, png, provider, settle, signIn, sql, type Session } from './support';

// FLOW-01 (UI-UX §7, TC-FLW-01): SCREEN-005 to SCREEN-006 (steps 1 to 4, autosave, image upload and analysis) to
// SCREEN-007, on the built web app against the built api and worker, a real PostgreSQL, a real MinIO and the provider
// stub. The only thing added at the network layer is the session bearer (support.ts, `signIn`); every answer is the api's,
// except the three faults a test injects on purpose (`failNext`), each named in its test.

const evidence = resolve(__dirname, '..', '..', '..', '..', '..', 'docs', 'evidence', 'TASK-104');
const WIDTHS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const PRODUCT = 'Morning Focus Blend';
const DESCRIPTION = 'Lion’s Mane and Cordyceps capsules for a steady start to the day.';
const CONCEPT =
  'A calm morning routine: she takes the capsules with breakfast, then heads out for a trail run.';
const ANALYSIS = 'A glass bottle of 60 capsules';

/** One screenshot per step and width, and axe (all WCAG 2.2 AA rules, any impact) on the same page state. */
async function capture(page: Page, name: string, width: string) {
  await settle(page);
  await page.waitForTimeout(200);
  await expectNoAxeViolations(page, `${evidence}/axe/${name}-${width}.json`);
  mkdirSync(`${evidence}/screenshots`, { recursive: true });
  await page.screenshot({ path: `${evidence}/screenshots/${name}-${width}.png`, fullPage: true });
}

const draftRow = async (owner: string, id?: string) =>
  (
    await sql<Record<string, unknown>>(
      `select id, version, step, product_name, product_media_id, concept from drafts where owner_id = '${owner}' ${id ? `and id = '${id}'` : ''} order by created_at desc`,
    )
  )[0];

/** SCREEN-006 at step 2 with the draft created (the first Next saves it; its id is in the URL). */
async function openStep2(page: Page): Promise<string> {
  await page.goto('/campaigns/new');
  await heading(page, 'Choose the format');
  await page.getByRole('button', { name: /Next: Product/ }).click();
  await heading(page, 'Tell us about the product');
  await page.waitForURL(/\/campaigns\/new\?draft=[0-9a-f-]{36}/);
  return new URL(page.url()).searchParams.get('draft')!;
}

const fillProduct = async (page: Page) => {
  await page.getByRole('textbox', { name: /Product name/ }).fill(PRODUCT);
  await page.getByRole('textbox', { name: /Product description/ }).fill(DESCRIPTION);
};

async function fillAudience(page: Page) {
  await page.getByRole('spinbutton', { name: /Age from/ }).fill('35');
  await page.getByRole('spinbutton', { name: /Age to/ }).fill('52');
  await page.getByRole('textbox', { name: /Interests/ }).fill('morning routines, trail running');
  await page.locator('label', { hasText: 'Awareness' }).click();
  await expect(page.getByRole('radio', { name: 'Awareness' })).toBeChecked();
  await page.getByRole('combobox', { name: /Tone/ }).selectOption('Calm and grounded');
  await page
    .getByRole('radiogroup', { name: 'Segments' })
    .locator('label', { hasText: /^2$/ })
    .click();
  await expect(page.getByTestId('segments-total')).toContainText('2 segments');
}

for (const { name, width, height } of WIDTHS) {
  test.describe(`@TASK-104 FLOW-01 at ${name} px`, () => {
    test.use({ viewport: { width, height } });
    let session: Session;
    test.beforeEach(async ({ context, page, baseURL }) => {
      await provider('ok');
      session = await signIn(context, page, baseURL!);
    });
    test.afterEach(async (_fixtures, info) => {
      if (info.status === info.expectedStatus) return;
      // What the api and the worker left behind, attached to the failure report.
      const jobs = await sql(
        'select kind, state, cause_class, cause_message, call_count from brief_jobs order by created_at',
      );
      await info.attach('brief-jobs.json', {
        body: JSON.stringify(jobs, null, 2),
        contentType: 'application/json',
      });
      await info.attach('api-errors.json', {
        body: JSON.stringify(session.errors, null, 2),
        contentType: 'application/json',
      });
      await info.attach('api-calls.json', {
        body: JSON.stringify(session.calls, null, 2),
        contentType: 'application/json',
      });
    });

    test('TC-FLW-01: enter inputs, upload and analyse the image, leave, resume and generate the brief', async ({
      page,
    }) => {
      // SCREEN-005: no campaigns yet, the New brief action starts the wizard.
      await page.goto('/campaigns');
      await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
      await expect(page.getByText('No campaigns yet')).toBeVisible();
      await capture(page, '01-campaigns-empty', name);
      await page.getByRole('link', { name: 'New brief' }).first().click();
      await page.waitForURL('**/campaigns/new');

      // SCREEN-006 step 1.
      await heading(page, 'Choose the format');
      await expect(page.getByTestId('save-status')).toBeEmpty();
      await capture(page, '02-step-1', name);
      await page.getByRole('button', { name: /Next: Product/ }).click();

      // Step 2: the draft exists now and its id is in the URL.
      await heading(page, 'Tell us about the product');
      await page.waitForURL(/\/campaigns\/new\?draft=[0-9a-f-]{36}/);
      const draftId = new URL(page.url()).searchParams.get('draft')!;
      await expect(page.getByTestId('save-status')).toContainText('Draft saved');
      await fillProduct(page);
      await page
        .getByTestId('file-upload-input')
        .setInputFiles({
          name: 'morning-focus-blend.png',
          mimeType: 'image/png',
          buffer: png(320),
        });
      await expect(page.locator('li[data-status="ready"]')).toBeVisible();
      await capture(page, '03-step-2-image-ready', name);

      // Analysis by the worker through the provider stub; the person copies it into the description.
      await page.getByRole('button', { name: 'Describe this image' }).click();
      await expect(page.getByTestId('analysis-result')).toContainText(ANALYSIS);
      await capture(page, '04-step-2-analysis', name);
      await page.getByRole('button', { name: 'Use as product description' }).click();
      await expect(page.getByRole('textbox', { name: /Product description/ })).toHaveValue(
        new RegExp(ANALYSIS),
      );
      await page.getByRole('button', { name: /Next: Audience/ }).click();

      // Step 3.
      await heading(page, 'Audience and direction');
      await fillAudience(page);
      await capture(page, '05-step-3', name);
      await page.getByRole('button', { name: /Next: Concept and script/ }).click();

      // Step 4.
      await heading(page, 'Concept and script');
      await page.getByRole('textbox', { name: /Concept/ }).fill(CONCEPT);
      await expect(page.getByTestId('save-status')).toContainText('Draft saved');
      await capture(page, '06-step-4', name);

      // The draft and the image are persisted before the person leaves.
      // (the autosave writes the concept 0.8 s after the last keystroke)
      await expect
        .poll(async () => (await draftRow(session.userId, draftId))?.['concept'])
        .toBe(CONCEPT);
      const saved = await draftRow(session.userId, draftId);
      expect(saved?.['product_media_id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(saved?.['step']).toBe(4);
      const [media] = await sql<{ state: string; owner_id: string }>(
        `select state, owner_id from media_objects where id = '${String(saved?.['product_media_id'])}'`,
      );
      expect(media).toEqual({ state: 'ready', owner_id: session.userId });

      // Back to the list keeps the draft; opening it resumes at step 4 with the values and the image.
      await page.goto('/campaigns?tab=drafts');
      const link = page.getByRole('link', { name: new RegExp(PRODUCT) }).first();
      await expect(link).toBeVisible();
      await capture(page, '07-drafts-list', name);
      await link.click();
      await page.waitForURL(`**/campaigns/new?draft=${draftId}`);
      await heading(page, 'Concept and script');
      await expect(page.getByRole('textbox', { name: /Concept/ })).toHaveValue(CONCEPT);
      await expect(page.getByText('Added', { exact: true })).toBeVisible();
      await capture(page, '08-step-4-resumed', name);

      // SCREEN-007: the draft is submitted; the worker generates the brief through the provider stub.
      await page.getByRole('button', { name: 'Generate brief' }).click();
      await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}\/brief/);
      await expect(page.getByRole('heading', { level: 1, name: PRODUCT })).toBeVisible();
      await capture(page, '09-brief-generating', name);
      await expect(page.getByRole('button', { name: 'Accept brief' })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole('textbox', { name: 'Segment 1 dialogue' })).toHaveValue(/calm0/);
      await capture(page, '10-brief-ready', name);
      expect(
        session.calls.some((c) => c.startsWith('POST /drafts/') && c.endsWith('/submit 202')),
      ).toBe(true);
      const [brief] = await sql<{ state: string }>(
        `select state from briefs where owner_id = '${session.userId}'`,
      );
      expect(brief?.state).toBe('draft');
      // The submitted draft is read-only and points at its campaign.
      await page.goto(`/campaigns/new?draft=${draftId}`);
      await expect(page.getByText('This draft has already been submitted')).toBeVisible();
    });

    test('validation errors keep the person on the step; back keeps the values; the draft carries the step', async ({
      page,
    }) => {
      const draftId = await openStep2(page);
      await page.getByRole('button', { name: /Next: Audience/ }).click();
      await expect(page.getByText('Fix 2 things to continue')).toBeVisible();
      await expect(page.getByText('Enter the product name.').first()).toBeVisible();
      await heading(page, 'Tell us about the product');
      await capture(page, '11-step-2-validation-error', name);
      await fillProduct(page);
      await page.getByRole('button', { name: /Next: Audience/ }).click();
      await heading(page, 'Audience and direction');
      await page.getByRole('button', { name: 'Back' }).click();
      await heading(page, 'Tell us about the product');
      await expect(page.getByRole('textbox', { name: /Product name/ })).toHaveValue(PRODUCT);
      await expect
        .poll(async () => (await draftRow(session.userId, draftId))?.['product_name'])
        .toBe(PRODUCT);
    });

    test('a save failure keeps the values and Try again saves them (fault injected on the PATCH)', async ({
      page,
    }) => {
      const draftId = await openStep2(page);
      session.failNext(`PATCH /drafts/${draftId}`, 503, 'service_unavailable');
      await fillProduct(page);
      // The autosave of the edit is the call that fails.
      const failed = page.getByText('ShrooMap is temporarily unavailable');
      await expect(failed).toBeVisible();
      await expect(page.getByRole('textbox', { name: /Product name/ })).toHaveValue(PRODUCT);
      await heading(page, 'Tell us about the product');
      expect((await draftRow(session.userId, draftId))?.['product_name']).toBeNull();
      await capture(page, '12-step-2-save-failed', name);
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByTestId('save-status')).toContainText('Draft saved');
      await expect
        .poll(async () => (await draftRow(session.userId, draftId))?.['product_name'])
        .toBe(PRODUCT);
    });

    test('a stale save is refused with the conflict state and nothing is overwritten', async ({
      page,
    }) => {
      const draftId = await openStep2(page);
      await fillProduct(page);
      await expect(page.getByTestId('save-status')).toContainText('Draft saved');
      await expect
        .poll(async () => (await draftRow(session.userId, draftId))?.['product_name'])
        .toBe(PRODUCT);
      // Another tab saves a newer version of the draft (a direct call to API-023 with the current version).
      const current = await fetch(`${API()}/api/v1/drafts/${draftId}`, {
        headers: { authorization: `Bearer ${session.bearer}` },
      });
      const other = await fetch(`${API()}/api/v1/drafts/${draftId}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${session.bearer}`,
          'content-type': 'application/json',
          'if-match': current.headers.get('etag')!,
        },
        body: JSON.stringify({ productName: 'Edited elsewhere' }),
      });
      expect(other.status).toBe(200);
      await page.getByRole('textbox', { name: /Product name/ }).fill('Edited here');
      await expect(page.getByText('This draft was changed in another tab')).toBeVisible();
      await expect(page.getByRole('textbox', { name: /Product name/ })).toHaveValue('Edited here');
      expect((await draftRow(session.userId, draftId))?.['product_name']).toBe('Edited elsewhere');
      await capture(page, '13-step-2-conflict', name);
      await page.getByRole('button', { name: 'Reload latest version' }).click();
      await expect(page.getByRole('textbox', { name: /Product name/ })).toHaveValue(
        'Edited elsewhere',
      );
      await expect(page.getByText('This draft was changed in another tab')).toBeHidden();
    });

    test('an ended session shows the sign-in dialog and returns to the same draft and step', async ({
      page,
    }) => {
      const draftId = await openStep2(page);
      await fillProduct(page);
      await page.getByRole('button', { name: /Next: Audience/ }).click();
      await heading(page, 'Audience and direction');
      await expect.poll(async () => (await draftRow(session.userId, draftId))?.['step']).toBe(3);
      // The api refuses the next write: its session check rejects an expired token.
      session.setBearer('expired.session.token');
      await page.getByRole('spinbutton', { name: /Age from/ }).fill('40');
      await page.getByRole('button', { name: /Next: Concept and script/ }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Your session has ended' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('step 3 of this draft');
      expect(session.calls.some((c) => c.startsWith('PATCH /drafts/') && c.endsWith(' 401'))).toBe(
        true,
      );
      await capture(page, '14-step-3-session-expired', name);
      session.setBearer(null);
      await dialog.getByRole('button', { name: 'Sign in again' }).click();
      await page.waitForURL('**/sign-in**');
      expect(new URL(page.url()).searchParams.get('return')).toBe(
        `/campaigns/new?draft=${draftId}`,
      );
      // A new session on the same draft resumes at step 3 with the saved values.
      await page.goto(`/campaigns/new?draft=${draftId}`);
      await heading(page, 'Audience and direction');
      await expect(page.getByRole('textbox', { name: /Interests/ })).toBeVisible();
    });

    test('files that are not usable images are rejected with their reason and the step can still be completed', async ({
      page,
    }) => {
      const draftId = await openStep2(page);
      await fillProduct(page);
      const upload = page.getByTestId('file-upload-input');
      // Refused by the api at once (the content is not an image) ...
      await upload.setInputFiles({
        name: 'notes.png',
        mimeType: 'image/png',
        buffer: Buffer.from('this is not an image '.repeat(40)),
      });
      await expect(page.locator('li[data-status="rejected"]')).toContainText(
        'This content type is not supported.',
      );
      await capture(page, '15-step-2-upload-rejected', name);
      // ... and, as an image that opens as one but cannot be decoded, rejected by the worker.
      await upload.setInputFiles({
        name: 'truncated.png',
        mimeType: 'image/png',
        buffer: png(320).subarray(0, 300),
      });
      await expect(page.locator('li[data-status="rejected"]')).toContainText('could not be read');
      await capture(page, '15b-step-2-upload-undecodable', name);
      await expect(page.locator('li[data-status="ready"]')).toHaveCount(0);
      await page.getByRole('button', { name: /Next: Audience/ }).click();
      await heading(page, 'Audience and direction');
      await expect.poll(async () => (await draftRow(session.userId, draftId))?.['step']).toBe(3);
      expect((await draftRow(session.userId, draftId))?.['product_media_id']).toBeNull();
      const media = await sql<{ state: string; reject_reason: string | null }>(
        `select state, reject_reason from media_objects where owner_id = '${session.userId}'`,
      );
      expect(media.map((m) => m.state)).not.toContain('ready');
    });

    test('an analysis that fails shows the failure and never a description (provider stub fails)', async ({
      page,
    }) => {
      await openStep2(page);
      await fillProduct(page);
      await provider('fail');
      await page
        .getByTestId('file-upload-input')
        .setInputFiles({ name: 'bottle.png', mimeType: 'image/png', buffer: png(320) });
      await expect(page.locator('li[data-status="ready"]')).toBeVisible();
      await page.getByRole('button', { name: 'Describe this image' }).click();
      await expect(page.getByText('could not be described').first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByTestId('analysis-result')).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: /Product description/ })).toHaveValue(
        DESCRIPTION,
      );
      await capture(page, '16-step-2-analysis-failed', name);
    });

    test('start over: Cancel keeps the draft, Start over deletes it and its image', async ({
      page,
    }) => {
      const draftId = await openStep2(page);
      await fillProduct(page);
      await page
        .getByTestId('file-upload-input')
        .setInputFiles({ name: 'bottle.png', mimeType: 'image/png', buffer: png(320) });
      await expect(page.locator('li[data-status="ready"]')).toBeVisible();
      await page.getByRole('button', { name: 'Back' }).click();
      await heading(page, 'Choose the format');
      await page.getByRole('button', { name: 'Start over' }).click();
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
      await expect(dialog).toBeVisible();
      await capture(page, '17-start-over-confirm', name);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(await draftRow(session.userId, draftId)).toBeDefined();
      await page.getByRole('button', { name: 'Start over' }).click();
      await dialog.getByRole('button', { name: 'Start over' }).click();
      await expect.poll(() => draftRow(session.userId, draftId)).toBeUndefined();
      await expect(page).toHaveURL(/\/campaigns\/new$/);
      await heading(page, 'Choose the format');
      // The deleted draft's link now shows the unavailable state, with the way to start again.
      await page.goto(`/campaigns/new?draft=${draftId}`);
      await expect(page.getByText('This draft is not available')).toBeVisible();
      await capture(page, '18-draft-unavailable', name);
    });

    test('permission paths: another operator cannot open the draft; without an OpenAI key Generate shows the key-missing state', async ({
      page,
      browser,
      baseURL,
    }) => {
      const draftId = await openStep2(page);
      // A second operator, no key: the first operator's draft is concealed as not found.
      const context = await browser.newContext({ viewport: { width, height } });
      const other = await context.newPage();
      const otherSession = await signIn(context, other, baseURL!, false);
      await other.goto(`/campaigns/new?draft=${draftId}`);
      await expect(other.getByText('This draft is not available')).toBeVisible();
      expect(otherSession.calls).toContain(`GET /drafts/${draftId} 404`);
      // Their own draft reaches step 4 and Generate is refused by the api because no key is stored.
      await other.goto('/campaigns/new');
      await other.getByRole('button', { name: /Next: Product/ }).click();
      await other.getByRole('textbox', { name: /Product name/ }).fill(PRODUCT);
      await other.getByRole('textbox', { name: /Product description/ }).fill(DESCRIPTION);
      await other.getByRole('button', { name: /Next: Audience/ }).click();
      await fillAudience(other);
      await other.getByRole('button', { name: /Next: Concept and script/ }).click();
      await other.getByRole('textbox', { name: /Concept/ }).fill(CONCEPT);
      await other.getByRole('button', { name: 'Generate brief' }).click();
      await expect(other.getByText('Add your OpenAI key to generate the brief')).toBeVisible();
      await expect(other.getByRole('button', { name: 'Generate brief' })).toBeDisabled();
      await capture(other, '19-step-4-key-missing', name);
      expect(
        otherSession.calls.some((c) => c.startsWith('POST /drafts/') && c.endsWith('/submit 422')),
      ).toBe(true);
      expect(
        (await sql(`select 1 from campaigns where owner_id = '${otherSession.userId}'`)).length,
      ).toBe(0);
      await context.close();
    });

    test('a brief that cannot be generated shows the failed state, never a brief (provider stub fails)', async ({
      page,
    }) => {
      await openStep2(page);
      await fillProduct(page);
      await page.getByRole('button', { name: /Next: Audience/ }).click();
      await fillAudience(page);
      await page.getByRole('button', { name: /Next: Concept and script/ }).click();
      await page.getByRole('textbox', { name: /Concept/ }).fill(CONCEPT);
      await provider('fail');
      await page.getByRole('button', { name: 'Generate brief' }).click();
      await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}\/brief/);
      await expect(page.getByText('The brief could not be generated').first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(page.getByRole('button', { name: 'Accept brief' })).toHaveCount(0);
      await capture(page, '20-brief-failed', name);
    });
  });
}

test.describe('@TASK-104 FLOW-01 keyboard only at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('NFR-07: the journey from the list to the brief with the keyboard (the file chooser is the one native dialog)', async ({
    page,
    context,
    baseURL,
  }) => {
    await provider('ok');
    const session = await signIn(context, page, baseURL!);
    const press = async (locator: ReturnType<Page['getByRole']>, key = 'Enter') => {
      await locator.focus();
      await page.keyboard.press(key);
    };
    await page.goto('/campaigns');
    await press(page.getByRole('main').getByRole('link', { name: 'New brief' }));
    await heading(page, 'Choose the format');
    await press(page.getByRole('button', { name: /Next: Product/ }));
    await heading(page, 'Tell us about the product');
    await page.getByRole('textbox', { name: /Product name/ }).focus();
    await page.keyboard.type(PRODUCT);
    await page.keyboard.press('Tab');
    await page.keyboard.type(DESCRIPTION);
    await page
      .getByTestId('file-upload-input')
      .setInputFiles({ name: 'bottle.png', mimeType: 'image/png', buffer: png(320) });
    await expect(page.locator('li[data-status="ready"]')).toBeVisible();
    await press(page.getByRole('button', { name: 'Describe this image' }));
    await expect(page.getByTestId('analysis-result')).toContainText(ANALYSIS);
    await press(page.getByRole('button', { name: 'Use as product description' }));
    await press(page.getByRole('button', { name: /Next: Audience/ }));
    await heading(page, 'Audience and direction');
    await page.getByRole('spinbutton', { name: /Age from/ }).focus();
    await page.keyboard.type('35');
    await page.keyboard.press('Tab');
    await page.keyboard.type('52');
    await press(page.getByRole('radio', { name: 'Awareness' }), 'Space');
    await expect(page.getByRole('radio', { name: 'Awareness' })).toBeChecked();
    await press(
      page
        .getByRole('radiogroup', { name: 'Segments' })
        .getByRole('radio', { name: '2', exact: true }),
      'Space',
    );
    await expect(page.getByTestId('segments-total')).toContainText('2 segments');
    await press(page.getByRole('button', { name: /Next: Concept and script/ }));
    await heading(page, 'Concept and script');
    await page.getByRole('textbox', { name: /Concept/ }).focus();
    await page.keyboard.type(CONCEPT);
    await press(page.getByRole('button', { name: 'Generate brief' }));
    await page
      .waitForURL(/\/campaigns\/[0-9a-f-]{36}\/brief/, { timeout: 30_000 })
      .catch((error: unknown) => {
        throw new Error(`${String(error)}\n${session.errors.join('\n')}`);
      });
    await expect(page.getByRole('heading', { level: 1, name: PRODUCT })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept brief' })).toBeVisible({
      timeout: 60_000,
    });
    expect(
      session.calls.some((c) => c.startsWith('POST /drafts/') && c.endsWith('/submit 202')),
    ).toBe(true);
  });
});

test.describe('@TASK-104 FLOW-01 screen to screen mismatches', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // MISMATCH FLOW01-F2 (SCREEN-006 steps 3 and 4 against API-024): the api refuses to submit a draft without
  // `direction.segmentCount`, step 3 lets the person leave without choosing it, and step 4 maps the refusal to no
  // control, so the person sees "Check the highlighted fields and try again" with nothing highlighted. Expected to fail
  // until the owner (TASK-089/TASK-091) requires it on step 3 or names the field and step on step 4.
  test('Generate brief without choosing the segments tells the person what is missing', async ({
    page,
    context,
    baseURL,
  }) => {
    test.fail(
      true,
      'FLOW01-F2: the api needs the segment count, the wizard neither asks for it on step 3 nor names it on step 4',
    );
    await provider('ok');
    const session = await signIn(context, page, baseURL!);
    await openStep2(page);
    await fillProduct(page);
    await page.getByRole('button', { name: /Next: Audience/ }).click();
    await page.getByRole('button', { name: /Next: Concept and script/ }).click();
    await heading(page, 'Concept and script');
    await page.getByRole('textbox', { name: /Concept/ }).fill(CONCEPT);
    await page.getByRole('button', { name: 'Generate brief' }).click();
    await expect
      .poll(() =>
        session.errors.some(
          (e) => e.startsWith('POST /drafts/') && e.includes('direction.segmentCount'),
        ),
      )
      .toBe(true);
    await expect(
      page
        .getByRole('alert')
        .getByText(/segment/i)
        .first(),
    ).toBeVisible({ timeout: 3000 });
  });
});

test.describe('@TASK-104 FLOW-01 api conformance', () => {
  // MISMATCH FLOW01-F1: the generated client (packages/contracts/src/http.ts, TASK-019) sends `credentials: 'include'`;
  // the api (platform/http/cors.ts, TASK-023) is configured "no credentials mode" and so answers no
  // Access-Control-Allow-Credentials, which makes a browser refuse every response. The other tests add the header at the
  // network layer to prove the rest of the flow; this one runs without it and is expected to fail until the owner fixes
  // one side. When it starts passing, remove `test.fail` and the workaround in support.ts.
  test('a browser call from the web origin with credentials mode include is accepted by the api CORS policy', async ({
    baseURL,
  }) => {
    test.fail(
      true,
      'FLOW01-F1: contracts http.ts uses credentials include; the api CORS has credentials false',
    );
    const response = await fetch(`${API()}/api/v1/drafts`, {
      method: 'OPTIONS',
      headers: {
        origin: baseURL!,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
