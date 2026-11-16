import { ROUTES } from './routes';

const MAX_RETURN_LENGTH = 2000;

const hasControlChars = (text: string): boolean =>
  Array.from(text).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/**
 * A return path is accepted only as a same-origin relative path: one leading slash, no scheme, no host, no control
 * characters, and not the sign-in page itself (no redirect loop). Anything else becomes the home path.
 */
export const safeReturnPath = (raw: string | null | undefined): string => {
  if (!raw || raw.length > MAX_RETURN_LENGTH) return ROUTES.home;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || hasControlChars(raw))
    return ROUTES.home;
  let url: URL;
  try {
    url = new URL(raw, 'http://local.invalid');
  } catch {
    return ROUTES.home;
  }
  if (url.origin !== 'http://local.invalid') return ROUTES.home;
  if (url.pathname === ROUTES.signIn || url.pathname.startsWith(`${ROUTES.signIn}/`))
    return ROUTES.home;
  return `${url.pathname}${url.search}${url.hash}`;
};

/** Sign-in URL for an ended session: the page shows the session-expired message and returns to `current`. */
export const signInUrl = (current: string): string =>
  `${ROUTES.signIn}?reason=session-expired&return=${encodeURIComponent(safeReturnPath(current))}`;

/** Reads the return path back from the sign-in page's query string (already screened). */
export const returnPathFrom = (search: string): string =>
  safeReturnPath(new URLSearchParams(search).get('return'));

/** True when the sign-in page should show "Your session ended. Sign in to continue." above the provider form. */
export const isSessionExpiredVisit = (search: string): boolean =>
  new URLSearchParams(search).get('reason') === 'session-expired';
