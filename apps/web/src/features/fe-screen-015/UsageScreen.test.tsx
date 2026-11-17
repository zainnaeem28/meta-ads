// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import {
  checkWindow,
  choiceOf,
  formatLatency,
  formatUsd,
  microUsd,
  presetWindow,
  share,
  shortUserId,
  windowDays,
  windowParams,
} from './copy';
import { UsageScreen } from './UsageScreen';

const ORIGIN = 'http://api.test';
const URL_ = `${ORIGIN}/api/v1/admin/usage-report`;
const U1 = '8f3a0000-0000-4000-8000-00000000c21d';
const meta = { requestId: 'req-1', timestamp: '2026-11-14T22:40:00Z' };
const usage = (provider: string, over: Record<string, unknown> = {}) => ({
  provider,
  calls: 402,
  succeeded: 388,
  failed: 14,
  rejected: 0,
  unconfirmed: 0,
  estimatedCostUsd: '201.4000',
  latencyP50Ms: 40000,
  latencyP95Ms: 94000,
  ...over,
});
const report = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    from: '2026-10-15T00:00:00.000Z',
    to: '2026-11-14T22:40:00.000Z',
    asOf: '2026-11-14T22:40:00.000Z',
    empty: false,
    costBasis: 'estimate_from_configured_price_table',
    accounts: [
      {
        userId: U1,
        providers: [
          usage('wavespeed'),
          usage('openai', {
            calls: 318,
            failed: 4,
            estimatedCostUsd: '38.2000',
            latencyP95Ms: 6100,
          }),
        ],
      },
    ],
    providers: [
      usage('wavespeed'),
      usage('openai', { calls: 318, failed: 4, estimatedCostUsd: '38.2000', latencyP95Ms: 6100 }),
    ],
    jobStates: { succeeded: 90, failed: 3 },
    claimChecks: [
      { class: 'high_risk', raised: 21, closedByEdit: 21, clearedWithReason: 0 },
      { class: 'other', raised: 75, closedByEdit: 63, clearedWithReason: 12 },
    ],
    ...over,
  },
  metaData: meta,
});
const failure = (status: number, code: string) =>
  HttpResponse.json(
    { success: false, error: { code, message: 'x', details: [] }, metaData: meta },
    { status },
  );

let uninstall: () => void;
beforeEach(() => {
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(null) });
});
afterEach(() => {
  cleanup();
  uninstall();
});

const show = (initialWindow: { from: string; to: string } | null = null) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <UsageScreen initialWindow={initialWindow} />
    </QueryClientProvider>,
  );

describe('SCREEN-015 usage report', () => {
  it('loading: tiles and table are busy in the final layout', async () => {
    server.use(http.get(URL_, () => new Promise(() => undefined)));
    show();
    expect(await screen.findByText('Loading Provider calls')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Usage report' })).toBeInTheDocument();
  });

  it('default: tiles, estimated cost, per-account and per-provider tables, claim checks, user IDs only', async () => {
    let seen = '';
    server.use(
      http.get(
        URL_,
        ({ request }) => ((seen = new URL(request.url).search), HttpResponse.json(report())),
      ),
    );
    show();
    expect(await screen.findByText('US$239.60')).toBeInTheDocument();
    expect(seen).toBe('');
    expect(screen.getByText('Estimated cost (estimated)')).toBeInTheDocument();
    expect(screen.getByText('720')).toBeInTheDocument();
    const accounts = screen.getByRole('table', { name: 'By account and provider' });
    expect(within(accounts).getAllByRole('row')).toHaveLength(3);
    expect(accounts).toHaveTextContent('u_8f3a…c21d');
    expect(accounts).toHaveTextContent('94 s');
    expect(accounts).toHaveTextContent('6.1 s');
    expect(accounts).not.toHaveTextContent('@');
    expect(screen.getByRole('table', { name: 'By provider' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Brand checks' })).toHaveTextContent('(not allowed)');
    expect(screen.getByRole('table', { name: 'Jobs by state' })).toHaveTextContent('succeeded');
    expect(screen.getByText('As of')).toBeInTheDocument();
    expect(screen.getByText('14 Nov 2026, 22:40 UTC')).toBeInTheDocument();
  });

  it('empty: names the window and says it is not an error', async () => {
    server.use(
      http.get(URL_, () =>
        HttpResponse.json(
          report({ empty: true, accounts: [], providers: [], jobStates: {}, claimChecks: [] }),
        ),
      ),
    );
    show();
    expect(
      await screen.findByRole('heading', { name: 'No usage in this window' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/This is not an error/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('error: service_unavailable shows the report-could-not-be-built copy and Try again re-asks', async () => {
    let down = true;
    server.use(
      http.get(URL_, () =>
        down ? failure(503, 'service_unavailable') : HttpResponse.json(report()),
      ),
    );
    show();
    expect(
      await screen.findByRole(
        'heading',
        { name: 'The report could not be built' },
        { timeout: 15_000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('US$239.60')).toBeInTheDocument();
  }, 30_000);

  it('forbidden_role: the shell shows its unavailable state', async () => {
    server.use(http.get(URL_, () => failure(403, 'forbidden_role')));
    show();
    expect(await screen.findByText('Administration is not available')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Usage report' })).toBeNull();
  });

  it('window-too-large: the pre-check names the 366-day limit and sends nothing; the api 422 is handled the same', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, ({ request }) => {
        calls += 1;
        return new URL(request.url).searchParams.has('from')
          ? failure(422, 'report_window_too_large')
          : HttpResponse.json(report());
      }),
    );
    show();
    await screen.findByText('US$239.60');
    fireEvent.change(screen.getByLabelText('Time window'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Choose a window of 366 days or fewer.')).toBeInTheDocument();
    expect(calls).toBe(1);
    // a window the pre-check allows but the api refuses (clock skew at the edge) still ends in the same state
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(
      await screen.findByText('The longest window is 366 days. Choose a shorter one.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
  });

  it('window selector: a preset asks with from and to and updates the address', async () => {
    const seen: string[] = [];
    server.use(
      http.get(
        URL_,
        ({ request }) => (seen.push(new URL(request.url).search), HttpResponse.json(report())),
      ),
    );
    show();
    await screen.findByText('US$239.60');
    fireEvent.change(screen.getByLabelText('Time window'), { target: { value: '90' } });
    await waitFor(() => expect(seen).toHaveLength(2));
    const q = new URLSearchParams(seen[1]);
    expect(Date.parse(q.get('to')!) - Date.parse(q.get('from')!)).toBe(90 * 86_400_000);
    expect(window.location.search).toMatch(/^\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });
});

describe('SCREEN-015 helpers', () => {
  it('windows: inclusive dates become [from, to) instants, 366 days is the limit', () => {
    expect(windowParams({ from: '2026-11-01', to: '2026-11-02' })).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-03T00:00:00.000Z',
    });
    expect(windowParams({ from: '2026-11-02', to: '2026-11-01' })).toBeNull();
    expect(windowDays({ from: '2025-11-14', to: '2026-11-14' })).toBe(366);
    expect(checkWindow({ from: '2025-11-14', to: '2026-11-14' })).toBeNull();
    expect(checkWindow({ from: '2025-11-13', to: '2026-11-14' })).toMatch(/366 days/);
    expect(checkWindow({ from: '', to: '' })).toBe('Choose both dates.');
    expect(checkWindow({ from: '2026-11-02', to: '2026-11-01' })).toMatch(/not be before/);
  });

  it('choices: no window is 30 days; a preset-length window ending today is that preset', () => {
    const now = new Date('2026-11-14T10:00:00Z');
    expect(choiceOf(null, now)).toBe('30');
    expect(choiceOf(presetWindow(90, now), now)).toBe('90');
    expect(choiceOf({ from: '2026-01-01', to: '2026-02-01' }, now)).toBe('custom');
  });

  it('money and latency: exact decimal sums, cents rounding, thousands separators', () => {
    expect(formatUsd(microUsd('412.6000'))).toBe('US$412.60');
    expect(formatUsd(microUsd('1234.5050') + microUsd('0.0050'))).toBe('US$1,234.51');
    expect(formatUsd(0n)).toBe('US$0.00');
    expect(microUsd('bad')).toBe(0n);
    expect(share(49n, 100n)).toBe(49);
    expect(share(1n, 0n)).toBe(0);
    expect(formatLatency(null)).toBe('–');
    expect(formatLatency(850)).toBe('850 ms');
    expect(formatLatency(6100)).toBe('6.1 s');
    expect(shortUserId(U1)).toBe('u_8f3a…c21d');
  });
});
