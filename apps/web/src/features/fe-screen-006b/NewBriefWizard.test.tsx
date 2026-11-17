// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { NewBriefWizard, type NewBriefWizardProps } from './NewBriefWizard';
import { SCREEN_006B_COPY as COPY } from './copy';
import { EMPTY_VALUES, toWrite, validateStep, valuesFromDraft } from './draft';
import { rejectText } from './ProductImage';

const ORIGIN = 'http://api.test';
const BASE = `${ORIGIN}/api/v1`;
const ID = '8f3a0000-0000-4000-8000-00000000d001';
const MEDIA = '8f3a0000-0000-4000-8000-00000000e001';
const CAMPAIGN = '8f3a0000-0000-4000-8000-00000000c001';
const meta = { requestId: 'req-1', timestamp: '2026-11-16T09:00:00Z' };

const draft = (over: Record<string, unknown> = {}) => ({
  id: ID,
  version: 1,
  step: 2,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: 'Morning Focus Blend',
  productDescription: 'Capsules for a steady start.',
  audience: null,
  direction: null,
  concept: null,
  script: null,
  productMediaId: null,
  campaignId: null,
  durationSeconds: null,
  createdAt: '2026-11-16T08:00:00Z',
  updatedAt: '2026-11-16T08:00:00Z',
  ...over,
});
const ok = (data: unknown, status = 200) =>
  HttpResponse.json(
    { success: true, data, metaData: meta },
    { status, headers: { ETag: `"${String((data as { version?: number }).version ?? 1)}"` } },
  );
const failure = (status: number, code: string, message = 'Refused.') =>
  HttpResponse.json(
    { success: false, error: { code, message, details: [] }, metaData: meta },
    { status },
  );
const media = (over: Record<string, unknown> = {}) => ({
  id: MEDIA,
  kind: 'upload',
  state: 'ready',
  contentType: 'image/png',
  bytes: 2048,
  width: 400,
  height: 400,
  rejectReason: null,
  attached: false,
  campaignId: null,
  createdAt: '2026-11-16T09:00:00Z',
  ...over,
});
const job = (state: string, over: Record<string, unknown> = {}) => ({
  id: '8f3a0000-0000-4000-8000-00000000b001',
  state,
  label: 'image_analysis',
  causeClass: null,
  causeMessage: null,
  createdAt: '2026-11-16T09:00:00Z',
  updatedAt: '2026-11-16T09:00:00Z',
  reused: false,
  ...over,
});

let uninstall: () => void;
beforeEach(() => {
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(null) });
  window.history.replaceState(null, '', '/campaigns/new');
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.restoreAllMocks();
});

const show = (props: NewBriefWizardProps = {}) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <NewBriefWizard {...props} />
    </QueryClientProvider>,
  );
const resume = (over: Record<string, unknown> = {}) =>
  server.use(http.get(`${BASE}/drafts/${ID}`, () => ok(draft(over))));
const png = (name = 'blend.png', type = 'image/png', size = 2048) =>
  new File([new Uint8Array(size)], name, { type });
const choose = (file: File) =>
  fireEvent.change(screen.getByTestId('file-upload-input'), { target: { files: [file] } });
const patches: Record<string, unknown>[] = [];
const saving = () =>
  server.use(
    http.patch(`${BASE}/drafts/${ID}`, async ({ request }) => {
      patches.push((await request.json()) as Record<string, unknown>);
      return ok(draft({ version: patches.length + 1 }));
    }),
  );

describe('SCREEN-006 step 2 product image', () => {
  beforeEach(() => {
    patches.length = 0;
    saving();
  });

  it('shows the likeness consent text and the file limits', async () => {
    resume();
    show({ draftId: ID });
    expect(
      await screen.findByRole('heading', { level: 2, name: COPY.step2.title }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('likeness-consent')).toHaveTextContent('likeness');
    expect(screen.getByText(/up to 10 MB/)).toBeInTheDocument();
  });

  it('uploads (API-030), polls processing then ready (API-031) and attaches the image to the draft', async () => {
    resume();
    let polls = 0;
    let contentType: string | null = null;
    server.use(
      http.post(`${BASE}/media`, ({ request }) => {
        contentType = request.headers.get('content-type');
        return ok(media({ state: 'processing' }), 201);
      }),
      http.get(`${BASE}/media/${MEDIA}`, () =>
        ok(media({ state: (polls += 1) < 2 ? 'processing' : 'ready' })),
      ),
      http.get(`${BASE}/media/${MEDIA}/analysis`, () =>
        ok({ job: null, productDescription: null }),
      ),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    choose(png());
    await waitFor(() =>
      expect(document.querySelector('li[data-status="processing"]')).not.toBeNull(),
    );
    await waitFor(() => expect(document.querySelector('li[data-status="ready"]')).not.toBeNull(), {
      timeout: 5000,
    });
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    await waitFor(() => expect(patches.some((p) => p.productMediaId === MEDIA)).toBe(true), {
      timeout: 4000,
    });
  });

  it('shows the worker reject reason (API-031 rejected)', async () => {
    resume();
    server.use(
      http.post(`${BASE}/media`, () => ok(media({ state: 'processing' }), 201)),
      http.get(`${BASE}/media/${MEDIA}`, () =>
        ok(media({ state: 'rejected', rejectReason: 'decode_failed' })),
      ),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    choose(png());
    expect(await screen.findByText(COPY.step2.rejected.decode_failed)).toBeInTheDocument();
    expect(patches.some((p) => p.productMediaId === MEDIA)).toBe(false);
  });

  it.each([
    ['payload_too_large', 413, 'This file is too large. Choose a smaller file.'],
    ['unsupported_media_type', 415, 'This file type is not supported. Use JPEG, PNG, WebP or GIF.'],
    ['storage_quota_reached', 422, 'Your storage limit is full.'],
  ])('upload answer %s shows its copy on the file row', async (code, status, text) => {
    resume();
    server.use(http.post(`${BASE}/media`, () => failure(status, code, '')));
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    choose(png());
    expect(
      (await screen.findAllByText(new RegExp(text.replace('.', '\\.')))).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a wrong type or an oversized file before any call', async () => {
    resume();
    const posted = vi.fn();
    server.use(http.post(`${BASE}/media`, () => (posted(), failure(500, 'internal_error'))));
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    choose(png('notes.pdf', 'application/pdf'));
    expect((await screen.findAllByText(/Not supported/)).length).toBeGreaterThan(0);
    choose(png('big.png', 'image/png', 10 * 1024 * 1024 + 1));
    expect((await screen.findAllByText(/Too large/)).length).toBeGreaterThan(0);
    expect(posted).not.toHaveBeenCalled();
  });

  it('analyses a ready image (API-035, 036) and copies the product description on request', async () => {
    resume({ productMediaId: MEDIA });
    let keyHeader: string | null = null;
    let reads = 0;
    server.use(
      http.get(`${BASE}/media/${MEDIA}`, () => ok(media())),
      http.get(`${BASE}/media/${MEDIA}/analysis`, () =>
        reads++ === 0
          ? ok({ job: null, productDescription: null })
          : ok({
              job: job('completed'),
              productDescription: 'A bottle of 60 amber capsules with a green label.',
            }),
      ),
      http.post(`${BASE}/media/${MEDIA}/analysis`, ({ request }) => {
        keyHeader = request.headers.get('Idempotency-Key');
        return ok({ job: job('pending'), productDescription: null }, 202);
      }),
    );
    show({ draftId: ID });
    fireEvent.click(await screen.findByRole('button', { name: COPY.step2.analyse }));
    const result = await screen.findByTestId('analysis-result', undefined, { timeout: 5000 });
    expect(result).toHaveTextContent('A bottle of 60 amber capsules');
    expect(keyHeader).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole('button', { name: COPY.step2.analysisUse }));
    expect(screen.getByRole('textbox', { name: /Product description/ })).toHaveValue(
      'A bottle of 60 amber capsules with a green label.',
    );
  });

  it('key_missing on the analysis explains it and offers the provider keys', async () => {
    resume({ productMediaId: MEDIA });
    server.use(
      http.get(`${BASE}/media/${MEDIA}`, () => ok(media())),
      http.get(`${BASE}/media/${MEDIA}/analysis`, () =>
        ok({ job: null, productDescription: null }),
      ),
      http.post(`${BASE}/media/${MEDIA}/analysis`, () => failure(422, 'key_missing')),
    );
    show({ draftId: ID });
    fireEvent.click(await screen.findByRole('button', { name: COPY.step2.analyse }));
    expect(
      await screen.findByText('Add your provider key to continue. Your work is saved.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add provider key' })).toHaveAttribute(
      'href',
      '/settings/provider-keys',
    );
  });

  it('a failed analysis job says so and leaves the description alone', async () => {
    resume({ productMediaId: MEDIA });
    server.use(
      http.get(`${BASE}/media/${MEDIA}`, () => ok(media())),
      http.get(`${BASE}/media/${MEDIA}/analysis`, () =>
        ok({
          job: job('failed', { causeMessage: 'The provider could not read the image.' }),
          productDescription: null,
        }),
      ),
    );
    show({ draftId: ID });
    expect(await screen.findByText('The provider could not read the image.')).toBeInTheDocument();
  });

  it('a resumed draft with its image does not write the draft again', async () => {
    resume({ productMediaId: MEDIA });
    server.use(
      http.get(`${BASE}/media/${MEDIA}`, () => ok(media())),
      http.get(`${BASE}/media/${MEDIA}/analysis`, () =>
        ok({ job: null, productDescription: null }),
      ),
    );
    show({ draftId: ID });
    await waitFor(() => expect(document.querySelector('li[data-status="ready"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 1200));
    expect(patches).toHaveLength(0);
  });

  it('removing the image clears it from the draft', async () => {
    resume({ productMediaId: MEDIA });
    server.use(
      http.get(`${BASE}/media/${MEDIA}`, () => ok(media())),
      http.get(`${BASE}/media/${MEDIA}/analysis`, () =>
        ok({ job: null, productDescription: null }),
      ),
    );
    show({ draftId: ID });
    fireEvent.click(await screen.findByRole('button', { name: /Remove Product image/ }));
    await waitFor(() => expect(patches.some((p) => p.productMediaId === null)).toBe(true), {
      timeout: 4000,
    });
  });

  it('Next waits while the image is processing', async () => {
    resume();
    server.use(
      http.post(`${BASE}/media`, () => ok(media({ state: 'processing' }), 201)),
      http.get(`${BASE}/media/${MEDIA}`, () => ok(media({ state: 'processing' }))),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    choose(png());
    await waitFor(() =>
      expect(document.querySelector('li[data-status="processing"]')).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Next: Audience/ }));
    expect(
      await screen.findByRole('group', { name: 'Fix 1 thing to continue' }),
    ).toBeInTheDocument();
  });
});

describe('SCREEN-006 step 4 review and generate', () => {
  beforeEach(() => {
    patches.length = 0;
    saving();
  });
  const atStep4 = (over: Record<string, unknown> = {}) =>
    resume({
      step: 4,
      productMediaId: MEDIA,
      concept: 'A calm morning routine.',
      direction: { goal: 'awareness', segmentCount: 2 },
      ...over,
    });
  const generate = () => fireEvent.click(screen.getByRole('button', { name: COPY.step4.generate }));

  it('shows the summary and requires the concept before it submits', async () => {
    atStep4({ concept: null });
    const submitted = vi.fn();
    server.use(
      http.post(`${BASE}/drafts/${ID}/submit`, () => (submitted(), failure(500, 'internal_error'))),
    );
    show({ draftId: ID });
    expect(
      await screen.findByRole('heading', { level: 2, name: COPY.step4.title }),
    ).toBeInTheDocument();
    generate();
    expect(
      await screen.findByRole('group', { name: 'Fix 1 thing to continue' }),
    ).toBeInTheDocument();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('script mode asks for the script', async () => {
    atStep4({ intakeMode: 'script', concept: null, script: null });
    show({ draftId: ID });
    expect(await screen.findByLabelText(/Script/)).toBeInTheDocument();
  });

  it('saves step 4, submits with an Idempotency-Key (API-024), shows in progress and opens the brief', async () => {
    atStep4();
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);
    let key: string | null = null;
    server.use(
      http.post(`${BASE}/drafts/${ID}/submit`, ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        return HttpResponse.json(
          {
            success: true,
            data: { campaignId: CAMPAIGN, briefJob: job('pending', { label: 'brief_generation' }) },
            metaData: meta,
          },
          { status: 202 },
        );
      }),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step4.title });
    generate();
    expect(await screen.findByTestId('generating-status')).toHaveTextContent('in progress');
    expect(screen.getByRole('button', { name: /Generating…/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/campaigns/${CAMPAIGN}/brief`));
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(patches.at(-1)).toMatchObject({
      step: 4,
      concept: 'A calm morning routine.',
      productMediaId: MEDIA,
    });
  });

  it.each([
    ['key_missing', 'Add your OpenAI key to generate the brief'],
    ['spend_cap_reached', 'Daily spend limit reached'],
  ])('%s blocks Generate with an explanation', async (code, title) => {
    atStep4();
    server.use(http.post(`${BASE}/drafts/${ID}/submit`, () => failure(422, code)));
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step4.title });
    generate();
    expect(await screen.findByText(title)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: COPY.step4.generate })).toBeDisabled(),
    );
  });

  it('media_not_ready offers Try again', async () => {
    atStep4();
    server.use(http.post(`${BASE}/drafts/${ID}/submit`, () => failure(422, 'media_not_ready')));
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step4.title });
    generate();
    expect(
      await screen.findByText('The image is still being processed. Wait a moment and try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('previews the blocks in the test build', async () => {
    atStep4();
    show({ draftId: ID, initialBlock: 'key_missing' });
    expect(
      await screen.findByText('Add your OpenAI key to generate the brief'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY.step4.generate })).toBeDisabled();
  });
});

describe('draft helpers', () => {
  it('carries the image, concept and script in the write body and back', () => {
    const values = valuesFromDraft(
      draft({ productMediaId: MEDIA, concept: 'c', script: 's' }) as never,
    );
    expect(values).toMatchObject({ productMediaId: MEDIA, concept: 'c', script: 's' });
    expect(toWrite(values, 4)).toMatchObject({
      step: 4,
      productMediaId: MEDIA,
      concept: 'c',
      script: 's',
    });
    expect(toWrite(EMPTY_VALUES, 2)).toMatchObject({
      productMediaId: null,
      concept: null,
      script: null,
    });
  });
  it('validates step 4 by intake mode and length', () => {
    const seg = { ...EMPTY_VALUES, segmentCount: '2' as const };
    expect(validateStep(4, EMPTY_VALUES).map((p) => p.id)).toEqual([
      'draft-segments',
      'draft-concept',
    ]);
    expect(validateStep(4, seg)).toHaveLength(1);
    expect(validateStep(4, { ...seg, intakeMode: 'script' })[0]?.id).toBe('draft-script');
    expect(validateStep(4, { ...seg, concept: 'x'.repeat(4001) })[0]?.message).toBe(
      COPY.step4.long,
    );
    expect(validateStep(4, { ...seg, concept: 'ok' })).toHaveLength(0);
    expect(
      validateStep(2, { ...EMPTY_VALUES, productName: 'a', productDescription: 'b' }, true)[0]?.id,
    ).toBe('draft-product-image');
  });
  it('maps every reject reason and falls back', () => {
    expect(rejectText('type_not_allowed')).toBe(COPY.step2.rejected.type_not_allowed);
    expect(rejectText('pixel_cap_exceeded')).toBe(COPY.step2.rejected.pixel_cap_exceeded);
    expect(rejectText('decompression_bomb')).toBe(COPY.step2.rejected.decompression_bomb);
    expect(rejectText(null)).toBe(COPY.step2.rejectedFallback);
  });
});

describe('SCREEN-006 step 4 names a missing segment count (F2)', () => {
  it('Generate brief on a draft without segmentCount returns to step 3 and names it', async () => {
    resume({ step: 4, concept: 'A calm morning routine.', direction: { goal: 'awareness' } });
    const submitted = vi.fn();
    server.use(http.post(`${BASE}/drafts/${ID}/submit`, () => (submitted(), failure(500, 'x'))));
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step4.title });
    fireEvent.click(screen.getByRole('button', { name: COPY.step4.generate }));
    expect(
      await screen.findByRole('heading', { level: 2, name: COPY.step3.title }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText(COPY.step3.segmentsRequired)).length).toBeGreaterThan(0);
    expect(submitted).not.toHaveBeenCalled();
  });
});
