import { useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedEtag, clearEtags, getLastRequestId } from '../../src/lib/api/client';
import { keysQuery, meQuery } from '../../src/lib/query/queries';

// Server-supplied first data (ADR-014, T-20): per-request client and fetch, the user's own bearer, no-store, a deadline, and
// nothing of the token in what is handed to the browser.
const TOKEN = ['bearer', 'sentinel', 'leak', 'check'].join('-');
const ORIGIN = 'https://api.example.test';

const session = vi.hoisted(() => ({ value: null as null | { token: string; identity: string } }));
vi.mock('../../src/lib/auth/server-token', () => ({
  getServerSession: () => Promise.resolve(session.value),
}));
const incoming = vi.hoisted(() => ({ requestId: null as string | null }));
vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(new Headers(incoming.requestId ? { 'x-request-id': incoming.requestId } : {})),
}));

const envelope = (data: unknown) =>
  JSON.stringify({ success: true, data, metaData: { requestId: 'r' } });

type Call = { url: string; init: RequestInit };
let calls: Call[];
const stubApi = (answer: (url: string) => Response | Promise<Response>) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return answer(url);
    }),
  );
};

beforeEach(() => {
  vi.stubEnv('AUTH_MODE', 'clerk');
  vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', ORIGIN);
  session.value = { token: TOKEN, identity: 'user-a' };
  incoming.requestId = null;
  clearEtags();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const load = () => import('../../src/lib/query/server-prefetch');

describe('prefetchFirstData', () => {
  it('reads as the requesting user, no-store, and hands the answers over as dehydrated state', async () => {
    stubApi((url) =>
      url.endsWith('/me')
        ? new Response(envelope({ role: 'owner' }), {
            headers: { ETag: '"me-1"', 'X-Request-ID': 'r-9' },
          })
        : new Response(envelope([])),
    );
    incoming.requestId = 'req-123';
    const { prefetchFirstData } = await load();
    const data = await prefetchFirstData(({ client, fetcher }) => [
      client.prefetchQuery(meQuery(fetcher)),
      client.prefetchQuery(keysQuery(fetcher)),
    ]);
    expect(data?.identity).toBe('user-a');
    expect(data?.state.queries.map((q) => q.queryKey[0]).sort()).toEqual([
      '/me',
      '/me/provider-keys',
    ]);
    expect(data?.etags).toEqual({ '/me': '"me-1"' });
    expect(typeof data?.now).toBe('number');
    expect(calls).toHaveLength(2);
    for (const { url, init } of calls) {
      expect(url.startsWith(`${ORIGIN}/api/v1/`)).toBe(true);
      expect(init.cache).toBe('no-store');
      expect(init.credentials).toBe('omit');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.get('x-request-id')).toBe('req-123');
    }
  });

  it('keeps nothing in memory shared between requests: no ETag in the browser store, no request id (SEC-M1)', async () => {
    stubApi(
      () => new Response(envelope({}), { headers: { ETag: '"v1"', 'X-Request-ID': 'srv-1' } }),
    );
    const before = getLastRequestId();
    const { prefetchFirstData } = await load();
    await prefetchFirstData(({ client, fetcher }) => [client.prefetchQuery(meQuery(fetcher))]);
    expect(storedEtag('/me')).toBeUndefined();
    expect(getLastRequestId()).toBe(before);
  });

  it('uses a new client for every request and never patches the global fetch', async () => {
    stubApi(() => new Response(envelope({})));
    const patched = globalThis.fetch;
    const { prefetchFirstData } = await load();
    const seen: unknown[] = [];
    for (let i = 0; i < 2; i += 1)
      await prefetchFirstData(({ client, fetcher }) => {
        seen.push(client);
        return [client.prefetchQuery(meQuery(fetcher))];
      });
    expect(seen[0]).not.toBe(seen[1]);
    expect(globalThis.fetch).toBe(patched);
    expect(
      (globalThis as { __SHROOMAP_API_BASE__?: string }).__SHROOMAP_API_BASE__,
    ).toBeUndefined();
  });

  it('leaves a failed, 401, 403 or 404 read out of the state, so the browser reads it as before', async () => {
    stubApi((url) => {
      if (url.endsWith('/me'))
        return new Response(JSON.stringify({ success: false, error: { code: 'not_found' } }), {
          status: 404,
        });
      return new Response(envelope([]));
    });
    const { prefetchFirstData } = await load();
    const data = await prefetchFirstData(({ client, fetcher }) => [
      client.prefetchQuery(meQuery(fetcher)),
      client.prefetchQuery(keysQuery(fetcher)),
    ]);
    expect(data?.state.queries.map((q) => q.queryKey[0])).toEqual(['/me/provider-keys']);
    expect(JSON.stringify(data)).not.toContain('not_found');
  });

  it('gives up at the deadline: the late read is not in the state and the request is not held longer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      stubApi((url) =>
        url.endsWith('/me') ? new Promise<Response>(() => undefined) : new Response(envelope([])),
      );
      const { prefetchFirstData, PREFETCH_DEADLINE_MS } = await load();
      const pending = prefetchFirstData(({ client, fetcher }) => [
        client.prefetchQuery(meQuery(fetcher)),
        client.prefetchQuery(keysQuery(fetcher)),
      ]);
      await vi.advanceTimersByTimeAsync(PREFETCH_DEADLINE_MS + 50);
      const data = await pending;
      expect(data?.state.queries.map((q) => q.queryKey[0])).toEqual(['/me/provider-keys']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns nothing without a session, and does not call the api', async () => {
    session.value = null;
    stubApi(() => new Response(envelope({})));
    const { prefetchFirstData } = await load();
    expect(
      await prefetchFirstData(({ client, fetcher }) => [client.prefetchQuery(meQuery(fetcher))]),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('never carries the bearer in what the page renders, also when every read fails (SEC-M4)', async () => {
    stubApi(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'internal_error', message: `bad ${TOKEN}` } }),
          { status: 500 },
        ),
    );
    const logs: string[] = [];
    for (const level of ['log', 'error', 'warn', 'info'] as const)
      vi.spyOn(console, level).mockImplementation(
        (...args) => void logs.push(args.map(String).join(' ')),
      );
    const { prefetchFirstData } = await load();
    const failed = await prefetchFirstData(({ client, fetcher }) => [
      client.prefetchQuery(meQuery(fetcher)),
    ]);
    stubApi(() => new Response(envelope({ role: 'owner' }), { headers: { ETag: '"x"' } }));
    const ok = await prefetchFirstData(({ client, fetcher }) => [
      client.prefetchQuery(meQuery(fetcher)),
    ]);
    expect(JSON.stringify([failed, ok])).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    vi.restoreAllMocks();
  });
});

describe('forwarding rules', () => {
  it('forwards the bearer only to a configured https origin outside local mode (SEC-L3)', async () => {
    const { serverApiOrigin } = await load();
    expect(serverApiOrigin({ AUTH_MODE: 'clerk', NEXT_PUBLIC_API_ORIGIN: ORIGIN })).toBe(ORIGIN);
    expect(
      serverApiOrigin({ AUTH_MODE: 'clerk', NEXT_PUBLIC_API_ORIGIN: 'http://api.example.test' }),
    ).toBeNull();
    expect(serverApiOrigin({ AUTH_MODE: 'clerk', NEXT_PUBLIC_API_ORIGIN: 'ftp://x' })).toBeNull();
    expect(serverApiOrigin({ AUTH_MODE: 'clerk', NEXT_PUBLIC_API_ORIGIN: 'not a url' })).toBeNull();
    expect(serverApiOrigin({ AUTH_MODE: 'bogus', NEXT_PUBLIC_API_ORIGIN: ORIGIN })).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', 'http://127.0.0.1:4700');
    expect(
      serverApiOrigin({ AUTH_MODE: 'local', NEXT_PUBLIC_API_ORIGIN: 'http://127.0.0.1:4700' }),
    ).toBe('http://127.0.0.1:4700');
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', '');
    expect(serverApiOrigin({ AUTH_MODE: 'clerk', NEXT_PUBLIC_API_ORIGIN: '' })).toBeNull();
  });

  it('refuses to forward when the runtime origin is not the one the build was made with (SEC-L3)', async () => {
    const { serverApiOrigin } = await load();
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', 'https://built.example.test');
    expect(
      serverApiOrigin({ AUTH_MODE: 'clerk', NEXT_PUBLIC_API_ORIGIN: 'https://other.example.test' }),
    ).toBeNull();
    expect(
      serverApiOrigin({ AUTH_MODE: 'clerk', NEXT_PUBLIC_API_ORIGIN: 'https://built.example.test' }),
    ).toBe('https://built.example.test');
  });

  it('puts only a campaign id into a path the bearer is forwarded to (SEC-L2)', async () => {
    const { campaignIdParam } = await load();
    const id = '3f8c1c1e-7b9a-4f43-9a52-0e2f1a6b7c10';
    expect(campaignIdParam(id)).toBe(id);
    for (const bad of ['..%2fme', '../me', 'a/b', '', 'not-a-uuid', `${id}/x`])
      expect(campaignIdParam(bad), bad).toBeNull();
  });
});

describe('shared query definitions', () => {
  it('give the browser and the server the same keys, and the hydrated ones 30 s of freshness', () => {
    const server = meQuery(globalThis.fetch);
    const browser = meQuery();
    expect(server.queryKey).toEqual(browser.queryKey);
    expect(server.staleTime).toBe(30_000);
    expect(keysQuery().staleTime).toBe(30_000);
    expect(typeof useQuery).toBe('function');
  });
});
