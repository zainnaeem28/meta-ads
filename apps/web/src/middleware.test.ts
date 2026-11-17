// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SESSION_COOKIE, signLocalSession } from './lib/auth/local-session';
import middleware, { config } from './middleware';

const call = (path: string, cookie?: string) =>
  middleware(
    new NextRequest(
      `http://web.test${path}`,
      cookie ? { headers: { cookie: `${LOCAL_SESSION_COOKIE}=${cookie}` } } : {},
    ),
    {} as never,
  ) as Promise<Response>;

afterEach(() => vi.unstubAllEnvs());

describe('middleware in local mode', () => {
  it('redirects an anonymous visitor and carries the security headers', async () => {
    const res = await call('/campaigns/7?x=1');
    expect(res.status).toBe(307);
    expect(
      new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search,
    ).toBe('/sign-in?return=%2Fcampaigns%2F7%3Fx%3D1');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
  it('treats an expired cookie as an ended session', async () => {
    const cookie = await signLocalSession({ sub: 's', email: 'a@b.co', exp: 1 });
    const res = await call('/campaigns', cookie);
    expect(res.headers.get('location')).toContain(
      '/sign-in?reason=session-expired&return=%2Fcampaigns',
    );
  });
  it('passes a signed-in request and sends home to the campaign list', async () => {
    const cookie = await signLocalSession({
      sub: 's',
      email: 'a@b.co',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const pass = await call('/campaigns', cookie);
    expect(pass.headers.get('x-middleware-next')).toBe('1');
    expect(pass.headers.get('referrer-policy')).toBe('same-origin');
    expect(new URL((await call('/', cookie)).headers.get('location')!).pathname).toBe('/campaigns');
  });
  it('serves the sign-in page to anyone', async () => {
    expect((await call('/sign-in')).headers.get('x-middleware-next')).toBe('1');
  });
  it('refuses local mode in a hosted environment', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('AUTH_MODE', 'local');
    expect(() => call('/campaigns')).toThrow(/refused/);
  });
  it('matches app routes and skips build output and brand files', () => {
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test('/campaigns')).toBe(true);
    expect(re.test('/')).toBe(true);
    expect(re.test('/_next/static/a.js')).toBe(false);
    expect(re.test('/favicon.svg')).toBe(false);
    expect(re.test('/site.webmanifest')).toBe(false);
  });
});
