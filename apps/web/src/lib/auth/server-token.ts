import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { LOCAL_SESSION_COOKIE, readLocalSession } from './local-session';
import { resolveAuthMode } from './mode';

/** The exchange (Clerk token or local token) gets this long; the request never waits longer for a session (ADR-014, SEC-L1). */
export const SESSION_DEADLINE_MS = 1000;

const LOCAL_API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN || 'http://localhost:4000';

export type LocalTokenResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly sub: string | null;
      readonly expiresInSeconds: number;
    }
  | { readonly ok: false; readonly reason: 'no-session' | 'unavailable' };

/**
 * Local mode only: turns the signed local session cookie (httpOnly, so the page cannot read the email) into a bearer from
 * the api's local token route (`POST /api/v1/dev/token`). The one copy of the exchange: `/local-token` and the server
 * prefetch both call it. The api still verifies the token fully.
 */
export async function issueLocalToken(
  cookieValue: string | undefined,
  signal?: AbortSignal,
): Promise<LocalTokenResult> {
  const state = await readLocalSession(cookieValue);
  if (state.status !== 'active') return { ok: false, reason: 'no-session' };
  try {
    // eslint-disable-next-line no-restricted-globals -- the api's local token route is not part of the generated client
    const res = await fetch(`${LOCAL_API_ORIGIN}/api/v1/dev/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: state.session.email }),
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    // The api answers its standard envelope: { success, data: { token, sub, expiresInSeconds }, metaData }.
    const body = (await res.json()) as {
      data?: { token?: unknown; sub?: unknown; expiresInSeconds?: unknown };
    };
    const data = body.data;
    if (typeof data?.token !== 'string') return { ok: false, reason: 'unavailable' };
    return {
      ok: true,
      token: data.token,
      sub: typeof data.sub === 'string' ? data.sub : null,
      expiresInSeconds: typeof data.expiresInSeconds === 'number' ? data.expiresInSeconds : 3600,
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** What the server holds for one request: the requesting user's own bearer and the user id. Never a service credential. */
export interface ServerSession {
  readonly token: string;
  readonly identity: string;
}

const within = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });

const clerkSession = async (): Promise<ServerSession | null> => {
  const { userId, getToken } = await auth();
  if (!userId) return null;
  const token = await getToken();
  return token ? { token, identity: userId } : null;
};

const localSession = async (): Promise<ServerSession | null> => {
  const jar = await cookies();
  const result = await issueLocalToken(
    jar.get(LOCAL_SESSION_COOKIE)?.value,
    AbortSignal.timeout(SESSION_DEADLINE_MS),
  );
  return result.ok && result.sub ? { token: result.token, identity: result.sub } : null;
};

const mode = (): 'local' | 'clerk' | null => {
  try {
    return resolveAuthMode(process.env);
  } catch {
    return null;
  }
};

/**
 * The signed-in user's session for this request, or null (no session, no mode, a failure or the deadline). Shared by the
 * root layout and the route's prefetch through `React.cache`, so there is one lookup per request.
 */
export const getServerSession = cache(async (): Promise<ServerSession | null> => {
  const authMode = mode();
  if (!authMode) return null;
  return within(authMode === 'clerk' ? clerkSession() : localSession(), SESSION_DEADLINE_MS);
});

/** The user id for the browser providers' seed (a user id, never a token); null when nobody is signed in. */
export const getServerIdentity = cache(
  async (): Promise<string | null> => (await getServerSession())?.identity ?? null,
);
