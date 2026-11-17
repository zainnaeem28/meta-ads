// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import {
  ASSEMBLY_ID,
  CAMPAIGN_ID,
  assemblyFixture,
  campaignFixture,
  meta,
  passedList,
} from '../fe-screen-009a/fixtures';
import { FinalScreenWithDownload } from './FinalScreenWithDownload';
import { thumbFixture } from './fixtures';

const ORIGIN = 'http://api.test';
const BASE = `${ORIGIN}/api/v1`;
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, metaData: meta }, { status });
const failure = (status: number, code: string, message = 'x', details: unknown[] = []) =>
  HttpResponse.json(
    { success: false, error: { code, message, details }, metaData: meta },
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
let urlReads: number;
let posts: { body: unknown; key: string | null }[];
beforeEach(() => {
  urlReads = 0;
  posts = [];
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(null) });
  server.use(
    http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () =>
      ok(campaignFixture({ latestAssemblyId: ASSEMBLY_ID })),
    ),
    http.get(`${BASE}/me/provider-keys`, () => ok([keyRow('openai'), keyRow('wavespeed')])),
    http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/video-jobs`, () => ok(passedList())),
    http.get(`${BASE}/media/:id/url`, () => {
      urlReads += 1;
      return ok({ url: `http://media.test/file-${urlReads}.mp4` });
    }),
    http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/thumbstopper`, () => ok(null)),
  );
});
afterEach(() => {
  cleanup();
  uninstall();
});

const assembly = (over: Parameters<typeof assemblyFixture>[1] = {}) =>
  server.use(
    http.get(`${BASE}/assemblies/${ASSEMBLY_ID}`, () => ok(assemblyFixture('done', over))),
  );
const thumb = (data: unknown) =>
  server.use(http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/thumbstopper`, () => ok(data)));
const show = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FinalScreenWithDownload campaignId={CAMPAIGN_ID} />
    </QueryClientProvider>,
  );

describe('SCREEN-009 final ad: download, out-of-date, thumbstopper (TASK-097)', () => {
  it('done: the final ad with Download, the clips used and the optional thumbstopper', async () => {
    assembly();
    show();
    expect(await screen.findByRole('heading', { name: 'Final ad' })).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Length: 0:45 (3 clips)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download video' })).toBeEnabled();
    expect(screen.getByText(/The download link works for 5 minutes/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Clips used' })).toBeInTheDocument();
    expect(screen.queryByText('This final ad is out of date')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Generate thumbstopper' })).toBeEnabled();
  });

  it('download asks for a fresh link on every click, after the ownership check', async () => {
    assembly();
    show();
    const button = await screen.findByRole('button', { name: 'Download video' });
    await waitFor(() => expect(urlReads).toBeGreaterThan(0));
    const before = urlReads;
    fireEvent.click(button);
    await waitFor(() => expect(urlReads).toBe(before + 1));
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(urlReads).toBe(before + 2));
  });

  it('download failure: media_not_ready is explained and nothing is downloaded', async () => {
    assembly();
    show();
    const button = await screen.findByRole('button', { name: 'Download video' });
    server.use(http.get(`${BASE}/media/:id/url`, () => failure(409, 'media_not_ready', 'x')));
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('The download link could not be created')).not.toBeInTheDocument();
  });

  it('out-of-date: the notice names the clip and offers Re-assemble; the file stays downloadable', async () => {
    assembly({
      outOfDate: true,
      clips: assemblyFixture('done').clips.map((c) => ({ ...c, outOfDate: c.position === 3 })),
    });
    show();
    expect(await screen.findByText('This final ad is out of date')).toBeInTheDocument();
    expect(screen.getByText(/Clip 3 was regenerated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download video' })).toBeEnabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Re-assemble' })[0]!);
    expect(await screen.findByRole('list', { name: 'Clips for the final ad' })).toBeInTheDocument();
  });

  it('out-of-date because the brief changed: says so', async () => {
    assembly({ outOfDate: true });
    show();
    expect(await screen.findByText(/The brief changed after this ad was made/)).toBeInTheDocument();
  });

  it('thumbstopper: empty call-out text is refused before any call', async () => {
    assembly();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate thumbstopper' }));
    expect(await screen.findByText('Enter the call-out text.')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('thumbstopper: starts with the call-out text and an idempotency key, then follows the job', async () => {
    assembly();
    server.use(
      http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/thumbstopper`, async ({ request }) => {
        posts.push({ body: await request.json(), key: request.headers.get('idempotency-key') });
        thumb(thumbFixture('processing'));
        return ok(thumbFixture('pending'), 202);
      }),
    );
    show();
    const input = await screen.findByLabelText(/Call-out text/);
    fireEvent.change(input, { target: { value: 'Sleep better tonight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate thumbstopper' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ calloutText: 'Sleep better tonight' });
    expect(posts[0]!.key).toHaveLength(36);
    expect(
      await screen.findByText('Generating the thumbstopper. This takes about a minute.'),
    ).toBeInTheDocument();
  });

  it('thumbstopper ready: the frame with its call-out and the way to make another', async () => {
    assembly();
    thumb(thumbFixture('completed'));
    show();
    expect(await screen.findByText('Call-out: Sleep better tonight')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Sleep better tonight/ })).toHaveAttribute(
      'src',
      expect.stringContaining('http://media.test/'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make another' }));
    expect(await screen.findByLabelText(/Call-out text/)).toBeInTheDocument();
  });

  it('thumbstopper failed: the cause and Try again', async () => {
    assembly();
    thumb(thumbFixture('failed'));
    show();
    expect(await screen.findByText('The thumbstopper could not be made')).toBeInTheDocument();
    expect(screen.getByText('The image service could not make the frame.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText(/Call-out text/)).toBeInTheDocument();
  });

  it('open_claim_issues: the claim issue is shown at the call-out text', async () => {
    assembly();
    server.use(
      http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/thumbstopper`, () =>
        failure(422, 'open_claim_issues', 'Claim issues', [
          { field: 'calloutText', code: 'CLAIM-01', message: 'Remove the cure claim.' },
        ]),
      ),
    );
    show();
    fireEvent.change(await screen.findByLabelText(/Call-out text/), {
      target: { value: 'Cures insomnia' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate thumbstopper' }));
    expect((await screen.findAllByText('Remove the cure claim.')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Call-out text/)).toHaveAttribute('aria-invalid', 'true');
  });

  for (const code of ['key_missing', 'spend_cap_reached'] as const) {
    it(`${code}: shown with its UI-UX §9.1 copy`, async () => {
      assembly();
      server.use(
        http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/thumbstopper`, () => failure(422, code)),
      );
      show();
      fireEvent.change(await screen.findByLabelText(/Call-out text/), { target: { value: 'Hi' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate thumbstopper' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });
  }
});
