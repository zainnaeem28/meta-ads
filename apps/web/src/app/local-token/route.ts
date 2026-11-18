import { NextResponse, type NextRequest } from 'next/server';
import { LOCAL_SESSION_COOKIE } from '../../lib/auth/local-session';
import { resolveAuthMode } from '../../lib/auth/mode';
import { issueLocalToken } from '../../lib/auth/server-token';

export const dynamic = 'force-dynamic';

/**
 * Local mode only (AUTH_MODE=local, refused in staging and production; 404 in any other mode). Turns the signed local
 * session cookie into a bearer from the api's local token route, so the signed-in screens call the real api (the exchange
 * is shared with the server prefetch in `server-token.ts`). The api still verifies the token fully.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const local = (() => {
    try {
      return resolveAuthMode(process.env) === 'local';
    } catch {
      return false;
    }
  })();
  if (!local) return new NextResponse(null, { status: 404 });
  const result = await issueLocalToken(request.cookies.get(LOCAL_SESSION_COOKIE)?.value);
  if (!result.ok) {
    return NextResponse.json(
      { token: null },
      { status: result.reason === 'no-session' ? 401 : 502 },
    );
  }
  return NextResponse.json(
    { token: result.token, sub: result.sub, expiresInSeconds: result.expiresInSeconds },
    { headers: { 'cache-control': 'no-store' } },
  );
}
