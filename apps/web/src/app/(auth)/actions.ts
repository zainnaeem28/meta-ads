'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LOCAL_DEV_CODE, LOCAL_DEV_PASSWORD } from '../../lib/auth/local-dev';
import {
  LOCAL_SESSION_COOKIE,
  LOCAL_SESSION_TTL_SECONDS,
  localSubject,
  readLocalSession,
  signLocalSession,
} from '../../lib/auth/local-session';
import { resolveAuthMode } from '../../lib/auth/mode';
import { safeReturnPath } from '../../lib/errors/session';
import { ROUTES } from '../../lib/errors/routes';

export interface LocalFormState {
  error: 'invalid' | 'unavailable' | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
};

const localOnly = (): boolean => resolveAuthMode(process.env) === 'local';

const sessionCookie = (value: string, maxAge: number) =>
  ({
    name: LOCAL_SESSION_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge,
  }) as const;

/** Local sign-in (AUTH_MODE=local): any well-formed email with the local password; returns to the screened return path. */
export async function localSignIn(_: LocalFormState, data: FormData): Promise<LocalFormState> {
  if (!localOnly()) return { error: 'unavailable' };
  const email = text(data, 'email').trim();
  if (!EMAIL.test(email) || text(data, 'password') !== LOCAL_DEV_PASSWORD) return { error: 'invalid' };
  const exp = Math.floor(Date.now() / 1000) + LOCAL_SESSION_TTL_SECONDS;
  const token = await signLocalSession({ sub: await localSubject(email), email, exp });
  (await cookies()).set(sessionCookie(token, LOCAL_SESSION_TTL_SECONDS));
  redirect(safeReturnPath(text(data, 'return')));
}

/** Local second step: the local code, for a user who already holds a local session. */
export async function localVerify(_: LocalFormState, data: FormData): Promise<LocalFormState> {
  if (!localOnly()) return { error: 'unavailable' };
  const jar = await cookies();
  const state = await readLocalSession(jar.get(LOCAL_SESSION_COOKIE)?.value);
  if (state.status !== 'active') redirect(ROUTES.signIn);
  if (text(data, 'code').replace(/\s/g, '') !== LOCAL_DEV_CODE) return { error: 'invalid' };
  redirect(safeReturnPath(text(data, 'return')));
}

/** Local sign-out: clears the cookie and returns to sign-in. */
export async function localSignOut(): Promise<void> {
  if (localOnly()) (await cookies()).set(sessionCookie('', 0));
  redirect(ROUTES.signIn);
}
