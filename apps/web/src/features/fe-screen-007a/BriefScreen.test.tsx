// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { BriefScreen } from './BriefScreen';
import {
  CAMPAIGN_ID,
  acceptedBrief,
  briefFixture,
  campaignFixture,
  failedBrief,
  generatingBrief,
  meta,
  segment,
  words,
} from './fixtures';

const ORIGIN = 'http://api.test';
const BASE = `${ORIGIN}/api/v1`;
const ok = (data: unknown, headers: Record<string, string> = { ETag: '"v3"' }) =>
  HttpResponse.json({ success: true, data, metaData: meta }, { headers });
const failure = (status: number, code: string) =>
  HttpResponse.json(
    { success: false, error: { code, message: 'x', details: [] }, metaData: meta },
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
let calls: string[];
beforeEach(() => {
  calls = [];
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(null) });
  server.use(
    http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () => ok(campaignFixture())),
    http.get(`${BASE}/me/provider-keys`, () => ok([keyRow('openai'), keyRow('wavespeed')])),
  );
});
afterEach(() => {
  cleanup();
  uninstall();
});

const serve = (brief: unknown) =>
  server.use(http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/brief`, () => ok(brief)));
const show = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <BriefScreen campaignId={CAMPAIGN_ID} />
    </QueryClientProvider>,
  );
const accept = () => screen.getByRole('button', { name: 'Accept brief' });

describe('SCREEN-007 brief', () => {
  it('loading: busy status in the final layout', async () => {
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/brief`, () => new Promise(() => undefined)),
    );
    show();
    expect(await screen.findByText('Loading the brief')).toBeInTheDocument();
    expect(document.querySelector('[data-screen=SCREEN-007]')).toHaveAttribute('aria-busy', 'true');
  });

  it('generating: status text, skeleton and polling keep going', async () => {
    serve(generatingBrief());
    show();
    expect(await screen.findByText('Generating your brief')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept brief' })).toBeNull();
  });

  it('default: breadcrumb, stage tabs, segments with counters, open issues and Accept disabled with the reason', async () => {
    serve(briefFixture());
    show();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Morning Focus Blend' }),
    ).toBeInTheDocument();
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Campaigns' })).toHaveAttribute('href', '/campaigns');
    const tabs = within(screen.getByRole('tablist', { name: 'Campaign stages' })).getAllByRole(
      'tab',
    );
    expect(tabs.map((t) => [t.textContent?.trim(), t.getAttribute('aria-disabled')])).toEqual([
      ['1 Brief', null],
      ['2 Clips', 'true'],
      ['3 Final', 'true'],
    ]);
    expect(screen.getByRole('heading', { name: '2 issues to resolve' })).toBeInTheDocument();
    expect(screen.getByText('1 high risk')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Segment 2 · 0:15 to 0:30' })).toBeInTheDocument();
    expect(screen.getAllByText(/words, (below|within|above)/).length).toBeGreaterThan(0);
    expect(accept()).toHaveAttribute('aria-disabled', 'true');
    expect(accept()).toHaveAccessibleDescription(
      '2 issues are still open, including 1 that must be fixed by editing the text. Resolve them, then accept.',
    );
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
  });

  it('accept-blocked: pressing the disabled Accept shows the blocked alert and sends nothing', async () => {
    serve(briefFixture());
    server.use(
      http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/brief/accept`, () => {
        calls.push('accept');
        return ok(acceptedBrief());
      }),
    );
    show();
    await screen.findByRole('heading', { name: '2 issues to resolve' });
    fireEvent.click(accept());
    await screen.findByText('The brief cannot be accepted yet');
    expect(calls).toEqual([]);
  });

  it('Edit segment moves focus to that segment dialogue', async () => {
    serve(briefFixture());
    show();
    fireEvent.click(await screen.findByRole('link', { name: 'Edit segment 2' }));
    expect(screen.getByRole('textbox', { name: 'Segment 2 dialogue' })).toHaveFocus();
  });

  it('counter: over 45 words is flagged and Save stays disabled with Accept refusing', async () => {
    serve(briefFixture({ issues: [] }));
    show();
    const box = await screen.findByRole('textbox', { name: 'Segment 1 dialogue' });
    fireEvent.change(box, { target: { value: words(46) } });
    expect(
      screen.getByText(/over the 45 word limit/, { selector: '[aria-hidden=true]' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.click(accept());
    expect(
      (await screen.findAllByText('Segment 1 is over the 45 word limit. Shorten it to continue.'))
        .length,
    ).toBeGreaterThan(0);
  });

  it('save sends only the changed fields with If-Match, then shows the re-run issues', async () => {
    serve(briefFixture());
    let seen: { body: unknown; ifMatch: string | null } | null = null;
    server.use(
      http.patch(`${BASE}/campaigns/${CAMPAIGN_ID}/brief`, async ({ request }) => {
        seen = { body: await request.json(), ifMatch: request.headers.get('If-Match') };
        return ok(briefFixture({ version: 4, issues: [] }), { ETag: '"v4"' });
      }),
    );
    show();
    const box = await screen.findByRole('textbox', { name: 'Segment 2 dialogue' });
    fireEvent.change(box, { target: { value: words(36) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved. Brand checks ran again.')).toBeInTheDocument();
    expect(seen).toEqual({
      body: { segments: [{ position: 2, dialogue: words(36) }] },
      ifMatch: '"v3"',
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /issues to resolve/ })).toBeNull(),
    );
    expect(accept()).not.toHaveAttribute('aria-disabled');
  });

  it('accept: sends If-Match and shows the accepted state with Continue to clips', async () => {
    serve(briefFixture({ issues: [] }));
    let ifMatch: string | null = null;
    server.use(
      http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/brief/accept`, ({ request }) => {
        ifMatch = request.headers.get('If-Match');
        server.use(http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/brief`, () => ok(acceptedBrief())));
        return ok(acceptedBrief());
      }),
    );
    show();
    await screen.findByRole('heading', { level: 1, name: 'Morning Focus Blend' });
    fireEvent.click(accept());
    expect(
      await screen.findByRole('heading', { name: 'Brief accepted · all checks closed' }),
    ).toBeInTheDocument();
    expect(ifMatch).toBe('"v3"');
    expect(screen.getByRole('link', { name: /Continue to clips/ })).toHaveAttribute(
      'href',
      `/campaigns/${CAMPAIGN_ID}/clips`,
    );
    expect(screen.getByRole('tab', { name: /2 Clips/ })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });

  it('accepted: editing reopens the brief for acceptance (Save and Accept are offered, not Continue)', async () => {
    serve(acceptedBrief());
    show();
    const box = await screen.findByRole('textbox', { name: 'Segment 1 dialogue' });
    fireEvent.change(box, { target: { value: `${box.textContent} more` } });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(accept()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('link', { name: /Continue to clips/ })).toBeNull();
  });

  it('failed: cause message and Edit answers; no Accept', async () => {
    serve(failedBrief());
    show();
    expect(
      await screen.findByRole('heading', { name: 'The brief could not be generated' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/out of credit/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Edit answers' })).toHaveAttribute(
        'href',
        '/campaigns/new?draft=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Accept brief' })).toBeNull();
  });

  it('key-missing: warning with the link to Provider keys, editing still possible', async () => {
    serve(briefFixture());
    server.use(
      http.get(`${BASE}/me/provider-keys`, () =>
        ok([keyRow('openai', false), keyRow('wavespeed')]),
      ),
    );
    show();
    expect(await screen.findByText('Regenerating needs your OpenAI key')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add OpenAI key' })).toHaveAttribute(
      'href',
      '/settings/provider-keys',
    );
    expect(screen.getByRole('textbox', { name: 'Segment 1 dialogue' })).toBeEnabled();
  });

  it('version_conflict: alert with Show the latest version keeps the unsaved text and offers the latest beside it', async () => {
    serve(briefFixture());
    server.use(
      http.patch(`${BASE}/campaigns/${CAMPAIGN_ID}/brief`, () => failure(409, 'version_conflict')),
    );
    show();
    const box = await screen.findByRole('textbox', { name: 'Segment 1 dialogue' });
    fireEvent.change(box, { target: { value: 'My own unsaved text for the first segment.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/This was changed somewhere else/)).toBeInTheDocument();
    server.use(
      http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/brief`, () =>
        ok(
          briefFixture({
            version: 5,
            segments: [
              segment(1, { dialogue: 'Someone else wrote this.' }),
              segment(2),
              segment(3),
            ],
          }),
        ),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show the latest version' }));
    const latest = await screen.findByTestId('latest-1');
    expect(within(latest).getByText('Someone else wrote this.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Segment 1 dialogue' })).toHaveValue(
      'My own unsaved text for the first segment.',
    );
    fireEvent.click(within(latest).getByRole('button', { name: 'Use the latest text' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Segment 1 dialogue' })).toHaveValue(
        'Someone else wrote this.',
      ),
    );
    expect(screen.queryByText(/This was changed somewhere else/)).toBeNull();
  });

  it('state_conflict and open_claim_issues on accept use the §9.1 copy', async () => {
    serve(briefFixture({ issues: [] }));
    server.use(
      http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/brief/accept`, () =>
        failure(409, 'state_conflict'),
      ),
    );
    show();
    await screen.findByRole('heading', { level: 1, name: 'Morning Focus Blend' });
    fireEvent.click(accept());
    expect(
      await screen.findByText(
        'This cannot be done in its current state. Refresh to see what changed.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    server.use(
      http.post(`${BASE}/campaigns/${CAMPAIGN_ID}/brief/accept`, () =>
        failure(422, 'open_claim_issues'),
      ),
    );
    fireEvent.click(accept());
    expect(
      await screen.findByText('Fix the flagged claim issues before you continue.'),
    ).toBeInTheDocument();
  });

  it('not_found: goes to SCREEN-004 (unavailable)', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });
    try {
      server.use(
        http.get(`${BASE}/campaigns/${CAMPAIGN_ID}/brief`, () => failure(404, 'not_found')),
        http.get(`${BASE}/campaigns/${CAMPAIGN_ID}`, () => failure(404, 'not_found')),
      );
      show();
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/not-found?state=unavailable'));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
