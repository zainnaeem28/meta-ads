import type { ErrorResponse } from '@shroomap/contracts';
import {
  ApiAbortError,
  ApiClientError,
  ApiMalformedResponseError,
  ApiNetworkError,
} from './errors';
import { rememberEtag } from './etag-store';

export * from './errors';
export * from './etag-store';
export * from './idempotency';

export type GetToken = () => Promise<string | null>;

export interface ApiClientConfig {
  /** Origin of the api, without the `/api/v1` suffix. Empty means same origin. */
  origin: string;
  getToken: GetToken;
  fetchImpl?: typeof fetch;
}

const API_PREFIX = '/api/v1';
// Operations served at the root, not under /api/v1 (openapi: health and internal metrics override `servers`).
const ROOT_PATHS = /^\/(health|internal)(\/|$)/;

let lastRequestId: string | null = null;
/** X-Request-ID of the most recent response, for support messages and error alerts. */
export const getLastRequestId = (): string | null => lastRequestId;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const asAbort = (err: unknown): boolean => isRecord(err) && err.name === 'AbortError';

/** `Retry-After` as whole seconds (OpenAPI `RetryAfter`: integer, minimum 1); anything else is ignored. */
const parseRetryAfter = (value: string | null): number | null => {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  return seconds >= 1 ? seconds : null;
};

const parseBody = (text: string): unknown => (text.length > 0 ? JSON.parse(text) : undefined);

/** Builds the fetch used for every generated-client call: bearer, request id, error mapping, ETag capture. */
export const createApiFetch = (config: ApiClientConfig): typeof fetch => {
  const doFetch =
    config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://local.invalid');
    const path = url.pathname.startsWith(API_PREFIX)
      ? url.pathname.slice(API_PREFIX.length)
      : url.pathname;
    const target = `${config.origin}${ROOT_PATHS.test(path) ? path : `${API_PREFIX}${path}`}${url.search}`;

    const headers = new Headers(init?.headers);
    const token = await config.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let response: Response;
    try {
      response = await doFetch(target, { ...init, headers });
    } catch (err) {
      throw asAbort(err) ? new ApiAbortError(err) : new ApiNetworkError(err);
    }

    const requestId = response.headers.get('X-Request-ID');
    if (requestId) lastRequestId = requestId;

    let body: unknown;
    try {
      body = parseBody(await response.clone().text());
    } catch (err) {
      throw asAbort(err)
        ? new ApiAbortError(err)
        : new ApiMalformedResponseError(response.status, requestId, err);
    }

    if (!response.ok) {
      const error =
        isRecord(body) && isRecord(body.error) ? (body.error as ErrorResponse['error']) : null;
      throw new ApiClientError({
        status: response.status,
        code: typeof error?.code === 'string' ? error.code : 'unknown_error',
        message: error?.message,
        details: Array.isArray(error?.details) ? error.details : [],
        requestId:
          requestId ??
          (isRecord(body) && isRecord(body.metaData) ? String(body.metaData.requestId) : null),
        retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
      });
    }

    rememberEtag(path, response.headers.get('ETag'));
    return response;
  };
};

let uninstallCurrent: (() => void) | null = null;

/**
 * Points the generated client's mutator (`@shroomap/contracts` http.ts, which calls the global `fetch` and reads
 * `__SHROOMAP_API_BASE__`) at this api. Only requests to the api prefix take the wrapped path. A second call
 * replaces the first, so a re-run (React strict mode, hot reload) never stacks wrappers.
 */
export const installApiClient = (config: ApiClientConfig): (() => void) => {
  uninstallCurrent?.();
  const g = globalThis as { __SHROOMAP_API_BASE__?: string; fetch: typeof fetch };
  const previousFetch = g.fetch;
  const previousBase = g.__SHROOMAP_API_BASE__;
  const apiFetch = createApiFetch({
    ...config,
    fetchImpl: config.fetchImpl ?? previousFetch.bind(globalThis),
  });
  const prefix = `${config.origin}${API_PREFIX}`;
  g.__SHROOMAP_API_BASE__ = prefix;
  const installed = ((input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return raw.startsWith(prefix)
      ? apiFetch(input, init)
      : previousFetch.call(globalThis, input, init);
  }) as typeof fetch;
  g.fetch = installed;
  const uninstall = () => {
    if (g.fetch === installed) g.fetch = previousFetch;
    g.__SHROOMAP_API_BASE__ = previousBase;
    if (uninstallCurrent === uninstall) uninstallCurrent = null;
  };
  uninstallCurrent = uninstall;
  return uninstall;
};
