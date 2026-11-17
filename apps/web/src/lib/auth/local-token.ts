export type FetchLocalToken = (() => Promise<string | null>) & {
  /** Id of the user the last token was issued for (null before the first token or after a failure). */
  readonly userId: () => string | null;
};

/**
 * Bearer source for a local-mode web (no Clerk key): asks the web's own `/local-token` route, which exchanges the local
 * session for the api's local-mode token. Cached until shortly before expiry; any failure (no session, route absent
 * because the build is not in local mode) yields no bearer, as before.
 */
export function createLocalTokenGetter(
  // eslint-disable-next-line no-restricted-properties -- same-origin web route, not an api operation
  fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a),
  now = Date.now,
): FetchLocalToken {
  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string | null> | null = null;
  let userId: string | null = null;
  const load = async (): Promise<string | null> => {
    try {
      const res = await fetchImpl('/local-token', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) {
        cached = null;
        userId = null;
        return null;
      }
      const body = (await res.json()) as {
        token?: unknown;
        sub?: unknown;
        expiresInSeconds?: unknown;
      };
      if (typeof body.token !== 'string') return null;
      const ttl = typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : 3600;
      userId = typeof body.sub === 'string' ? body.sub : null;
      cached = { token: body.token, until: now() + Math.max(0, ttl - 60) * 1000 };
      return body.token;
    } catch {
      return null;
    }
  };
  const get = () => {
    if (cached && cached.until > now()) return Promise.resolve(cached.token);
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  };
  return Object.assign(get, { userId: () => userId });
}
