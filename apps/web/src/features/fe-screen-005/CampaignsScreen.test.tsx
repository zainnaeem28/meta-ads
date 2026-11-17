// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../lib/api/msw.setup';
import { ApiProvider } from '../../providers/api-provider';
import { CampaignsScreen } from './CampaignsScreen';

const API = 'http://api.test/api/v1';
const NOW = '2026-11-16T12:00:00.000Z';
const meta = { requestId: 'req-1', timestamp: NOW };
const page = (n: number, next: string | null) => ({
  ...meta,
  pagination: { type: 'cursor', limit: 10, returnedCount: n, hasNextPage: next !== null, nextCursor: next },
});

const campaign = (n: number, over: Record<string, unknown> = {}) => ({
  id: `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
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
const draft = (n: number, over: Record<string, unknown> = {}) => ({
  id: `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  version: 1,
  step: 3,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: `Draft ${n}`,
  productDescription: null,
  audience: null,
  direction: null,
  concept: null,
  script: null,
  productMediaId: null,
  campaignId: null,
  durationSeconds: 45,
  createdAt: '2026-11-16T11:00:00.000Z',
  updatedAt: '2026-11-16T11:55:00.000Z',
  ...over,
});

const keyOf = (provider: string, configured = true) => ({
  provider,
  configured,
  status: configured ? 'active' : null,
  last4: null,
  fingerprint: null,
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastValidatedAt: null,
  inFlightJobCount: 0,
});
const ok = (data: unknown, m: unknown = meta) => HttpResponse.json({ success: true, data, metaData: m });
const fail = (status: number, code: string) =>
  HttpResponse.json({ success: false, error: { code, message: 'Refused.', details: [] }, metaData: meta }, { status });

interface Setup {
  campaigns?: (url: URL) => Response;
  drafts?: unknown[];
  keys?: unknown[];
}
const calls: string[] = [];
const seen: URL[] = [];
const STATUS_TOTALS: Record<string, number> = { '': 24, processing: 3, completed: 19, failed: 2 };

function serve({ campaigns, drafts = [draft(1), draft(2), draft(3)], keys = [keyOf('openai'), keyOf('wavespeed')] }: Setup = {}) {
  server.use(
    http.get(`${API}/campaigns`, ({ request }) => {
      const url = new URL(request.url);
      seen.push(url);
      if (campaigns) return campaigns(url);
      const limit = Number(url.searchParams.get('limit'));
      const filter = url.searchParams.get('filter') ?? '';
      const total = limit === 50 ? STATUS_TOTALS[filter] ?? 0 : 24;
      const all = Array.from({ length: Math.min(total, limit) }, (_, i) => campaign(i + 1));
      return ok(all, page(all.length, null));
    }),
    http.get(`${API}/drafts`, () => ok(drafts, page(drafts.length, null))),
    http.get(`${API}/me`, () =>
      ok({ linkState: 'linked', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'user', status: 'active', mfa: { required: true, satisfied: true }, recentAuth: { satisfied: true, maxAgeSeconds: 900 }, keyNotices: [] }),
    ),
    http.get(`${API}/me/provider-keys`, () => ok(keys)),
  );
}
server.events.on('request:start', ({ request }) => {
  calls.push(`${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}`);
});

const mount = (search = '') => {
  window.history.replaceState(null, '', `/campaigns${search}`);
  return render(
    <ApiProvider origin="http://api.test" getToken={() => Promise.resolve('t')} identity="user-1">
      <CampaignsScreen initialSearch={search.replace(/^\?/, '')} />
    </ApiProvider>,
  );
};
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el));

beforeEach(() => {
  calls.length = 0;
  seen.length = 0;
});
afterEach(cleanup);

describe('SCREEN-005 campaigns', () => {
  it('default: tabs with counts, rows with stage links, status chips with counts and the New brief action', async () => {
    serve();
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Campaign history' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByRole('link', { name: 'Product 1' })).toHaveAttribute('href', expect.stringMatching(/\/clips$/));
    expect(within(list).getAllByText('Clips generating')).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByRole('tab', { name: /History/ })).toHaveTextContent('24'));
    expect(screen.getByRole('tab', { name: /Drafts/ })).toHaveTextContent('3');
    const chips = screen.getByRole('group', { name: 'Filter by status' });
    await waitFor(() => expect(within(chips).getByRole('button', { name: /Failed/ })).toHaveTextContent('2'));
    expect(within(chips).getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('link', { name: 'New brief' })[0]).toHaveAttribute('href', '/campaigns/new');
    expect(screen.queryByText('Add your provider keys to start generating')).toBeNull();
    // Only the listed operations plus the shell's identity and key-state reads.
    expect(new Set(calls.map((c) => c.split('?')[0]))).toEqual(new Set(['GET /campaigns', 'GET /drafts', 'GET /me', 'GET /me/provider-keys']));
  });

  it('loading shows a status text and skeleton rows without fake data', async () => {
    serve({ campaigns: () => new Promise<Response>(() => undefined) as never });
    mount();
    expect((await screen.findAllByText('Loading campaigns')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('list', { name: 'Campaign history' })).toBeNull();
  });

  it('empty differs from no-results: first action is New brief, then a search offers Clear filters', async () => {
    serve({ campaigns: () => ok([], page(0, null)) });
    mount();
    expect(await screen.findByRole('heading', { name: 'No campaigns yet' })).toBeVisible();
    cleanup();
    serve({ campaigns: () => ok([], page(0, null)) });
    mount('?q=reishi+gummies');
    expect(await screen.findByRole('heading', { name: 'No campaigns match "reishi gummies"' })).toBeVisible();
    expect(screen.queryByText('No campaigns yet')).toBeNull();
    await click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(window.location.search).toBe('');
    expect(await screen.findByRole('heading', { name: 'No campaigns yet' })).toBeVisible();
  });

  it('a filter change resets the page and the URL carries tab, search, status and page', async () => {
    serve({
      campaigns: (url) => {
        const cursor = url.searchParams.get('cursor');
        if (url.searchParams.get('limit') === '50') return ok([campaign(1)], page(1, null));
        return cursor ? ok([campaign(11)], page(1, null)) : ok(Array.from({ length: 10 }, (_, i) => campaign(i + 1)), page(10, 'cur-1'));
      },
    });
    mount();
    await screen.findByRole('list', { name: 'Campaign history' });
    await click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByRole('link', { name: 'Product 11' });
    expect(window.location.search).toBe('?page=2');
    await click(within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name: /Failed/ }));
    expect(window.location.search).toBe('?status=failed');
    await waitFor(() => expect(seen.some((u) => u.searchParams.get('filter') === 'failed' && u.searchParams.get('limit') === '10')).toBe(true));
    await click(screen.getByRole('button', { name: 'Clear all' }));
    expect(window.location.search).toBe('');
  });

  it('paging sends the cursor of the previous page and never repeats a campaign that moved', async () => {
    serve({
      campaigns: (url) => {
        if (url.searchParams.get('limit') === '50') return ok([], page(0, null));
        return url.searchParams.get('cursor')
          ? ok([campaign(10), campaign(11)], page(2, null))
          : ok(Array.from({ length: 10 }, (_, i) => campaign(i + 1)), page(10, 'cur-1'));
      },
    });
    mount('?page=2');
    expect(await screen.findByRole('link', { name: 'Product 11' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Product 10' })).toBeNull();
    expect(seen.filter((u) => u.searchParams.get('limit') === '10').map((u) => u.searchParams.get('cursor'))).toEqual([null, 'cur-1']);
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
    await click(screen.getByRole('button', { name: /Previous/ }));
    expect(await screen.findByRole('link', { name: 'Product 1' })).toBeVisible();
    expect(window.location.search).toBe('');
  });

  it('search is debounced into the URL, resets the page and sends only 2 to 100 characters', async () => {
    serve();
    mount('?page=1');
    await screen.findByRole('list', { name: 'Campaign history' });
    const box = screen.getByRole('searchbox');
    await act(async () => void fireEvent.change(box, { target: { value: 'r' } }));
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.some((u) => u.searchParams.has('q'))).toBe(false);
    await act(async () => void fireEvent.change(box, { target: { value: 'reishi' } }));
    await waitFor(() => expect(window.location.search).toBe('?q=reishi'));
    await waitFor(() => expect(seen.some((u) => u.searchParams.get('q') === 'reishi')).toBe(true));
  });

  it('error: the load failure says so, keeps the data safe and Try again reloads', async () => {
    let fails = true;
    serve({ campaigns: () => (fails ? fail(500, 'internal_error') : ok([campaign(1)], page(1, null))) });
    mount();
    // The query client retries a 5xx twice (1 s and 2 s) before the page shows the failure.
    const retry = await screen.findByRole('button', { name: /Try again/ }, { timeout: 6000 });
    expect(retry.closest('[data-variant=error]')).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('list', { name: 'Campaign history' })).toBeNull();
    fails = false;
    await click(retry);
    expect(await screen.findByRole('link', { name: 'Product 1' })).toBeVisible();
  }, 12_000);

  it('drafts tab: rows with step and saved time, continue link, client search', async () => {
    serve({ drafts: [draft(1, { productName: 'Lions Mane', step: 4 }), draft(2, { productName: null, step: 1, durationSeconds: null })] });
    mount('?tab=drafts');
    const list = await screen.findByRole('list', { name: 'Drafts' });
    expect(within(list).getByRole('link', { name: 'Lions Mane' })).toHaveAttribute('href', '/campaigns/new?draft=d0000000-0000-4000-8000-000000000001');
    expect(within(list).getByRole('link', { name: 'Untitled draft' })).toBeVisible();
    expect(within(list).getByText(/Step 4 of 4: Concept and script · Saved /)).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Filter by status' })?.children.length ?? 0).toBe(0);
    await act(async () => void fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lions' } }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Drafts' })).getAllByRole('listitem')).toHaveLength(1));
    await act(async () => void fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } }));
    expect(await screen.findByRole('heading', { name: 'No campaigns match "zzz"' })).toBeVisible();
  });

  it('drafts empty explains and offers New brief', async () => {
    serve({ drafts: [] });
    mount('?tab=drafts');
    expect(await screen.findByRole('heading', { name: 'No drafts' })).toBeVisible();
  });

  it('delete a campaign: confirm states the media removal, calls API-042, shows the toast and the row disappears', async () => {
    serve();
    const removed: string[] = [];
    server.use(
      http.delete(`${API}/campaigns/:id`, ({ params }) => {
        removed.push(String(params.id));
        return HttpResponse.json({ success: true, data: { deletionRunId: 'e0000000-0000-4000-8000-000000000001', state: 'running' }, metaData: meta }, { status: 202 });
      }),
    );
    mount();
    await screen.findByRole('list', { name: 'Campaign history' });
    await click(screen.getByRole('button', { name: 'Delete Product 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete "Product 2"?' });
    expect(dialog).toHaveTextContent('removes the campaign for everyone');
    expect(dialog).toHaveTextContent('Credit already spent');
    await click(within(dialog).getByRole('button', { name: 'Delete campaign' }));
    expect(await screen.findByText('Campaign deleted. Its media is being removed in the background.')).toBeVisible();
    expect(removed).toEqual(['c0000000-0000-4000-8000-000000000002']);
    expect(screen.queryByRole('link', { name: 'Product 2' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a long product name is the full accessible name of the icon-only delete button', async () => {
    serve({ campaigns: () => ok([campaign(1, { productName: 'Cordyceps Trail Mix, spring launch with the long working title' })], page(1, null)) });
    mount();
    expect(await screen.findByRole('button', { name: 'Delete Cordyceps Trail Mix, spring launch with the long working title' })).toBeVisible();
  });

  it('cancel keeps the record and calls nothing', async () => {
    serve();
    mount();
    await screen.findByRole('list', { name: 'Campaign history' });
    await click(screen.getByRole('button', { name: 'Delete Product 1' }));
    await click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: 'Product 1' })).toBeVisible();
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('delete a draft calls API-025 and the dialog gives its own text', async () => {
    serve();
    const removed: string[] = [];
    server.use(
      http.delete(`${API}/drafts/:id`, ({ params }) => {
        removed.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mount('?tab=drafts');
    await screen.findByRole('list', { name: 'Drafts' });
    await click(screen.getByRole('button', { name: 'Delete draft Draft 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete draft "Draft 1"?' });
    expect(dialog).toHaveTextContent('removes the draft and its product image');
    await click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    expect(await screen.findByText('Draft deleted. Its product image is removed.')).toBeVisible();
    expect(removed).toEqual(['d0000000-0000-4000-8000-000000000001']);
  });

  it('a record that is already gone keeps the dialog open with the section 9.1 message', async () => {
    serve();
    server.use(http.delete(`${API}/campaigns/:id`, () => fail(404, 'not_found')));
    mount();
    await screen.findByRole('list', { name: 'Campaign history' });
    await click(screen.getByRole('button', { name: 'Delete Product 1' }));
    const dialog = await screen.findByRole('dialog');
    await click(within(dialog).getByRole('button', { name: 'Delete campaign' }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toBeVisible());
  });

  it('key-missing: the banner links to the key screen', async () => {
    serve({ keys: [keyOf('openai'), keyOf('wavespeed', false)] });
    mount();
    const banner = await screen.findByText('Add your provider keys to start generating');
    expect(banner).toBeVisible();
    expect(within(banner.closest('[role=status]') as HTMLElement).getByRole('link', { name: 'Add provider keys' })).toHaveAttribute('href', '/settings/provider-keys');
  });

  it('switching tabs updates the URL and Back restores the previous one', async () => {
    serve();
    mount();
    await screen.findByRole('list', { name: 'Campaign history' });
    await click(screen.getByRole('tab', { name: /Drafts/ }));
    expect(window.location.search).toBe('?tab=drafts');
    await screen.findByRole('list', { name: 'Drafts' });
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await screen.findByRole('list', { name: 'Campaign history' })).toBeVisible();
  });
});
