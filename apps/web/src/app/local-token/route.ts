import { NextResponse, type NextRequest } from 'next/server';
import { LOCAL_SESSION_COOKIE, readLocalSession } from '../../lib/auth/local-session';
import { resolveAuthMode } from '../../lib/auth/mode';

export const dynamic = 'force-dynamic';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN || 'http://localhost:4000';

/**
 * Local mode only (AUTH_MODE=local, refused in staging and production; 404 in any other mode). Turns the signed local
 * session cookie (httpOnly, so the page cannot read the email) into a bearer from the api's local token route
 * (`POST /api/v1/dev/token`), so the signed-in screens call the real api. The api still verifies the token fully.
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
  const state = await readLocalSession(request.cookies.get(LOCAL_SESSION_COOKIE)?.value);
  if (state.status !== 'active') return NextResponse.json({ token: null }, { status: 401 });
  try {
    // eslint-disable-next-line no-restricted-globals -- the api's local token route is not part of the generated client
    const res = await fetch(`${API_ORIGIN}/api/v1/dev/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: state.session.email }),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ token: null }, { status: 502 });
    const body = (await res.json()) as { token?: unknown; expiresInSeconds?: unknown };
    if (typeof body.token !== 'string') return NextResponse.json({ token: null }, { status: 502 });
    const expiresInSeconds = typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : 3600;
    return NextResponse.json({ token: body.token, expiresInSeconds }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ token: null }, { status: 502 });
  }
}
