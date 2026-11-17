// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { ApiProvider } from '../../providers/api-provider';
import { AccessScreen } from './AccessScreen';
import { SCREEN_002_COPY, SCREEN_002_STATES, parseNamedState } from './copy';

afterEach(cleanup);

const ORIGIN = 'http://api.test';
const meta = { requestId: 'req-1' };
const notLinked = (state: 'none' | 'pending' | 'declined', formEnabled = true) =>
  HttpResponse.json({
    success: true,
    data: { linkState: 'not_linked', accessRequest: { formEnabled, state } },
    metaData: meta,
  });
const failure = (status: number, code: string, headers?: Record<string, string>) =>
  HttpResponse.json(
    { success: false, error: { code, message: code, details: [] }, metaData: meta },
    { status, headers },
  );

const view = (named: Parameters<typeof AccessScreen>[0]['named'], navigate = vi.fn()) =>
  render(
    <ApiProvider
      origin={ORIGIN}
      getToken={() => Promise.resolve('tok')}
      identity="u"
      client={createQueryClient()}
    >
      <AccessScreen named={named} navigate={navigate} />
    </ApiProvider>,
  );

const h1 = () => screen.getByRole('heading', { level: 1 });

describe('SCREEN-002 access states', () => {
  it('not-linked: the request form shows and a submit sends only the note to API-002', async () => {
    let body: unknown;
    const calls: string[] = [];
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () => {
        calls.push('GET /me');
        return notLinked('none');
      }),
      http.post(`${ORIGIN}/api/v1/access-requests`, async ({ request }) => {
        calls.push('POST /access-requests');
        body = await request.json();
        return HttpResponse.json(
          { success: true, data: { state: 'received' }, metaData: meta },
          { status: 202 },
        );
      }),
    );
    view(null);
    await screen.findByRole('textbox');
    expect(h1()).toHaveTextContent(SCREEN_002_COPY['not-linked'].title);
    fireEvent.change(screen.getByLabelText(/Tell your administrator who you are/), {
      target: { value: 'Marketing, spring launch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await waitFor(() => expect(h1()).toHaveTextContent('Request sent'));
    expect(body).toEqual({ note: 'Marketing, spring launch' });
    expect(calls).toEqual(['GET /me', 'POST /access-requests']);
  });

  it('request-pending: API-001 says pending, so no form shows and the message is the same one', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => notLinked('pending')));
    view(null);
    await waitFor(() => expect(h1()).toHaveTextContent('Request sent'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('a declined request looks exactly like none: the form shows with the neutral heading', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => notLinked('declined')));
    view(null);
    await screen.findByRole('textbox');
    expect(h1()).toHaveTextContent(SCREEN_002_COPY['not-linked'].title);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('suspended and removed come from the error code of API-001; removed has no contact-your-administrator line', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => failure(403, 'account_suspended')));
    view(null);
    await waitFor(() => expect(h1()).toHaveTextContent(SCREEN_002_COPY.suspended.title));
    expect(screen.getByText(SCREEN_002_COPY.suspended.body)).toBeInTheDocument();
    cleanup();
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => failure(403, 'account_removed')));
    view(null);
    await waitFor(() => expect(h1()).toHaveTextContent(SCREEN_002_COPY.removed.title));
    expect(document.body.textContent).toContain('This account has been removed.');
    expect(document.body.textContent).not.toMatch(/administrator/i);
  });

  it.each(['suspended', 'removed', 'invite-invalid'] as const)(
    '?state=%s renders without any api call',
    async (state) => {
      const hit = vi.fn(() => failure(500, 'internal_error'));
      server.use(
        http.get(`${ORIGIN}/api/v1/me`, hit),
        http.post(`${ORIGIN}/api/v1/access-requests`, hit),
      );
      view(state);
      expect(h1()).toHaveTextContent(SCREEN_002_COPY[state].title);
      expect(hit).not.toHaveBeenCalled();
    },
  );

  it('a linked account is sent to the campaigns', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () =>
        HttpResponse.json({
          success: true,
          data: { linkState: 'linked', id: 'x', role: 'operator', status: 'active' },
          metaData: meta,
        }),
      ),
    );
    const navigate = vi.fn();
    view(null, navigate);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/campaigns'));
  });

  it('API-002 not_found switches the form off with neutral copy', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () => notLinked('none')),
      http.post(`${ORIGIN}/api/v1/access-requests`, () => failure(404, 'not_found')),
    );
    view(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    await screen.findByText(/Requests are not being taken/);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('formEnabled=false shows no form', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => notLinked('none', false)));
    view(null);
    await screen.findByText(/Requests are not being taken/);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('rate_limited shows the wait in an alert and keeps the form', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () => notLinked('none')),
      http.post(`${ORIGIN}/api/v1/access-requests`, () =>
        failure(429, 'rate_limited', { 'Retry-After': '30' }),
      ),
    );
    view(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 30 seconds.',
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('validation_failed marks the note field', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () => notLinked('none')),
      http.post(`${ORIGIN}/api/v1/access-requests`, () => failure(400, 'validation_failed')),
    );
    view(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    await screen.findByText(/500 characters or fewer/);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('an unexpected API-001 failure shows a message and a retry, not a state', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => failure(500, 'internal_error')));
    view(null);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('every state has copy and no copy names an account or an address', () => {
    for (const state of SCREEN_002_STATES) {
      expect(SCREEN_002_COPY[state].title.length).toBeGreaterThan(0);
      expect(JSON.stringify(SCREEN_002_COPY[state])).not.toMatch(/@|already (exists|registered)/i);
    }
  });

  it('parses the state parameter', () => {
    expect(parseNamedState('removed')).toBe('removed');
    expect(parseNamedState(['suspended', 'x'])).toBe('suspended');
    expect(parseNamedState('request-pending')).toBeNull();
    expect(parseNamedState(undefined)).toBeNull();
  });
});
