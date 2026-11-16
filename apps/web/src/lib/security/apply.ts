import { NextResponse, type NextRequest } from 'next/server';
import { dynamicHeaders, newNonce, type SecurityEnv } from './csp';
import { STATIC_SECURITY_HEADERS } from './static-headers.mjs';

/** Named reads of process.env: the edge bundle resolves each variable at request time (the object is not passed whole). */
export const securityEnv = (): SecurityEnv => ({
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_BUCKET: process.env.R2_BUCKET,
});

export interface SecurityContext {
  nonce: string;
  headers: Record<string, string>;
}

/** One nonce and policy per request. */
export function securityContext(request: NextRequest, env: SecurityEnv = securityEnv()): SecurityContext {
  const nonce = newNonce();
  const headers = {
    ...STATIC_SECURITY_HEADERS,
    ...dynamicHeaders({ nonce, pathname: request.nextUrl.pathname, env }),
  };
  return { nonce, headers };
}

/** A pass-through whose forwarded request carries the policy and nonce, so the framework marks its own scripts. */
export function passThrough(request: NextRequest, context: SecurityContext): NextResponse {
  const forwarded = new Headers(request.headers);
  forwarded.set('x-nonce', context.nonce);
  forwarded.set('Content-Security-Policy', context.headers['Content-Security-Policy']!);
  return withSecurityHeaders(NextResponse.next({ request: { headers: forwarded } }), context);
}

export function withSecurityHeaders<T extends { headers: Headers }>(response: T, context: SecurityContext): T {
  for (const [name, value] of Object.entries(context.headers)) response.headers.set(name, value);
  return response;
}
