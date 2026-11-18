/** A fetch to use instead of the global one (the server prefetch passes its per-request fetch; the browser passes none). */
export type ApiFetcher = typeof fetch;

/**
 * One GET of the api, answering the parsed body. The browser path is the generated client's: the global fetch, which
 * `installApiClient` has wrapped (bearer, error mapping, ETags), against `__SHROOMAP_API_BASE__`. The server path takes
 * its own per-request fetch, so nothing global is patched and nothing is shared between requests (ADR-014).
 */
export async function apiGet<T>(
  url: string,
  init: { signal?: AbortSignal | undefined },
  fetcher?: ApiFetcher,
): Promise<T> {
  const base = fetcher
    ? ''
    : ((globalThis as { __SHROOMAP_API_BASE__?: string }).__SHROOMAP_API_BASE__ ?? '');
  // eslint-disable-next-line no-restricted-globals -- the same call the generated client's mutator makes
  const response = await (fetcher ?? fetch)(`${base}${url}`, {
    credentials: 'omit',
    method: 'GET',
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}
