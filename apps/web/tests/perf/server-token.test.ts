import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../src/lib/auth/local-session';

// The server's own session for a request (ADR-014): the requesting user's bearer and user id, from Clerk or from the local
// token exchange, or nothing; bounded in time; never a service credential.
const clerk = vi.hoisted(() => ({
  auth: vi.fn(),
}));
vi.mock('@clerk/nextjs/server', () => ({ auth: clerk.auth }));
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        jar.cookie && name === 'shroomap_local_session' ? { value: jar.cookie } : undefined,
    }),
}));

const cookieFor = async (email: string) =>
  signLocalSession({ sub: 's', email, exp: Math.floor(Date.now() / 1000) + 600 });
const exchange = (body: unknown, init?: ResponseInit) =>
  vi.fn(async () => new Response(JSON.stringify(body), init));

beforeEach(() => {
  clerk.auth.mockReset();
  jar.cookie = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const load = () => import('../../src/lib/auth/server-token');

describe('getServerSession in Clerk mode', () => {
  beforeEach(() => vi.stubEnv('AUTH_MODE', 'clerk'));

  it('answers the signed-in user’s own token and id', async () => {
    clerk.auth.mockResolvedValue({
      userId: 'user_1',
      getToken: () => Promise.resolve('clerk-tok'),
    });
    const { getServerSession, getServerIdentity } = await load();
    expect(await getServerSession()).toEqual({ token: 'clerk-tok', identity: 'user_1' });
    expect(await getServerIdentity()).toBe('user_1');
  });

  it('answers nothing when nobody is signed in, there is no token, or Clerk fails', async () => {
    const { getServerSession, getServerIdentity } = await load();
    clerk.auth.mockResolvedValueOnce({ userId: null, getToken: () => Promise.resolve(null) });
    expect(await getServerSession()).toBeNull();
    clerk.auth.mockResolvedValueOnce({ userId: 'u', getToken: () => Promise.resolve(null) });
    expect(await getServerSession()).toBeNull();
    clerk.auth.mockRejectedValueOnce(new Error('clerkMiddleware not detected'));
    expect(await getServerIdentity()).toBeNull();
  });

  it('stops waiting for a stalled exchange at the deadline (SEC-L1)', async () => {
    clerk.auth.mockReturnValue(new Promise(() => undefined));
    const { getServerSession, SESSION_DEADLINE_MS } = await load();
    const started = Date.now();
    expect(await getServerSession()).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(SESSION_DEADLINE_MS - 50);
    expect(Date.now() - started).toBeLessThan(SESSION_DEADLINE_MS + 500);
  });
});

describe('getServerSession in local mode', () => {
  beforeEach(() => vi.stubEnv('AUTH_MODE', 'local'));

  it('exchanges an active local session for the api token, with the user id of the token', async () => {
    jar.cookie = await cookieFor('o@example.test');
    const f = exchange({
      success: true,
      data: { token: 'local-tok', sub: 'user_local_1', expiresInSeconds: 600 },
    });
    vi.stubGlobal('fetch', f);
    const { getServerSession } = await load();
    expect(await getServerSession()).toEqual({ token: 'local-tok', identity: 'user_local_1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/dev\/token$/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers nothing, and calls nothing, without an active session cookie', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { getServerSession } = await load();
    expect(await getServerSession()).toBeNull();
    jar.cookie = 'forged.value';
    expect(await getServerSession()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('answers nothing when the exchange fails or answers no user id', async () => {
    jar.cookie = await cookieFor('o@example.test');
    const { getServerSession } = await load();
    vi.stubGlobal('fetch', exchange({}, { status: 502 }));
    expect(await getServerSession()).toBeNull();
    vi.stubGlobal('fetch', exchange({ success: true, data: { token: 't' } }));
    expect(await getServerSession()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await getServerSession()).toBeNull();
  });

  it('is nothing at all when the auth mode is not valid', async () => {
    vi.stubEnv('AUTH_MODE', 'bogus');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { getServerSession } = await load();
    expect(await getServerSession()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('issueLocalToken', () => {
  it('reports why there is no token: no session, or the api not answering', async () => {
    const { issueLocalToken } = await load();
    expect(await issueLocalToken(undefined)).toEqual({ ok: false, reason: 'no-session' });
    const cookie = await cookieFor('o@example.test');
    vi.stubGlobal('fetch', exchange({}, { status: 500 }));
    expect(await issueLocalToken(cookie)).toEqual({ ok: false, reason: 'unavailable' });
    vi.stubGlobal('fetch', exchange({ data: { token: 't', sub: 7 } }));
    expect(await issueLocalToken(cookie)).toMatchObject({
      ok: true,
      sub: null,
      expiresInSeconds: 3600,
    });
  });

  it('the cookie name is the local session cookie', () => {
    expect(LOCAL_SESSION_COOKIE).toBe('shroomap_local_session');
  });
});
