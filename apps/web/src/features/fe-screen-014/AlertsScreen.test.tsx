// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { AlertsScreen } from './AlertsScreen';
import { SCREEN_014_COPY as COPY, formatRaised, presentAlert, shortUserId } from './copy';

const ORIGIN = 'http://api.test';
const LIST = `${ORIGIN}/api/v1/admin/alerts`;
const USER = 'c07e0000-0000-4000-8000-000000009b30';
const meta = { requestId: 'req-1', timestamp: '2026-11-16T09:00:00Z' };
const page = (data: unknown[], next: string | null = null) => ({
  success: true,
  data,
  metaData: {
    ...meta,
    pagination: {
      type: 'cursor',
      limit: 50,
      returnedCount: data.length,
      hasNextPage: next !== null,
      nextCursor: next,
    },
  },
});
const alert = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'account_erasure_stuck',
  subjectUserId: USER,
  raisedAt: new Date().toISOString(),
  acknowledgedAt: null,
  acknowledgedBy: null,
  counts: { remaining_objects: 7, attempts: 6 },
  ...over,
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

const show = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AlertsScreen />
    </QueryClientProvider>,
  );

describe('SCREEN-014 alerts', () => {
  it('loading: busy status in the final layout', async () => {
    server.use(http.get(LIST, () => new Promise(() => undefined)));
    show();
    expect(await screen.findByText('Loading alerts')).toBeInTheDocument();
    expect(screen.getByText('Loading', { selector: 'span.sr-only' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Alerts' })).toBeInTheDocument();
  });

  it('default: lists unacknowledged and acknowledged alerts, user IDs only, count in the sidebar', async () => {
    const calls: string[] = [];
    server.use(
      http.get(LIST, ({ request }) => {
        calls.push(new URL(request.url).search);
        return HttpResponse.json(
          page([
            alert(),
            alert({
              id: '22222222-2222-4222-8222-222222222222',
              kind: 'job_burst',
              counts: { jobs: 24, window_minutes: 10 },
            }),
            alert({
              id: '33333333-3333-4333-8333-333333333333',
              kind: 'admin_role_changed',
              counts: {},
              acknowledgedAt: new Date().toISOString(),
              acknowledgedBy: USER,
            }),
          ]),
        );
      }),
    );
    show();
    const list = await screen.findByRole('list', { name: 'Alerts' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Account erasure is stuck')).toBeInTheDocument();
    expect(
      screen.getByText(/u_c07e…9b30: 7 stored objects could not be removed after 6 attempts/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Acknowledge:/ })).toHaveLength(2);
    expect(within(list).getByText('Acknowledged')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/@/);
    expect(document.querySelector('[data-alert-count]')).toHaveTextContent('2');
    expect(calls).toEqual(['?limit=50']);
  });

  it('empty: no alerts, no badge', async () => {
    server.use(http.get(LIST, () => HttpResponse.json(page([]))));
    show();
    expect(await screen.findByRole('heading', { name: COPY.emptyTitle })).toBeInTheDocument();
    expect(screen.getByText(COPY.emptyBody)).toBeInTheDocument();
    expect(document.querySelector('[data-alert-count]')).toBeNull();
  });

  it('acknowledged: Acknowledge calls API-126, marks the row, drops the count and announces it', async () => {
    const posted: string[] = [];
    server.use(
      http.get(LIST, () => HttpResponse.json(page([alert()]))),
      http.post(`${LIST}/:id/acknowledge`, ({ params }) => {
        posted.push(String(params['id']));
        return HttpResponse.json({
          success: true,
          data: alert({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: USER }),
          metaData: meta,
        });
      }),
    );
    show();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Acknowledge: Account erasure is stuck' }),
    );
    expect(await screen.findByText(COPY.acknowledgedToast)).toBeInTheDocument();
    expect(posted).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(screen.queryByRole('button', { name: /^Acknowledge:/ })).toBeNull();
    expect(screen.getByText('Acknowledged')).toBeInTheDocument();
    expect(document.querySelector('[data-alert-count]')).toBeNull();
  });

  it('shows more with the cursor of the first page', async () => {
    const seen: string[] = [];
    server.use(
      http.get(LIST, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        seen.push(cursor ?? '-');
        return HttpResponse.json(
          cursor
            ? page([
                alert({
                  id: '44444444-4444-4444-8444-444444444444',
                  kind: 'keys_disabled_all',
                  counts: {},
                }),
              ])
            : page([alert()], 'c1'),
        );
      }),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: COPY.showMore }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(seen).toEqual(['-', 'c1']);
  });

  it('forbidden_role: unavailable page, no navigation, no existence hint', async () => {
    server.use(http.get(LIST, () => failure(403, 'forbidden_role')));
    show();
    expect(await screen.findByText('Administration is not available')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Alerts' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to workspace' })).toHaveAttribute(
      'href',
      '/campaigns',
    );
  });

  it('recent_auth_required on the list: step-up dialog with the §9.1 copy', async () => {
    server.use(http.get(LIST, () => failure(403, 'recent_auth_required')));
    show();
    expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeInTheDocument();
    expect(
      screen.getByText('For your security, confirm it is you again to continue.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm sign-in' })).toBeInTheDocument();
  });

  it('recent_auth_required on Acknowledge: step-up dialog, the row stays unacknowledged', async () => {
    server.use(
      http.get(LIST, () => HttpResponse.json(page([alert()]))),
      http.post(`${LIST}/:id/acknowledge`, () => failure(403, 'recent_auth_required')),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^Acknowledge:/ }));
    expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeInTheDocument();
    expect(screen.queryByText(COPY.acknowledgedToast)).toBeNull();
  });
});

describe('SCREEN-014 copy', () => {
  it('shortens user ids and never shows an email', () => {
    expect(shortUserId(USER)).toBe('u_c07e…9b30');
    expect(shortUserId(null)).toBe('An account');
  });
  it('every alert kind has a title and a body, an unknown kind still renders', () => {
    for (const kind of [
      'campaign_deletion_stuck',
      'account_erasure_stuck',
      'job_burst',
      'provider_auth_spike',
      'admin_role_changed',
      'reservation_inconsistency',
      'key_unseal_failed',
      'keys_disabled_all',
      'future_kind',
    ]) {
      const view = presentAlert(alert({ kind, counts: {} }) as never);
      expect(view.title.length).toBeGreaterThan(0);
      expect(view.body).not.toContain('undefined');
    }
  });
  it('formats today, yesterday and older instants', () => {
    const now = new Date(2026, 10, 16, 12, 0);
    expect(formatRaised(new Date(2026, 10, 16, 8, 41).toISOString(), now)).toBe('Today, 08:41');
    expect(formatRaised(new Date(2026, 10, 15, 17, 2).toISOString(), now)).toBe('Yesterday, 17:02');
    expect(formatRaised(new Date(2026, 10, 3, 9, 30).toISOString(), now)).toBe('3 Nov, 09:30');
    expect(formatRaised('nope', now)).toBe('');
  });
});
