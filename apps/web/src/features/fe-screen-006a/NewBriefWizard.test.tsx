// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { NewBriefWizard, type NewBriefWizardProps } from './NewBriefWizard';
import { SCREEN_006_COPY as COPY } from './copy';
import { clampStep, etagOf, toWrite, validateStep, valuesFromDraft, EMPTY_VALUES } from './draft';

const ORIGIN = 'http://api.test';
const BASE = `${ORIGIN}/api/v1`;
const ID = '8f3a0000-0000-4000-8000-00000000d001';
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
const ok = (
  data: unknown,
  status = 200,
  etag = `"${String((data as { version: number }).version)}"`,
) =>
  HttpResponse.json({ success: true, data, metaData: meta }, { status, headers: { ETag: etag } });
const failure = (status: number, code: string, details: unknown[] = []) =>
  HttpResponse.json(
    { success: false, error: { code, message: 'Refused.', details }, metaData: meta },
    { status },
  );

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
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const resume = (over: Record<string, unknown> = {}) =>
  server.use(http.get(`${BASE}/drafts/${ID}`, () => ok(draft(over))));
const next = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('SCREEN-006 steps 1 to 3', () => {
  it('step 1: UGC and the intake mode; Animated is unavailable; no draft call before an edit', async () => {
    show();
    expect(screen.getByRole('heading', { level: 1, name: 'New brief' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: COPY.step1.title })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /UGC ad/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Animated/ })).toBeDisabled();
    expect(screen.getByText('Not in this release')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Describe the idea/ })).toBeChecked();
    expect(screen.getByRole('list', { name: 'Progress' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
  });

  it('first Next creates the draft (API-021) and puts its id in the URL; the header says Saved', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE}/drafts`, async ({ request }) => {
        bodies.push(await request.json());
        return ok(draft({ step: 2, productName: null, productDescription: null }), 201);
      }),
    );
    show();
    fireEvent.click(screen.getByRole('radio', { name: /Paste a script/ }));
    next(/Next: Product/);
    expect(
      await screen.findByRole('heading', { level: 2, name: COPY.step2.title }),
    ).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({
      step: 2,
      adStyle: 'ugc',
      intakeMode: 'script',
      productName: null,
      audience: null,
    });
    expect(window.location.search).toBe(`?draft=${ID}`);
    expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved just now');
    expect(screen.getByRole('heading', { level: 2, name: COPY.step2.title })).toHaveFocus();
  });

  it('autosaves an edit with the version in If-Match and shows Saving then Saved', async () => {
    resume();
    const seen: { match: string | null; body: unknown }[] = [];
    server.use(
      http.patch(`${BASE}/drafts/${ID}`, async ({ request }) => {
        seen.push({ match: request.headers.get('If-Match'), body: await request.json() });
        return ok(draft({ version: 2, productName: 'Evening Calm' }));
      }),
    );
    show({ draftId: ID });
    expect(
      await screen.findByRole('heading', { level: 2, name: COPY.step2.title }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved');
    type(/Product name/, 'Evening Calm');
    await waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    expect(seen[0]!.match).toBe('"1"');
    expect(seen[0]!.body).toMatchObject({ step: 2, productName: 'Evening Calm' });
    await waitFor(() =>
      expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved just now'),
    );
  });

  it('validation-error: a summary lists both fields, takes focus, links focus the field, input is kept', async () => {
    resume({ productName: null, productDescription: null });
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    next(/Next: Audience/);
    const summary = await screen.findByRole('group', { name: 'Fix 2 things to continue' });
    expect(summary).toHaveFocus();
    expect(screen.getByText('Enter the product name.', { selector: 'p span' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Product name/)).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('link', { name: 'Product description' }));
    expect(screen.getByLabelText(/Product description/)).toHaveFocus();
    type(/Product name/, 'Calm');
    expect(screen.queryByText('Enter the product name.', { selector: 'p span' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Fix 1 thing to continue' })).toBeInTheDocument();
  });

  it('a server validation_failed maps its details to the fields and keeps the values', async () => {
    resume();
    server.use(
      http.patch(`${BASE}/drafts/${ID}`, () =>
        failure(400, 'validation_failed', [
          { field: 'productName', code: 'too_long', message: 'Shorten the product name.' },
        ]),
      ),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    next(/Next: Audience/);
    expect(await screen.findByRole('group', { name: 'Fix 1 thing to continue' })).toHaveFocus();
    expect(screen.getAllByText('Shorten the product name.').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Product name/)).toHaveValue('Morning Focus Blend');
    expect(screen.getByRole('heading', { level: 2, name: COPY.step2.title })).toBeInTheDocument();
  });

  it('step 3: segments show segments × 15 s; age order is checked; the draft is saved with audience and direction', async () => {
    resume({ step: 3 });
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.patch(`${BASE}/drafts/${ID}`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return ok(draft({ version: 2, step: 4 }));
      }),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step3.title });
    fireEvent.click(screen.getByRole('radio', { name: '3' }));
    expect(screen.getByTestId('segments-total')).toHaveTextContent(
      '3 segments × 15 s = 45 s total',
    );
    fireEvent.click(screen.getByRole('radio', { name: '1' }));
    expect(screen.getByTestId('segments-total')).toHaveTextContent('1 segment × 15 s = 15 s total');
    type('Age from', '40');
    type('Age to', '30');
    next(/Next: Concept/);
    expect(
      await screen.findByText(COPY.step3.ageOrder, { selector: 'p span' }),
    ).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
    type('Age to', '52');
    type('Interests', 'trail running, nootropics');
    fireEvent.click(screen.getByRole('radio', { name: 'Conversion' }));
    type('Tone', 'Calm and grounded');
    next(/Next: Concept/);
    expect(
      await screen.findByRole('heading', { level: 2, name: COPY.step4.title }),
    ).toBeInTheDocument();
    const last = bodies.at(-1)!;
    expect(last).toMatchObject({
      step: 4,
      audience: { ageMin: 40, ageMax: 52, interests: ['trail running', 'nootropics'] },
      direction: { goal: 'conversion', tone: 'Calm and grounded', segmentCount: 1 },
    });
    expect(screen.getByRole('button', { name: COPY.step4.generate })).toBeDisabled();
  });

  it('step 3: leaving without a segment count names it and does not save (F2)', async () => {
    resume({ step: 3 });
    const bodies: unknown[] = [];
    server.use(
      http.patch(`${BASE}/drafts/${ID}`, async ({ request }) => {
        bodies.push(await request.json());
        return ok(draft({ version: 2, step: 4 }));
      }),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step3.title });
    next(/Next: Concept/);
    expect((await screen.findAllByText(COPY.step3.segmentsRequired)).length).toBeGreaterThan(0);
    expect(bodies).toHaveLength(0);
    fireEvent.click(screen.getByRole('radio', { name: '2' }));
    expect(screen.queryByText(COPY.step3.segmentsRequired)).toBeNull();
  });

  it('saving: the button and the header show progress while the save is in flight', async () => {
    resume();
    server.use(http.patch(`${BASE}/drafts/${ID}`, () => new Promise(() => undefined)));
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    next(/Next: Audience/);
    expect(await screen.findByRole('button', { name: /Saving…/ })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByTestId('save-status')).toHaveTextContent('Saving draft…');
  });

  it('a failed save keeps the values and offers Try again that saves them', async () => {
    resume();
    let calls = 0;
    server.use(
      http.patch(`${BASE}/drafts/${ID}`, () => {
        calls += 1;
        return calls === 1 ? failure(500, 'internal_error') : ok(draft({ version: 2 }));
      }),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    next(/Next: Audience/);
    const retry = await screen.findByRole('button', { name: /Try again/ });
    expect(screen.getByLabelText(/Product name/)).toHaveValue('Morning Focus Blend');
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 8000 });
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByTestId('save-status')).toHaveTextContent('Draft saved just now'),
    );
    expect(calls).toBe(2);
  });

  it('conflict: nothing is overwritten and Reload latest version shows the other tab’s values', async () => {
    resume();
    server.use(http.patch(`${BASE}/drafts/${ID}`, () => failure(409, 'version_conflict')));
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    type(/Product name/, 'Mine');
    expect(await screen.findByText(COPY.conflictTitle, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next: Audience/ })).toBeDisabled();
    server.use(
      http.get(`${BASE}/drafts/${ID}`, () => ok(draft({ version: 3, productName: 'Theirs' }))),
    );
    fireEvent.click(screen.getByRole('button', { name: COPY.conflictAction }));
    await waitFor(() => expect(screen.getByLabelText(/Product name/)).toHaveValue('Theirs'));
    expect(screen.queryByText(COPY.conflictTitle)).toBeNull();
  });

  it('session-expired: an alert dialog with one action returns to this draft through sign-in', async () => {
    resume();
    server.use(http.patch(`${BASE}/drafts/${ID}`, () => failure(401, 'unauthenticated')));
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step2.title });
    next(/Next: Audience/);
    const dialog = await screen.findByRole('alertdialog', { name: COPY.sessionTitle });
    expect(dialog).toHaveTextContent('you will return to step 2 of this draft');
    expect(screen.getByRole('button', { name: COPY.signInAgain })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: COPY.signInAgain }));
    expect(assign).toHaveBeenCalledWith(
      `/sign-in?reason=session-expired&return=${encodeURIComponent(`/campaigns/new?draft=${ID}`)}`,
    );
  });

  it('resuming a missing draft explains it; a submitted draft is read-only', async () => {
    server.use(http.get(`${BASE}/drafts/${ID}`, () => failure(404, 'not_found')));
    show({ draftId: ID });
    expect(await screen.findByText(COPY.notFoundTitle)).toBeInTheDocument();
    cleanup();
    server.use(
      http.get(`${BASE}/drafts/${ID}`, () =>
        ok(draft({ campaignId: '8f3a0000-0000-4000-8000-00000000c001' })),
      ),
    );
    show({ draftId: ID });
    expect(await screen.findByText(COPY.submittedTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next/ })).toBeNull();
  });

  it('Start over is a confirm dialog; confirming deletes the draft (API-025) and returns to a blank step 1', async () => {
    resume({ step: 1 });
    let deleted = 0;
    server.use(
      http.delete(`${BASE}/drafts/${ID}`, () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    show({ draftId: ID });
    await screen.findByRole('heading', { level: 2, name: COPY.step1.title });
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await screen.findByRole('dialog', { name: 'Start over?' });
    expect(deleted).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Start over?' })).getByRole('button', {
        name: COPY.startOverConfirm,
      }),
    );
    await waitFor(() => expect(deleted).toBe(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('');
  });

  it('key-missing and cap-reached explain on step 4 and keep the draft saved', async () => {
    resume({ step: 4 });
    show({ draftId: ID, initialBlock: 'key_missing' });
    expect(await screen.findByText(COPY.keyMissing.title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: COPY.keyMissing.action })).toHaveAttribute(
      'href',
      '/settings/provider-keys',
    );
    expect(screen.getByRole('button', { name: COPY.step4.generate })).toBeDisabled();
    cleanup();
    resume({ step: 4 });
    show({ draftId: ID, initialBlock: 'spend_cap_reached' });
    expect(await screen.findByText(COPY.capReached.title)).toBeInTheDocument();
  });
});

describe('draft model', () => {
  it('maps a draft to the form and back, clearing empty fields with null', () => {
    const values = valuesFromDraft(
      draft({
        audience: { ageMin: 30, gender: 'female', interests: ['a', 'b'] },
        direction: { goal: 'awareness', segmentCount: 2 },
      }) as never,
    );
    expect(values).toMatchObject({
      ageMin: '30',
      gender: 'female',
      interests: 'a, b',
      goal: 'awareness',
      segmentCount: '2',
    });
    expect(toWrite(EMPTY_VALUES, 1)).toMatchObject({
      productName: null,
      audience: null,
      direction: null,
    });
    expect(toWrite(values, 3)).toMatchObject({
      audience: { ageMin: 30, gender: 'female' },
      direction: { segmentCount: 2 },
    });
  });
  it('checks steps, clamps the saved step, and reads the ETag', () => {
    expect(validateStep(2, EMPTY_VALUES)).toHaveLength(2);
    const seg = { ...EMPTY_VALUES, segmentCount: '2' as const };
    expect(validateStep(3, EMPTY_VALUES)[0]?.message).toBe(COPY.step3.segmentsRequired);
    expect(validateStep(3, { ...seg, ageMin: '15' })[0]?.message).toBe(COPY.step3.ageRange);
    expect(validateStep(3, { ...seg, interests: Array(11).fill('x').join(',') })).toHaveLength(1);
    expect(clampStep(5)).toBe(4);
    expect(clampStep(0)).toBe(1);
    expect(etagOf(null, 7)).toBe('"7"');
    expect(etagOf('"9"', 7)).toBe('"9"');
  });
});
