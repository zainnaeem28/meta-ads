import { getMe, healthLive } from '@shroomap/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiAbortError,
  ApiClientError,
  ApiMalformedResponseError,
  ApiNetworkError,
  clearEtags,
  getLastRequestId,
  ifMatch,
  installApiClient,
  isApiClientError,
  isClientHttpError,
  storedEtag,
} from './client';
import { server } from './msw.setup';

const ORIGIN = 'http://api.test';
let token: string | null = 'tok-1';
let uninstall: () => void;

beforeEach(() => {
  token = 'tok-1';
  uninstall = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve(token) });
});
afterEach(() => {
  uninstall();
  clearEtags();
});

const errorBody = (code: string, requestId = 'req-1') => ({
  success: false,
  error: { code, message: 'nope', details: [{ field: 'name', code: 'required', message: 'x' }] },
  metaData: { requestId, timestamp: '2026-01-01T00:00:00Z' },
});

describe('api client', () => {
  it('sends the Clerk bearer and captures X-Request-ID', async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json(
          { success: true, data: {} },
          { headers: { 'X-Request-ID': 'req-ok' } },
        );
      }),
    );
    const res = await getMe();
    expect(res.status).toBe(200);
    expect(auth).toBe('Bearer tok-1');
    expect(getLastRequestId()).toBe('req-ok');
  });

  it('omits the bearer when signed out and reads the token fresh per request', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return HttpResponse.json({ success: true });
      }),
    );
    token = null;
    await getMe();
    token = 'tok-2';
    await getMe();
    expect(seen).toEqual([null, 'Bearer tok-2']);
  });

  it('maps an error envelope to ApiClientError{status, code, details, requestId}', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () =>
        HttpResponse.json(errorBody('unauthenticated'), {
          status: 401,
          headers: { 'X-Request-ID': 'req-401' },
        }),
      ),
    );
    const err = await getMe().catch((e: unknown) => e);
    expect(isApiClientError(err)).toBe(true);
    expect(err).toMatchObject({
      kind: 'http',
      status: 401,
      code: 'unauthenticated',
      requestId: 'req-401',
      details: [{ field: 'name', code: 'required', message: 'x' }],
    });
    expect(isClientHttpError(err)).toBe(true);
  });

  it('falls back to the body requestId and tolerates a non-envelope error body', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () =>
        HttpResponse.json(errorBody('internal_error', 'req-body'), { status: 500 }),
      ),
    );
    expect(await getMe().catch((e: unknown) => e)).toMatchObject({
      status: 500,
      requestId: 'req-body',
    });
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () =>
        HttpResponse.json({ message: 'Cannot GET', statusCode: 404 }, { status: 404 }),
      ),
    );
    const err = await getMe().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, code: 'unknown_error', requestId: null, details: [] });
    expect(isClientHttpError(new Error('x'))).toBe(false);
  });

  it('keeps network, abort and malformed-response errors distinct', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => HttpResponse.error()));
    const net = await getMe().catch((e: unknown) => e);
    expect(net).toBeInstanceOf(ApiNetworkError);
    expect(net).toMatchObject({ kind: 'network', status: 0, code: 'network_error' });
    expect(isClientHttpError(net)).toBe(false);

    server.use(
      http.get(
        `${ORIGIN}/api/v1/me`,
        () => new HttpResponse('<html>', { status: 200, headers: { 'X-Request-ID': 'r9' } }),
      ),
    );
    const bad = await getMe().catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ApiMalformedResponseError);
    expect(bad).toMatchObject({
      kind: 'malformed',
      code: 'malformed_response',
      status: 200,
      requestId: 'r9',
    });

    server.use(
      http.get(`${ORIGIN}/api/v1/me`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({});
      }),
    );
    const ctl = new AbortController();
    const pending = getMe({ signal: ctl.signal }).catch((e: unknown) => e);
    ctl.abort();
    const aborted = await pending;
    expect(aborted).toBeInstanceOf(ApiAbortError);
    expect(aborted).toMatchObject({ kind: 'abort', code: 'request_aborted' });
    expect(aborted).toBeInstanceOf(ApiClientError);
  });

  it('stores the ETag of a read and returns it as If-Match', async () => {
    server.use(
      http.get(`${ORIGIN}/api/v1/me`, () =>
        HttpResponse.json({ success: true }, { headers: { ETag: '"3"' } }),
      ),
    );
    expect(ifMatch('/me')).toEqual({});
    await getMe();
    expect(storedEtag('/me')).toBe('"3"');
    expect(ifMatch('/me')).toEqual({ headers: { 'If-Match': '"3"' } });
    expect(storedEtag('not a url \u0000')).toBeUndefined();
  });

  it('serves health probes from the root, not under /api/v1', async () => {
    server.use(http.get(`${ORIGIN}/health/live`, () => HttpResponse.json({ status: 'ok' })));
    const res = await healthLive();
    expect(res.status).toBe(200);
  });

  it('uninstall restores fetch; installing twice does not stack wrappers', async () => {
    uninstall();
    const original = globalThis.fetch;
    const first = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve('tok-8') });
    const second = installApiClient({ origin: ORIGIN, getToken: () => Promise.resolve('tok-9') });
    expect(globalThis.fetch).not.toBe(original);
    second();
    expect(globalThis.fetch).toBe(original);
    first();
    expect(globalThis.fetch).toBe(original);
  });
});

describe('MSW strictness', () => {
  it('fails a request that no handler covers', async () => {
    server.resetHandlers();
    await expect(getMe()).rejects.toBeInstanceOf(ApiNetworkError);
  });
});

describe('createApiFetch inputs', () => {
  it('accepts URL and Request inputs and an injected fetch', async () => {
    const { createApiFetch } = await import('./client');
    const seen: string[] = [];
    const fetchImpl = ((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const f = createApiFetch({ origin: ORIGIN, getToken: () => Promise.resolve(null), fetchImpl });
    await f(new URL(`${ORIGIN}/api/v1/me?x=1`));
    await f(new Request(`${ORIGIN}/api/v1/me`));
    await f('/internal/metrics');
    expect(seen).toEqual([
      `${ORIGIN}/api/v1/me?x=1`,
      `${ORIGIN}/api/v1/me`,
      `${ORIGIN}/internal/metrics`,
    ]);
  });

  it('treats an empty 2xx body as undefined data and non-abort parse failure as malformed', async () => {
    server.use(http.get(`${ORIGIN}/api/v1/me`, () => new HttpResponse(null, { status: 204 })));
    const res = await getMe();
    expect(res).toMatchObject({ status: 204, data: undefined });
  });
});
