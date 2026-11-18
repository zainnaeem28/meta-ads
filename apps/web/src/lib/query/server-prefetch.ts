import 'server-only';
import { dehydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';
import { headers } from 'next/headers';
import { createApiFetch } from '../api/client';
import { resolveAuthMode } from '../auth/mode';
import { getServerSession } from '../auth/server-token';

/** All of a route's first-data reads share this deadline (ADR-014). A late or failed read is simply left to the browser. */
export const PREFETCH_DEADLINE_MS = 1000;

/** What a route hands its first-data boundary. `identity` is the user the data was read for; the token never appears. */
export interface FirstData {
  identity: string;
  state: DehydratedState;
  /** Response ETags by resource path, so a write right after first paint can send `If-Match` (ADR-010). */
  etags: Record<string, string>;
  /** Epoch ms on the server when the data was read: the first render's clock, so labels match the server's HTML. */
  now: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A campaign id from a route param, or null: only an id may reach the path the bearer is forwarded to (SEC-L2). */
export const campaignIdParam = (value: string): string | null => (UUID.test(value) ? value : null);

/**
 * The api origin the server forwards the user's bearer to, or null when it must not (no origin; not https outside
 * `AUTH_MODE=local`; the origin differs from the one the build was made with). SEC-L3.
 */
export function serverApiOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const built = process.env.NEXT_PUBLIC_API_ORIGIN;
  // A computed key is not inlined at build time, so this is the runtime value.
  const runtime = env['NEXT_PUBLIC_API_' + 'ORIGIN'];
  const origin = runtime || built;
  if (!origin) return null;
  if (built && runtime && built !== runtime) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  let local: boolean;
  try {
    local = resolveAuthMode(env) === 'local';
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !local) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

const requestId = async (): Promise<string | null> => {
  try {
    const value = (await headers()).get('x-request-id');
    return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
  } catch {
    return null;
  }
};

export type PrefetchPlan = (ctx: {
  client: QueryClient;
  /** The per-request fetch to pass to every shared query definition. */
  fetcher: typeof fetch;
}) => Promise<unknown>[];

/**
 * Reads a route's first-viewport GETs as the requesting user, in parallel under one deadline, and returns them as
 * dehydrated state. Per request: a new QueryClient, a per-request fetch (never `installApiClient`, which patches the
 * global one), `no-store`, the user's own bearer (never logged, stored, dehydrated or rendered) and a request-scoped ETag
 * map. Anything that fails, times out or answers 401/403/404 is not dehydrated, and the browser reads it as it always did.
 */
export async function prefetchFirstData(plan: PrefetchPlan): Promise<FirstData | null> {
  try {
    const session = await getServerSession();
    const origin = serverApiOrigin();
    if (!session || !origin) return null;
    const deadline = AbortSignal.timeout(PREFETCH_DEADLINE_MS);
    const forwarded = await requestId();
    const etags: Record<string, string> = {};
    // One try each: a failed read is the browser's to retry, and a retry here would only eat the deadline.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetcher = createApiFetch({
      origin,
      getToken: () => Promise.resolve(session.token),
      isolated: {
        onEtag: (path, etag) => {
          etags[path] = etag;
        },
      },
      fetchImpl: (input, init) => {
        const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
        const next = new Headers(init?.headers);
        if (forwarded) next.set('X-Request-ID', forwarded);
        // eslint-disable-next-line no-restricted-globals -- the server's own per-request transport for the api
        return fetch(input, { ...init, cache: 'no-store', signal, headers: next });
      },
    });
    const now = Date.now();
    await Promise.race([
      Promise.allSettled(plan({ client, fetcher })),
      new Promise<void>((resolve) =>
        deadline.addEventListener('abort', () => resolve(), { once: true }),
      ),
    ]);
    await client.cancelQueries();
    return { identity: session.identity, state: dehydrate(client), etags, now };
  } catch {
    return null;
  }
}
