import { ROUTES } from '../errors/routes';

/** What the policy is built from: named environment values only, read by the caller at request time. */
export interface SecurityEnv {
  APP_ENV?: string | undefined;
  NODE_ENV?: string | undefined;
  NEXT_PUBLIC_API_ORIGIN?: string | undefined;
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?: string | undefined;
  NEXT_PUBLIC_SENTRY_DSN?: string | undefined;
  R2_ENDPOINT?: string | undefined;
  R2_BUCKET?: string | undefined;
}

const HOSTED = new Set(['staging', 'production']);
export const isHosted = (env: SecurityEnv): boolean => HOSTED.has(env.APP_ENV ?? '');

/** The provider-keys page: the one route where only the app and the identity provider's session script may run (REQ-019). */
export const isKeyPage = (pathname: string): boolean =>
  pathname === ROUTES.providerKeys || pathname.startsWith(`${ROUTES.providerKeys}/`);

const originOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
};

/** The identity provider's frontend API host, encoded in the publishable key (`pk_test_<base64 of host$>`). */
export function clerkFrontendOrigin(key: string | undefined): string | null {
  const encoded = key?.match(/^pk_(?:test|live)_(.+)$/)?.[1];
  if (!encoded) return null;
  try {
    const host = atob(encoded).replace(/\$$/, '');
    return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
  } catch {
    return null;
  }
}

/** Signed media URLs point at the private bucket's origin, path-style or virtual-host style. */
export function storageOrigins(env: SecurityEnv): string[] {
  const endpoint = originOf(env.R2_ENDPOINT);
  if (!endpoint) return [];
  const origins = [endpoint];
  if (env.R2_BUCKET) {
    const url = new URL(endpoint);
    origins.push(`${url.protocol}//${env.R2_BUCKET}.${url.host}`);
  }
  return origins;
}

const CLERK_CHALLENGE = 'https://challenges.cloudflare.com';
const CLERK_IMAGES = 'https://img.clerk.com';

/**
 * The Content-Security-Policy of one response (enforced, never report-only). Scripts: the app and the nonce-marked
 * framework scripts, plus the identity provider's origins; the key page gets the provider's session script only.
 */
export function buildCsp(input: { nonce: string; pathname: string; env: SecurityEnv }): string {
  const { nonce, pathname, env } = input;
  const keyPage = isKeyPage(pathname);
  const api = originOf(env.NEXT_PUBLIC_API_ORIGIN);
  const provider = clerkFrontendOrigin(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const storage = storageOrigins(env);
  const sentry = originOf(env.NEXT_PUBLIC_SENTRY_DSN);

  const script = ["'self'", `'nonce-${nonce}'`];
  if (env.NODE_ENV === 'development') script.push("'unsafe-eval'");
  if (provider) script.push(provider);
  if (provider && !keyPage) script.push(CLERK_CHALLENGE);

  const connect = [
    "'self'",
    ...(api ? [api] : []),
    ...(provider ? [provider] : []),
    ...(sentry ? [sentry] : []),
  ];
  const images = [
    "'self'",
    'data:',
    'blob:',
    ...storage,
    ...(provider && !keyPage ? [CLERK_IMAGES] : []),
  ];

  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': script,
    'script-src-attr': ["'none'"],
    // Inline style attributes and the provider widgets' style elements; no inline script is ever allowed.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': images,
    'media-src': ["'self'", 'blob:', 'data:', ...storage],
    'font-src': ["'self'", 'data:'],
    'connect-src': connect,
    'frame-src': provider && !keyPage ? [CLERK_CHALLENGE] : ["'none'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (isHosted(env)) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** One fresh nonce per request: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** Everything a response carries on top of the static list, including the policy itself. */
export function dynamicHeaders(input: {
  nonce: string;
  pathname: string;
  env: SecurityEnv;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': buildCsp(input),
  };
  if (isHosted(input.env))
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  // Every response the middleware answers is per identity (a page, a redirect to sign-in): none may be stored by the
  // browser or a shared cache (TC-ZT-07). Build output and brand files do not pass here and stay cacheable.
  headers['Cache-Control'] = 'no-store';
  return headers;
}
