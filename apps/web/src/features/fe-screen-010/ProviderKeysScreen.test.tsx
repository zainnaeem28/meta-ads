// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApiClient } from '../../lib/api/client';
import { server } from '../../lib/api/msw.setup';
import { createQueryClient } from '../../lib/query/query-client';
import { ProviderKeysScreen } from './ProviderKeysScreen';
import { cardState, deleteBody, formatEvent, formatTested, presentEvent, replaceWarning, savedMessage } from './copy';

const ORIGIN = 'http://api.test';
const BASE = `${ORIGIN}/api/v1`;
const meta = { requestId: 'req-1', timestamp: '2026-11-16T09:00:00Z' };
const status = (over: Record<string, unknown> = {}) => ({
  provider: 'openai',
  configured: true,
  status: 'active',
  last4: '7Q2d',
  fingerprint: '4f9a1c07b21e',
  version: 1,
  createdAt: '2026-11-03T09:14:00Z',
  updatedAt: '2026-11-03T09:14:00Z',
  lastValidatedAt: '2026-11-12T09:41:00Z',
  inFlightJobCount: 0,
  ...over,
});
const none = (provider: string) =>
  status({ provider, configured: false, status: null, last4: null, fingerprint: null, version: null, createdAt: null, updatedAt: null, lastValidatedAt: null });
const list = (...data: unknown[]) => HttpResponse.json({ success: true, data, metaData: meta });
const events = (data: unknown[] = [], next: string | null = null) =>
  HttpResponse.json({
    success: true,
    data,
    metaData: { ...meta, pagination: { type: 'cursor', limit: 20, returnedCount: data.length, hasNextPage: next !== null, nextCursor: next } },
  });
const failure = (httpStatus: number, code: string, headers: Record<string, string> = {}) =>
  HttpResponse.json({ success: false, error: { code, message: 'x', details: [] }, metaData: meta }, { status: httpStatus, headers });
const me = (role = 'user') =>
  HttpResponse.json({ success: true, data: { linkState: 'linked', id: 'u1', role, status: 'active', mfa: { required: true, satisfied: true }, recentAuth: { satisfied: true, maxAgeSeconds: 600 }, keyNotices: [] }, metaData: meta });

let uninstall: () => void;
beforeEach(() => {
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(null) });
  server.use(http.get(`${BASE}/me`, () => me()), http.get(`${BASE}/me/key-events`, () => events()));
});
afterEach(() => {
  cleanup();
  uninstall();
});

const show = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ProviderKeysScreen />
    </QueryClientProvider>,
  );
const serve = (...keys: unknown[]) => server.use(http.get(`${BASE}/me/provider-keys`, () => list(...keys)));
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz';

describe('SCREEN-010 provider keys', () => {
  it('loading: busy status in the final layout', async () => {
    server.use(http.get(`${BASE}/me/provider-keys`, () => new Promise(() => undefined)));
    show();
    expect(await screen.findByText('Loading provider keys')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Provider keys' })).toBeInTheDocument();
  });

  it('default: each provider by hint and fingerprint only, no reveal control, no key in the page', async () => {
    serve(status(), none('wavespeed'));
    show();
    expect(await screen.findByRole('heading', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.getByTestId('key-hint')).toHaveTextContent('…7Q2d');
    expect(screen.getByText('4f9a1c07b21e')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace OpenAI key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add WaveSpeed key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show|reveal|copy/i })).toBeNull();
    expect(screen.queryByText('Add both keys to create ads')).toBeNull();
    expect(await screen.findByText('No key activity yet.')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-key-badge="missing"]')).not.toBeNull());
  });

  it('empty: neither key added, warning and two Add buttons', async () => {
    serve(none('openai'), none('wavespeed'));
    show();
    expect(await screen.findByText('Add both keys to create ads')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add OpenAI key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add WaveSpeed key' })).toBeInTheDocument();
  });

  it('add dialog: masked, no autofill, advice, reminder; testing then saved with hint and fingerprint', async () => {
    serve(status(), none('wavespeed'));
    let body: unknown;
    let release: () => void = () => undefined;
    server.use(
      http.put(`${BASE}/me/provider-keys/wavespeed`, async ({ request }) => {
        body = await request.json();
        await new Promise<void>((resolve) => (release = resolve));
        serve(status(), status({ provider: 'wavespeed', last4: '9fK2' }));
        return HttpResponse.json({ success: true, data: { ...status({ provider: 'wavespeed', last4: '9fK2', fingerprint: 'b21e88d0aaaa' }), probe: 'valid' }, metaData: meta });
      }),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add WaveSpeed key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add WaveSpeed key' });
    const field = within(dialog).getByLabelText('WaveSpeed API key');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(dialog).toHaveTextContent('inference scope');
    expect(dialog).toHaveTextContent('will not be able to see the full key again');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.change(field, { target: { value: `  ${KEY}  ` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test and save' }));
    expect(await within(dialog).findByText(/Testing the key/)).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(field).toBeDisabled();
    expect(screen.getByRole('region', { name: 'WaveSpeed' })).toHaveAttribute('data-state', 'testing');
    release();
    expect(await screen.findByText('WaveSpeed key saved')).toBeInTheDocument();
    expect(body).toEqual({ apiKey: KEY });
    expect(screen.getByText(/It ends in …9fK2/)).toBeInTheDocument();
    expect(screen.getByText(/cannot|will not be able to see the full key again/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
    expect(screen.getByRole('region', { name: 'WaveSpeed' })).toHaveAttribute('data-state', 'active');
  });

  it('untested: a key stored without a probe says so', async () => {
    serve(status(), none('wavespeed'));
    server.use(
      http.put(`${BASE}/me/provider-keys/wavespeed`, () => {
        serve(status(), status({ provider: 'wavespeed', status: 'untested', last4: '9fK2', lastValidatedAt: null }));
        return HttpResponse.json({ success: true, data: { ...status({ provider: 'wavespeed', status: 'untested', last4: '9fK2', lastValidatedAt: null }), probe: 'unknown' }, metaData: meta });
      }),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add WaveSpeed key' }));
    fireEvent.change(screen.getByLabelText('WaveSpeed API key'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByTestId('untested-wavespeed')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'WaveSpeed' })).toHaveAttribute('data-state', 'untested');
  });

  it('validation-error: key_invalid shows the field error, keeps the dialog, empties the field', async () => {
    serve(status(), none('wavespeed'));
    server.use(http.put(`${BASE}/me/provider-keys/wavespeed`, () => failure(422, 'key_invalid')));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add WaveSpeed key' }));
    const field = screen.getByLabelText('WaveSpeed API key');
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByText(/did not accept this key/)).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('an empty field is refused before any call', async () => {
    serve(none('openai'), none('wavespeed'));
    let called = false;
    server.use(http.put(`${BASE}/me/provider-keys/openai`, () => ((called = true), failure(500, 'internal_error'))));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add OpenAI key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByText('Paste your key before testing it.')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('rate-limited: states the wait', async () => {
    serve(none('openai'), none('wavespeed'));
    server.use(http.put(`${BASE}/me/provider-keys/openai`, () => failure(429, 'rate_limited', { 'Retry-After': '420' })));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add OpenAI key' }));
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByText('Too many attempts. Try again in 7 minutes.')).toBeInTheDocument();
  });

  it('step-up: recent_auth_required closes the dialog and asks to confirm; nothing is resubmitted', async () => {
    serve(none('openai'), none('wavespeed'));
    let puts = 0;
    server.use(http.put(`${BASE}/me/provider-keys/openai`, () => ((puts += 1), failure(403, 'recent_auth_required'))));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add OpenAI key' }));
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    const step = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    expect(step).toHaveTextContent('For your security, confirm it is you again to continue.');
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull();
    fireEvent.click(within(step).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts).toBe(1);
  });

  it('replace-warning: the in-flight jobs warning shows before entry; a failed test keeps the card', async () => {
    serve(status({ inFlightJobCount: 1 }), none('wavespeed'));
    server.use(http.put(`${BASE}/me/provider-keys/openai`, () => failure(422, 'key_invalid')));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace OpenAI key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace OpenAI key?' });
    expect(dialog).toHaveTextContent('1 job is running on the current key');
    expect(dialog).toHaveTextContent('revoke the old key at OpenAI');
    fireEvent.change(within(dialog).getByLabelText('New OpenAI API key'), { target: { value: KEY } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test and replace' }));
    expect(await within(dialog).findByText(/did not accept this key/)).toBeInTheDocument();
    expect(screen.getByTestId('key-hint')).toHaveTextContent('…7Q2d');
  });

  it('delete-confirm: states the backup retention; confirming calls API-012 and drops the key', async () => {
    serve(status(), status({ provider: 'wavespeed', last4: '9fK2' }));
    let deleted = '';
    server.use(
      http.delete(`${BASE}/me/provider-keys/:provider`, ({ params }) => {
        deleted = String(params['provider']);
        serve(none('openai'), status({ provider: 'wavespeed', last4: '9fK2' }));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete OpenAI key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete OpenAI key?' });
    expect(dialog).toHaveTextContent('Backups age out within 30 days.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete key' }));
    expect(await screen.findByText('OpenAI key deleted.')).toBeInTheDocument();
    expect(deleted).toBe('openai');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add OpenAI key' })).toBeInTheDocument());
  });

  it('delete: not_found uses the §9.1 copy inside the dialog', async () => {
    serve(status(), none('wavespeed'));
    server.use(http.delete(`${BASE}/me/provider-keys/openai`, () => failure(404, 'not_found')));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete OpenAI key' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete key' }));
    expect(await screen.findByText('This page or item is not available.')).toBeInTheDocument();
  });

  it('disabled: the notice stays on the page with Replace', async () => {
    serve(status(), status({ provider: 'wavespeed', status: 'disabled', last4: '9fK2' }));
    show();
    expect(await screen.findByText('Your WaveSpeed key was disabled')).toBeInTheDocument();
    expect(screen.getByText(/failed authentication 5 times in a row\. Replace it to generate clips again/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'WaveSpeed' })).toHaveAttribute('data-state', 'disabled');
    await waitFor(() => expect(document.querySelector('[data-key-badge="disabled"]')).not.toBeNull());
  });

  it('key events: the trail lists the API-013 events and pages with the cursor', async () => {
    serve(status(), status({ provider: 'wavespeed' }));
    const seen: string[] = [];
    const event = (id: string, kind: string, provider = 'openai') => ({ id: `${id}0000000-0000-4000-8000-000000000000`, provider, kind, at: '2026-11-12T16:02:00Z' });
    server.use(
      http.get(`${BASE}/me/key-events`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        seen.push(cursor ?? '-');
        return cursor ? events([event('2', 'deleted', 'wavespeed')]) : events([event('1', 'test_failed', 'wavespeed')], 'c1');
      }),
    );
    show();
    expect(await screen.findByText('WaveSpeed key test failed (authentication)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('WaveSpeed key deleted')).toBeInTheDocument();
    expect(seen).toEqual(['-', 'c1']);
  });

  it('a refused list: the step-up dialog is shown, not a blank page', async () => {
    server.use(http.get(`${BASE}/me/provider-keys`, () => failure(403, 'recent_auth_required')));
    show();
    expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeInTheDocument();
  });

  it('loads only the listed operations', async () => {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => void seen.push(`${request.method} ${new URL(request.url).pathname}`));
    serve(status(), status({ provider: 'wavespeed' }));
    show();
    await screen.findByRole('heading', { name: 'WaveSpeed' });
    await waitFor(() => expect(seen).toContain('GET /api/v1/me/key-events'));
    expect(new Set(seen)).toEqual(new Set(['GET /api/v1/me', 'GET /api/v1/me/provider-keys', 'GET /api/v1/me/key-events']));
    server.events.removeAllListeners();
  });
});

describe('SCREEN-010 copy', () => {
  it('maps a key row to a card state', () => {
    expect(cardState(undefined)).toBe('none');
    expect(cardState(status() as never)).toBe('active');
    expect(cardState(status({ status: 'disabled' }) as never)).toBe('disabled');
  });
  it('words warnings by count and never names a key', () => {
    expect(replaceWarning(1)).toContain('1 job is running');
    expect(replaceWarning(3)).toContain('3 jobs are running');
    expect(deleteBody('OpenAI', 2, 'briefs').join(' ')).toContain('2 jobs running on it');
    expect(savedMessage('OpenAI', '7Q2d', 'unknown').body).toContain('checked by your first job');
  });
  it('every event kind has a label', () => {
    for (const kind of ['added', 'replaced', 'deleted', 'test_passed', 'test_failed', 'stored_untested', 'validated_by_job', 'auth_failed', 'disabled', 'disabled_by_operator', 'attempt_rate_limited', 'rewrapped', 'future']) {
      expect(presentEvent({ id: 'x', provider: 'openai', kind, at: '' } as never).label).toContain('OpenAI');
    }
    expect(formatEvent('nope')).toBe('');
    expect(formatTested(null)).toBeUndefined();
    expect(formatTested('nope')).toBeUndefined();
  });
});
