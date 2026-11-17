// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { FinalScreen } from './FinalScreen';
import {
  ASSEMBLY_ID,
  CAMPAIGN_ID,
  assemblyFixture,
  campaignFixture,
  exceptionList,
  item,
  jobId,
  meta,
  noClipsList,
  partialList,
  passedList,
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
const keyRow = (provider: string) => ({
  provider,
  configured: true,
  status: 'active',
  last4: null,
  fingerprint: null,
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastValidatedAt: null,
  inFlightJobCount: 0,
});

let uninstall: () => void;
let posts: { body: unknown; key: string | null }[];
beforeEach(() => {
  posts = [];
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(null) });
  server.use(
    http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () => ok(campaignFixture())),
    http.get(`${BASE}/me/provider-keys`, () => ok([keyRow('openai'), keyRow('wavespeed')])),
    http.get(`${BASE}/media/:id/url`, () => ok({ url: 'http://media.test/final.mp4' })),
  );
});
afterEach(() => {
  cleanup();
  uninstall();
});

const serve = (list: unknown) =>
  server.use(http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => ok(list)));
const accept = (respond: () => Response) =>
  server.use(
    http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/assemblies`, async ({ request }) => {
      posts.push({
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      return respond();
    }),
  );
const show = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FinalScreen campaignId={CAMPAIGN_ID} />
    </QueryClientProvider>,
  );
const names = () =>
  within(screen.getByRole('list', { name: 'Clips for the final ad' }))
    .getAllByRole('checkbox')
    .map((c) => c.closest('li')!.getAttribute('data-clip'));

describe('SCREEN-009 final ad: select, order, confirm, assemble (TASK-096)', () => {
  it('loading: busy status in the final layout', async () => {
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => new Promise(() => undefined)),
    );
    show();
    expect(await screen.findByText('Loading the final ad')).toBeInTheDocument();
    expect(document.querySelector('[data-screen=SCREEN-009]')).toHaveAttribute('aria-busy', 'true');
  });

  it('no-clips: honest explanation with the way to the clips', async () => {
    serve(noClipsList());
    show();
    expect(
      await screen.findByRole('heading', { name: 'No completed clips yet' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to clips' })).toHaveAttribute(
      'href',
      `/campaigns/${CAMPAIGN_ID}/clips`,
    );
    expect(document.querySelector('[data-screen=SCREEN-009]')).toHaveAttribute(
      'data-final-state',
      'no-clips',
    );
  });

  it('only completed clips are listed; the Final tab is current', async () => {
    serve(partialList());
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    expect(names()).toEqual(['1']);
    expect(screen.getByText('1 clip · 0:15')).toBeInTheDocument();
    const tabs = within(screen.getByRole('tablist', { name: 'Campaign stages' })).getAllByRole(
      'tab',
    );
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
  });

  it('selecting: QC badges, total, warning; Move up / Move down reorder without drag', async () => {
    serve(exceptionList());
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    expect(screen.getByText('QC passed')).toBeInTheDocument();
    expect(screen.getByText('QC failed')).toBeInTheDocument();
    expect(screen.getByText('QC skipped')).toBeInTheDocument();
    expect(screen.getByText('3 clips · 0:45')).toBeInTheDocument();
    expect(
      screen.getByText(/2 selected clips have a failed or skipped audio check/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move segment 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move segment 3 down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move segment 2 up' }));
    expect(names()).toEqual(['2', '1', '3']);
    expect(await screen.findByText('Segment 2 moved to position 1.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move segment 2 down' }));
    expect(names()).toEqual(['1', '2', '3']);
  });

  it('unchecking a clip leaves it out; with none chosen Assemble is disabled', async () => {
    serve(passedList());
    show();
    const box = (n: number) => screen.getByRole('checkbox', { name: new RegExp(`Segment ${n} `) });
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(box(2));
    expect(screen.getByText('2 clips · 0:30')).toBeInTheDocument();
    fireEvent.click(box(1));
    fireEvent.click(box(3));
    expect(screen.getByText('Choose at least one clip.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assemble final ad' })).toBeDisabled();
  });

  it('all passed: Assemble sends API-070 in the chosen order with an Idempotency-Key, no confirmations', async () => {
    serve(passedList());
    accept(() => ok(assemblyFixture('pending'), 202));
    server.use(http.get(`${BASE}/assemblies/${ASSEMBLY_ID}`, () => ok(assemblyFixture('queued'))));
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(screen.getByRole('button', { name: 'Move segment 3 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final ad' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ clips: [jobId(1), jobId(3), jobId(2)] });
    expect(posts[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await screen.findByRole('heading', { name: 'Assembling your final ad' }),
    ).toBeInTheDocument();
  });

  it('qc-confirm: the dialog names the clips, needs the tick, then sends confirmations.qcOverride', async () => {
    serve(exceptionList());
    accept(() => ok(assemblyFixture('pending'), 202));
    server.use(http.get(`${BASE}/assemblies/${ASSEMBLY_ID}`, () => ok(assemblyFixture('queued'))));
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final ad' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Assemble with audio checks that did not pass?',
    });
    expect(posts).toHaveLength(0);
    expect(
      within(dialog).getByText(
        /Segment 2 failed its audio check \(speech did not match the script\)/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Segment 3's check was skipped.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assemble anyway' }));
    expect(await within(dialog).findByText(/Tick the box/)).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assemble anyway' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      clips: [jobId(1), jobId(2), jobId(3)],
      confirmations: { qcOverride: [jobId(2), jobId(3)] },
    });
    await screen.findByRole('heading', { name: 'Assembling your final ad' });
  });

  it('Go back closes the confirm dialog and sends nothing', async () => {
    serve(exceptionList());
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final ad' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts).toHaveLength(0);
  });

  it('qc-confirm-required: 422 after the checks changed reads them again and asks, then confirms', async () => {
    let reads = 0;
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => {
        reads += 1;
        return ok(reads === 1 ? passedList() : exceptionList());
      }),
    );
    let answers = 0;
    accept(() =>
      ++answers === 1
        ? failure(422, 'qc_confirmation_required', 'Segment 2 failed its check.')
        : ok(assemblyFixture('pending'), 202),
    );
    server.use(http.get(`${BASE}/assemblies/${ASSEMBLY_ID}`, () => ok(assemblyFixture('queued'))));
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final ad' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm clips that did not pass the check',
    });
    expect(posts[0]!.body).toEqual({ clips: [jobId(1), jobId(2), jobId(3)] });
    expect(within(dialog).getByText(/changed since you opened this page/)).toBeInTheDocument();
    expect(within(dialog).getByText('Segment 2: check failed')).toBeInTheDocument();
    expect(within(dialog).getByText(/Segment 3: check skipped/)).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Include these clips and assemble' }),
    );
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toEqual({
      clips: [jobId(1), jobId(2), jobId(3)],
      confirmations: { qcOverride: [jobId(2), jobId(3)] },
    });
    expect(posts[1]!.key).not.toBe(posts[0]!.key);
  });

  it('cap-reached: assembly_daily_limit keeps the selection and disables Assemble', async () => {
    serve(passedList());
    accept(() => failure(422, 'assembly_daily_limit'));
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(screen.getByRole('button', { name: 'Move segment 2 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final ad' }));
    expect(await screen.findByText('Daily assembly limit reached')).toBeInTheDocument();
    expect(screen.getByText(/after midnight UTC/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assemble final ad' })).toBeDisabled();
    expect(names()).toEqual(['1', '3', '2']);
  });

  it('cap-reached: spend_cap_reached shows its own copy', async () => {
    serve(passedList());
    accept(() => failure(422, 'spend_cap_reached'));
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final ad' }));
    expect(await screen.findByText(/A usage limit has been reached/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assemble final ad' })).toBeDisabled();
  });

  it('clip_not_completed: shows the notice and refreshes the clips', async () => {
    let reads = 0;
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => {
        reads += 1;
        return ok(passedList());
      }),
    );
    accept(() => failure(422, 'clip_not_completed', 'Segment 3 is not finished.'));
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final ad' }));
    expect(await screen.findByText(/Segment 3 is not finished/)).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('assembling: the progress shows the state from API-071 (resumed from the campaign)', async () => {
    serve(passedList());
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () =>
        ok(campaignFixture({ latestAssemblyId: ASSEMBLY_ID })),
      ),
      http.get(`${BASE}/assemblies/${ASSEMBLY_ID}`, () => ok(assemblyFixture('rendering'))),
    );
    show();
    const bar = await screen.findByRole('progressbar', { name: 'Assembly progress' });
    expect(bar).toHaveAttribute('aria-valuetext', 'Rendering');
    expect(screen.getByRole('list', { name: 'Progress' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Clips for the final ad' })).toBeNull();
  });

  it('failed: names the cause and Assemble again sends the same clips', async () => {
    serve(passedList());
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () =>
        ok(campaignFixture({ latestAssemblyId: ASSEMBLY_ID })),
      ),
      http.get(`${BASE}/assemblies/${ASSEMBLY_ID}`, () =>
        ok(assemblyFixture(posts.length > 0 ? 'queued' : 'failed')),
      ),
    );
    accept(() => ok(assemblyFixture('pending'), 202));
    show();
    expect(await screen.findByRole('heading', { name: 'Assembly failed' })).toBeInTheDocument();
    expect(screen.getByText(/could not be fetched from storage \(segment 3\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to clips' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assemble again' }));
    await screen.findByRole('heading', { name: 'Assembling your final ad' });
    expect(posts[0]!.body).toEqual({ clips: [jobId(1), jobId(2), jobId(3)] });
  });

  it('done and out of date: the final ad plays; Re-assemble returns to the selection', async () => {
    serve(passedList());
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () =>
        ok(campaignFixture({ latestAssemblyId: ASSEMBLY_ID })),
      ),
      http.get(`${BASE}/assemblies/${ASSEMBLY_ID}`, () =>
        ok(assemblyFixture('done', { outOfDate: true })),
      ),
    );
    show();
    expect(await screen.findByText('This video is out of date')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assemble a new video' }));
    expect(await screen.findByRole('list', { name: 'Clips for the final ad' })).toBeInTheDocument();
  });

  it('retired segments and clips of an older job are not offered', async () => {
    serve([item(1, videoJob(1)), item(2, videoJob(2), 'retired')]);
    show();
    await screen.findByRole('list', { name: 'Clips for the final ad' });
    expect(names()).toEqual(['1']);
  });
});
