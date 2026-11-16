import { ROUTES } from '../errors/routes';
import { safeReturnPath, signInUrl } from '../errors/session';

/** Pages that are reachable without a session: the provider-hosted sign-in and second-step pages. */
const AUTH_PREFIXES = [ROUTES.signIn, ROUTES.mfa] as const;

/** Test-only pages that answer 404 unless their own build or environment flag enables them. */
const PROBE_PREFIXES = ['/gallery', '/api-probe', '/error-probe'] as const;

const within = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export const isAuthPage = (pathname: string): boolean =>
  AUTH_PREFIXES.some((prefix) => within(pathname, prefix));

/** Test-only pages: answered without consulting the identity provider (they 404 on their own where disabled). */
export const isProbePath = (pathname: string): boolean =>
  PROBE_PREFIXES.some((prefix) => within(pathname, prefix));

export const isPublicPath = (pathname: string): boolean =>
  isAuthPage(pathname) || isProbePath(pathname);

export type SessionKind = 'active' | 'expired' | 'none';

export type RouteDecision = { kind: 'next' } | { kind: 'redirect'; to: string };

/**
 * What the middleware does with a request: anonymous visitors go to sign-in with the requested URL as the return path
 * (an ended session adds the session-expired message); the home route sends a signed-in user to the campaign list.
 */
export function decideRoute(input: { pathname: string; search: string; session: SessionKind }): RouteDecision {
  const { pathname, search, session } = input;
  if (isPublicPath(pathname)) return { kind: 'next' };
  if (session === 'active') {
    return pathname === ROUTES.home ? { kind: 'redirect', to: ROUTES.campaigns } : { kind: 'next' };
  }
  if (pathname === ROUTES.home) {
    return { kind: 'redirect', to: session === 'expired' ? signInUrl(ROUTES.home) : ROUTES.signIn };
  }
  const target = `${pathname}${search}`;
  if (session === 'expired') return { kind: 'redirect', to: signInUrl(target) };
  return { kind: 'redirect', to: `${ROUTES.signIn}?return=${encodeURIComponent(safeReturnPath(target))}` };
}
