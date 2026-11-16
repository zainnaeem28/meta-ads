import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextMiddleware, type NextRequest } from 'next/server';
import { withSecurityHeaders } from './lib/auth/headers';
import { readLocalSession, LOCAL_SESSION_COOKIE } from './lib/auth/local-session';
import { resolveAuthMode } from './lib/auth/mode';
import { decideRoute, isProbePath, type SessionKind } from './lib/auth/route-policy';

/** Redirects carry the request's own origin; the path comes from the policy and is always a same-origin relative path. */
function respond(request: NextRequest, session: SessionKind): NextResponse {
  const decision = decideRoute({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    session,
  });
  if (decision.kind === 'next') return withSecurityHeaders(NextResponse.next());
  return withSecurityHeaders(NextResponse.redirect(new URL(decision.to, request.url)));
}

type ClerkHandler = NextMiddleware;

// Built on first use: the provider's middleware refuses to be created without keys, and local mode has none.
let clerk: ClerkHandler | undefined;
const clerkHandler = (): ClerkHandler =>
  (clerk ??= clerkMiddleware(async (auth, request) => {
    const { userId } = await auth();
    return respond(request, userId ? 'active' : 'none');
  }));

async function local(request: NextRequest): Promise<NextResponse> {
  const state = await readLocalSession(request.cookies.get(LOCAL_SESSION_COOKIE)?.value);
  return respond(request, state.status);
}

// Named reads of process.env: the edge bundle resolves each variable at request time (the object is not passed whole).
const authEnv = () => ({
  APP_ENV: process.env.APP_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
});

export default function middleware(request: NextRequest, event: Parameters<ClerkHandler>[1]) {
  if (isProbePath(request.nextUrl.pathname)) return respond(request, 'none');
  return resolveAuthMode(authEnv()) === 'clerk' ? clerkHandler()(request, event) : local(request);
}

// Every route except the framework's build output and the static brand files.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon|apple-touch-icon|icon-|site\\.webmanifest|social-preview).*)',
  ],
};
