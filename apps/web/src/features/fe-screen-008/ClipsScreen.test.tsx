// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { ClipsScreen, cardState } from './ClipsScreen';
import {
  CAMPAIGN_ID,
  campaignFixture,
  emptyList,
  item,
  jobId,
  meta,
  mixedList,
  outOfDateList,
  qcList,
  unknownOutcomeList,
  videoJob,
} from './fixtures';

const ORIGIN = 'http://api.test';
const BASE = `${ORIGIN}/api/v1`;
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, metaData: meta }, { status });
const failure = (status: number, code: string, message = 'x') =>
  HttpResponse.json(
    { success: false, error: { code, message, details: [] }, metaData: meta },
    { status },
  );
const keyRow = (provider: string, configured = true, status: string | null = 'active') => ({
  provider,
  configured,
  status: configured ? status : null,
  last4: null,
  fingerprint: null,
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastValidatedAt: null,
  inFlightJobCount: 0,
});

let uninstall: () => void;
let calls: { path: string; key: string | null }[];
beforeEach(() => {
  calls = [];
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(null) });
  server.use(
    http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () => ok(campaignFixture())),
    http.get(`${BASE}/me/provider-keys`, () => ok([keyRow('openai'), keyRow('wavespeed')])),
    http.get(`${BASE}/media/:id/url`, () => ok({ url: 'http://media.test/clip.mp4' })),
  );
});
afterEach(() => {
  cleanup();
  uninstall();
});

const serve = (list: unknown) =>
  server.use(http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => ok(list)));
const record = (method: 'post', pattern: string, respond: () => Response) =>
  server.use(
    http[method](`${BASE}${pattern}`, ({ request }) => {
      calls.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
      });
      return respond();
    }),
  );
const show = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ClipsScreen campaignId={CAMPAIGN_ID} />
    </QueryClientProvider>,
  );

describe('SCREEN-008 clips (TASK-095)', () => {
  it('loading: busy status in the final layout', async () => {
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => new Promise(() => undefined)),
    );
    show();
    expect(await screen.findByText('Loading the clips')).toBeInTheDocument();
    expect(document.querySelector('[data-screen=SCREEN-008]')).toHaveAttribute('aria-busy', 'true');
  });

  it('default: a card per segment with Generate named by segment; stage tabs mark Clips', async () => {
    serve(emptyList());
    show();
    expect(await screen.findByRole('article', { name: 'Segment 1 clip' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Generate segment 2' })).toBeEnabled();
    const tabs = within(screen.getByRole('tablist', { name: 'Campaign stages' })).getAllByRole(
      'tab',
    );
    expect(tabs.map((t) => [t.textContent?.trim(), t.getAttribute('aria-selected')])).toEqual([
      ['1 Brief', 'false'],
      ['2 Clips', 'true'],
      ['3 Final', 'false'],
    ]);
    expect(tabs[2]).toHaveAttribute('aria-disabled', 'true');
  });

  it('Generate sends API-060 with an Idempotency-Key and the list refreshes', async () => {
    serve(emptyList());
    record('post', '/campaigns/:id/segments/:pos/jobs', () =>
      ok(
        videoJob(2, {
          state: 'processing',
          label: 'processing',
          outputMediaId: null,
          latestQc: null,
        }),
        202,
      ),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate segment 2' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.path).toBe(`/api/v1/campaigns/${CAMPAIGN_ID}/segments/2/jobs`);
    expect(calls[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    await screen.findByText('Segment 2 clip started.');
  });

  it('mixed states: completed with check, processing, failed temporary with Retry', async () => {
    serve(mixedList());
    show();
    const one = await screen.findByRole('article', { name: 'Segment 1 clip' });
    expect(within(one).getByText('Check passed')).toBeInTheDocument();
    expect(within(one).getByRole('button', { name: 'Re-run check segment 1' })).toBeEnabled();
    expect(await within(one).findByLabelText('Clip for segment 1')).toHaveAttribute(
      'src',
      'http://media.test/clip.mp4',
    );
    expect(screen.getByRole('article', { name: 'Segment 2 clip' })).toHaveAttribute(
      'data-state',
      'processing',
    );
    const three = screen.getByRole('article', { name: 'Segment 3 clip' });
    expect(three).toHaveAttribute('data-cause', 'temporary');
    expect(screen.getByText('The provider was busy. Nothing was charged.')).toBeInTheDocument();
    record('post', '/video-jobs/:id/retry', () =>
      ok(
        videoJob(3, { state: 'pending', label: 'pending', outputMediaId: null, latestQc: null }),
        202,
      ),
    );
    fireEvent.click(within(three).getByRole('button', { name: 'Retry segment 3' }));
    await waitFor(() =>
      expect(calls.map((c) => c.path)).toEqual([`/api/v1/video-jobs/${jobId(3)}/retry`]),
    );
  });

  it('failures: outcome unknown says to check the provider account and offers no Retry', async () => {
    serve(unknownOutcomeList());
    show();
    const one = await screen.findByRole('article', { name: 'Segment 1 clip' });
    expect(one).toHaveAttribute('data-cause', 'unknown');
    expect(
      within(one).getByText(/Check your provider account before retrying/),
    ).toBeInTheDocument();
    expect(within(one).queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('qc-review: failed and skipped checks show their reason', async () => {
    serve(qcList());
    show();
    const one = await screen.findByRole('article', { name: 'Segment 1 clip' });
    expect(within(one).getByText('Check failed')).toBeInTheDocument();
    expect(within(one).getByText(/Spoken words differ/)).toBeInTheDocument();
    const two = screen.getByRole('article', { name: 'Segment 2 clip' });
    expect(within(two).getByText('Check skipped')).toBeInTheDocument();
    expect(within(two).getByText(/transcription service was unavailable/)).toBeInTheDocument();
  });

  it('Re-run check sends API-064', async () => {
    serve(qcList());
    record('post', '/video-jobs/:id/qc', () => ok({}, 202));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run check segment 1' }));
    await waitFor(() => expect(calls[0]?.path).toBe(`/api/v1/video-jobs/${jobId(1)}/qc`));
  });

  it('out-of-date: the clip is marked and offers Generate again', async () => {
    serve(outOfDateList());
    show();
    const mark = await screen.findByTestId('out-of-date-1');
    expect(within(mark).getByText('Out of date')).toBeInTheDocument();
    record('post', '/campaigns/:id/segments/:pos/jobs', () => ok(videoJob(1), 202));
    fireEvent.click(within(mark).getByRole('button', { name: 'Generate again, segment 1' }));
    await waitFor(() => expect(calls[0]?.path).toMatch(/segments\/1\/jobs$/));
  });

  it('blocked: brief not accepted disables Generate and links to the brief', async () => {
    serve(emptyList());
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () =>
        ok(campaignFixture({ briefState: 'draft' })),
      ),
    );
    show();
    expect(
      await screen.findByText('Accept the brief before you generate clips.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the brief' })).toHaveAttribute(
      'href',
      `/campaigns/${CAMPAIGN_ID}/brief`,
    );
    expect(screen.getByRole('button', { name: 'Generate segment 1' })).toBeDisabled();
  });

  it('blocked: key missing and key disabled from the key list', async () => {
    serve(emptyList());
    server.use(
      http.get(`${BASE}/me/provider-keys`, () =>
        ok([keyRow('openai'), keyRow('wavespeed', false)]),
      ),
    );
    show();
    expect(
      await screen.findByText('Add your provider key to continue. Your work is saved.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate segment 1' })).toBeDisabled();
    cleanup();
    server.use(
      http.get(`${BASE}/me/provider-keys`, () =>
        ok([keyRow('openai'), keyRow('wavespeed', true, 'disabled')]),
      ),
    );
    show();
    expect(
      await screen.findByText(
        'Your provider key was disabled after repeated failures. Replace it to continue.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Replace key' })).toHaveAttribute(
      'href',
      '/settings/provider-keys',
    );
  });

  it('cap-reached: the server message is shown and every action stays disabled', async () => {
    serve(qcList());
    record('post', '/campaigns/:id/segments/:pos/jobs', () =>
      failure(422, 'spend_cap_reached', 'Your daily limit of 5.00 USD is reached.'),
    );
    serve(emptyList());
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate segment 1' }));
    expect(await screen.findByText(/Your daily limit of 5.00 USD is reached/)).toBeInTheDocument();
    expect(screen.getByText(/A usage limit has been reached/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate segment 2' })).toBeDisabled();
  });

  it('state_conflict: the alert offers Refresh, which reloads the list', async () => {
    let reads = 0;
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => {
        reads += 1;
        return ok(mixedList());
      }),
    );
    record('post', '/video-jobs/:id/retry', () => failure(409, 'state_conflict'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry segment 3' }));
    expect(await screen.findByText(/This cannot be done in its current state/)).toBeInTheDocument();
    const before = reads;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText(/current state/)).toBeNull());
  });

  it('a failed refresh keeps the clips on screen and adds the alert', async () => {
    let n = 0;
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => {
        n += 1;
        return n === 1 ? ok(qcList()) : failure(500, 'internal_error');
      }),
    );
    record('post', '/video-jobs/:id/qc', () => ok({}, 202));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run check segment 1' }));
    await screen.findByText(/Something went wrong on our side/, {}, { timeout: 15_000 });
    expect(screen.getAllByRole('article')).toHaveLength(3);
  }, 20_000);

  it('maps API states to job states and failure classes', () => {
    const f = (causeClass: string) =>
      cardState(videoJob(1, { state: 'failed', label: 'failed', causeClass: causeClass as never }));
    expect(f('credit')).toEqual({ state: 'failed', cause: 'configuration' });
    expect(f('provider_timeout')).toEqual({ state: 'failed', cause: 'temporary' });
    expect(f('outcome_unknown')).toEqual({ state: 'failed', cause: 'unknown' });
    expect(cardState(null)).toEqual({ state: 'pending' });
    expect(cardState(videoJob(1, { state: 'submitting', label: 'queued' }))).toEqual({
      state: 'created',
    });
    expect(item(1, null).latestJob).toBeNull();
  });
});
