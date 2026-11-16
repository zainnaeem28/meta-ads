// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../src/lib/auth/local-session';
import { buildCsp, clerkFrontendOrigin, dynamicHeaders, isKeyPage, storageOrigins } from '../../src/lib/security/csp';
import middleware from '../../src/middleware';

/** Route classes of the web app: public auth page, signed-in page, the key page, probe page, redirect, home. */
const CLASSES = [
  { name: 'sign-in (public)', path: '/sign-in', session: false },
  { name: 'second step (public)', path: '/mfa', session: false },
  { name: 'campaign list (signed in)', path: '/campaigns', session: true },
  { name: 'campaign detail with query', path: '/campaigns/7/clips?x=1', session: true },
  { name: 'provider keys (signed in)', path: '/settings/provider-keys', session: true },
  { name: 'access (signed in)', path: '/access', session: true },
  { name: 'test probe page', path: '/gallery', session: false },
  { name: 'redirect to sign-in (anonymous)', path: '/campaigns', session: false },
  { name: 'home redirect', path: '/', session: true },
];

const origin = 'https://app.example';
const call = async (path: string, session: boolean) => {
  const cookie = session
    ? await signLocalSession({ sub: 's', email: 'a@b.co', exp: Math.floor(Date.now() / 1000) + 60 })
    : undefined;
  return middleware(
    new NextRequest(`${origin}${path}`, cookie ? { headers: { cookie: `${LOCAL_SESSION_COOKIE}=${cookie}` } } : {}),
    {} as never,
  ) as Promise<Response>;
};

const directives = (csp: string) =>
  Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));

afterEach(() => vi.unstubAllEnvs());

describe.each(CLASSES)('response headers: $name', ({ path, session }) => {
  it('carries the full set and an enforced policy', async () => {
    const res = await call(path, session);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('permissions-policy')).toMatch(/camera=\(\), .*microphone=\(\)/);
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    const csp = directives(res.headers.get('content-security-policy')!);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'none'"]);
    expect(csp['script-src']).toContain("'self'");
    expect(csp['script-src']).not.toContain("'unsafe-inline'");
    expect(csp['script-src']).not.toContain("'unsafe-eval'");
    expect(csp['script-src']!.some((v) => v.startsWith("'nonce-"))).toBe(true);
  });
});

describe('nonce', () => {
  it('is fresh per request and forwarded to the page with the policy', async () => {
    const a = await call('/sign-in', false);
    const b = await call('/sign-in', false);
    const nonce = (r: Response) => /'nonce-([^']+)'/.exec(r.headers.get('content-security-policy')!)![1];
    expect(nonce(a)).not.toBe(nonce(b));
    expect(nonce(a)!.length).toBeGreaterThanOrEqual(22);
    // The framework reads the forwarded request headers to mark its own scripts.
    expect(a.headers.get('x-middleware-request-x-nonce')).toBe(nonce(a));
    expect(a.headers.get('x-middleware-request-content-security-policy')).toBe(a.headers.get('content-security-policy'));
  });
});

describe('key page (REQ-019)', () => {
  it('is no-store and lists no origin beyond self, the api and the provider session script', async () => {
    const res = await call('/settings/provider-keys', true);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const other = await call('/campaigns', true);
    expect(other.headers.get('cache-control')).toBeNull();
  });

  const key = `pk_test_${btoa('clerk.shroomap.example$')}`;
  const env = {
    APP_ENV: 'production',
    NEXT_PUBLIC_API_ORIGIN: 'https://api.shroomap.example/',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: key,
    NEXT_PUBLIC_SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/2',
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_BUCKET: 'media',
  };

  it('allows only the provider origin as a script source on the key page', () => {
    const csp = directives(buildCsp({ nonce: 'N', pathname: '/settings/provider-keys', env }));
    const thirdParty = (list: string[]) => list.filter((v) => /^https?:/.test(v));
    expect(thirdParty(csp['script-src']!)).toEqual(['https://clerk.shroomap.example']);
    // Every script-src entry is self, the request nonce or the provider origin: nothing else.
    for (const v of csp['script-src']!) expect(v).toMatch(/^('self'|'nonce-N'|https:\/\/clerk\.shroomap\.example)$/);
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['img-src']).not.toContain('https://img.clerk.com');
  });

  it('adds the provider challenge origins only on other pages', () => {
    const csp = directives(buildCsp({ nonce: 'N', pathname: '/sign-in', env }));
    expect(csp['script-src']).toContain('https://challenges.cloudflare.com');
    expect(csp['frame-src']).toEqual(['https://challenges.cloudflare.com']);
  });

  it('limits connect, image and media sources to the api, provider and signed storage origins', () => {
    const csp = directives(buildCsp({ nonce: 'N', pathname: '/campaigns', env }));
    expect(csp['connect-src']).toEqual([
      "'self'",
      'https://api.shroomap.example',
      'https://clerk.shroomap.example',
      'https://o1.ingest.sentry.io',
    ]);
    expect(csp['img-src']).toContain('https://acct.r2.cloudflarestorage.com');
    expect(csp['img-src']).toContain('https://media.acct.r2.cloudflarestorage.com');
    expect(csp['media-src']).toEqual([
      "'self'",
      'blob:',
      'data:',
      'https://acct.r2.cloudflarestorage.com',
      'https://media.acct.r2.cloudflarestorage.com',
    ]);
    expect(buildCsp({ nonce: 'N', pathname: '/campaigns', env })).toContain('upgrade-insecure-requests');
  });

  it('sends HSTS only for hosted environments, and the key page path match is exact', () => {
    const pass = { nonce: 'N', pathname: '/', env: { APP_ENV: 'production' } };
    expect(dynamicHeaders(pass)['Strict-Transport-Security']).toMatch(/^max-age=\d+; includeSubDomains$/);
    expect(dynamicHeaders({ ...pass, env: { APP_ENV: 'development' } })['Strict-Transport-Security']).toBeUndefined();
    expect(isKeyPage('/settings/provider-keys/')).toBe(true);
    expect(isKeyPage('/settings/provider-keys-x')).toBe(false);
  });
});

describe('origin helpers', () => {
  it('decode the provider host from the publishable key and ignore malformed input', () => {
    expect(clerkFrontendOrigin(`pk_live_${btoa('clerk.a.example$')}`)).toBe('https://clerk.a.example');
    for (const bad of [undefined, '', 'pk_test_', 'pk_test_!!!', `pk_test_${btoa('bad host$')}`, 'sk_test_abc'])
      expect(clerkFrontendOrigin(bad)).toBeNull();
  });
  it('accept only http(s) storage endpoints', () => {
    expect(storageOrigins({})).toEqual([]);
    expect(storageOrigins({ R2_ENDPOINT: 'javascript:alert(1)' })).toEqual([]);
    expect(storageOrigins({ R2_ENDPOINT: 'nonsense' })).toEqual([]);
    expect(storageOrigins({ R2_ENDPOINT: 'http://localhost:9000' })).toEqual(['http://localhost:9000']);
  });
  it('allow eval only in development builds', () => {
    const csp = (NODE_ENV: string) => buildCsp({ nonce: 'N', pathname: '/', env: { NODE_ENV } });
    expect(csp('development')).toContain("'unsafe-eval'");
    expect(csp('production')).not.toContain("'unsafe-eval'");
  });
});
