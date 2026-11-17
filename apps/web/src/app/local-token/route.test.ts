import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../lib/auth/local-session';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const req = async (cookie = true) =>
  new NextRequest('http://web.test/local-token', {
    headers: cookie
      ? {
          cookie: `${LOCAL_SESSION_COOKIE}=${await signLocalSession({ sub: 's', email: 'o@example.test', exp: Math.floor(Date.now() / 1000) + 600 })}`,
        }
      : {},
  });

describe('GET /local-token', () => {
  it('exchanges the local session for the api local-mode token', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { token: 'tok', expiresInSeconds: 3600 },
            metaData: { requestId: 'r1' },
          }),
        ),
    );
    vi.stubGlobal('fetch', f);
    const { GET } = await import('./route');
    const res = await GET(await req());
    expect(await res.json()).toEqual({ token: 'tok', expiresInSeconds: 3600 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/dev\/token$/);
    expect(JSON.parse(init.body as string)).toEqual({ email: 'o@example.test' });
  });
  it('is 502 with no token when the api answers a top-level (non-envelope) body', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: 'tok', expiresInSeconds: 3600 }))),
    );
    const { GET } = await import('./route');
    const res = await GET(await req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ token: null });
  });
  it('is 401 without a session and calls nothing', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { GET } = await import('./route');
    expect((await GET(await req(false))).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });
  it('is absent (404) with Clerk mode or in a hosted environment, and never calls the api', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const env of [
      { AUTH_MODE: 'clerk' },
      { AUTH_MODE: 'local', APP_ENV: 'production' },
      { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x', AUTH_MODE: '' },
    ]) {
      vi.resetModules();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const { GET } = await import('./route');
      expect((await GET(await req())).status).toBe(404);
    }
    expect(f).not.toHaveBeenCalled();
  });
});
