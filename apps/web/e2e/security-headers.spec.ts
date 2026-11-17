import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-085';
const SHOTS = VIEWPORTS.filter((v) => v.name !== '768');

const signedIn = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({
        sub: 'user_local_e2e',
        email: 'e2e@example.com',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      url: baseURL,
    },
  ]);

/** Records every policy violation the browser reports (the page's own `securitypolicyviolation` events). */
const watchViolations = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
  });
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

/** Not `networkidle`: the 404 screen's prefetch loop on unbuilt routes never goes idle. Load plus a fixed window for late violations. */
const settle = async (page: Page) => {
  await page.waitForLoadState('load');
  await page.waitForTimeout(750);
};

const directives = (csp: string) =>
  Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));

/** The screens of the matrix that exist in the built app; each is a route class of the header test. */
const SCREENS = [
  { path: '/sign-in', session: false },
  { path: '/gallery', session: false },
  { path: '/api-probe', session: false },
  { path: '/error-probe', session: false },
  { path: '/campaigns', session: true },
  { path: '/settings/provider-keys', session: true },
  { path: '/access', session: true },
];

test.describe('@TASK-085 web security headers and CSP through the built web app', () => {
  for (const { path, session } of SCREENS) {
    test(`${path}: full header set, enforced policy, no violation`, async ({
      page,
      context,
      baseURL,
    }) => {
      if (session) await signedIn(context, baseURL!);
      await watchViolations(page);
      const res = await page.goto(path);
      const h = res!.headers();
      expect(h['referrer-policy']).toBe('same-origin');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['permissions-policy']).toContain('camera=()');
      expect(h['content-security-policy-report-only']).toBeUndefined();
      const csp = directives(h['content-security-policy']!);
      expect(csp['frame-ancestors']).toEqual(["'none'"]);
      expect(csp['script-src']).not.toContain("'unsafe-inline'");
      expect(csp['connect-src']).toContain(process.env.E2E_API_URL!);
      if (path === '/settings/provider-keys') expect(h['cache-control']).toContain('no-store');
      await settle(page);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('static files carry the static headers', async ({ request }) => {
    const res = await request.get('/site.webmanifest');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['referrer-policy']).toBe('same-origin');
    expect(res.headers()['x-powered-by']).toBeUndefined();
  });

  test('the framework scripts carry the nonce and a new nonce is issued per request', async ({
    request,
  }) => {
    const nonces = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const res = await request.get('/sign-in');
      const nonce = /'nonce-([^']+)'/.exec(res.headers()['content-security-policy']!)![1]!;
      nonces.add(nonce);
      const html = await res.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts)
        expect(tag, 'every script tag is marked').toContain(`nonce="${nonce}"`);
    }
    expect(nonces.size).toBe(2);
  });

  test('a third-party script and an inline script injected on the key page are blocked and reported', async ({
    page,
    context,
    baseURL,
  }) => {
    await signedIn(context, baseURL!);
    await watchViolations(page);
    const consoleErrors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    await page.goto('/settings/provider-keys');
    await settle(page);
    const executed = await page.evaluate(
      () =>
        new Promise<{ external: boolean; inline: boolean }>((resolve) => {
          const w = window as unknown as { __ext?: boolean; __inline?: boolean };
          const ext = document.createElement('script');
          ext.src = 'https://third-party.example/tracker.js';
          document.head.append(ext);
          const inline = document.createElement('script');
          inline.textContent = 'window.__inline = true';
          document.head.append(inline);
          setTimeout(
            () => resolve({ external: Boolean(w.__ext), inline: Boolean(w.__inline) }),
            500,
          );
        }),
    );
    expect(executed).toEqual({ external: false, inline: false });
    const reported = await violations(page);
    expect(
      reported.some((v) => v.startsWith('script-src-elem') && v.includes('third-party.example')),
    ).toBe(true);
    expect(reported.some((v) => v.startsWith('script-src-elem') && v.includes('inline'))).toBe(
      true,
    );
    expect(
      consoleErrors.some(
        (m) => m.includes('Content Security Policy') && m.includes('third-party.example'),
      ),
    ).toBe(true);
  });

  test('framing is refused: the page cannot be embedded', async ({ page, baseURL }) => {
    await page.goto('/sign-in');
    const framed = await page.evaluate(
      (src) =>
        new Promise<{ loaded: boolean; body: string | null }>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = src;
          frame.onload = () =>
            resolve({ loaded: true, body: frame.contentDocument?.body?.innerHTML ?? null });
          document.body.append(frame);
          setTimeout(() => resolve({ loaded: false, body: null }), 5000);
        }),
      `${baseURL}/sign-in`,
    );
    // The refused frame fires `load` on an error document: no body content of the app.
    expect(framed.loaded, 'the frame reported a load').toBe(true);
    expect(framed.body === null || framed.body === '').toBe(true);
    // The browser replaces a refused frame with its error document.
    expect(
      page.frames().some((f) => f !== page.mainFrame() && f.url().startsWith('chrome-error:')),
    ).toBe(true);
  });

  for (const { name, width, height } of SHOTS) {
    test(`evidence: key page and campaigns at ${name} px under the enforced policy`, async ({
      page,
      context,
      baseURL,
    }) => {
      await signedIn(context, baseURL!);
      await page.setViewportSize({ width, height });
      await watchViolations(page);
      for (const [slug, path] of [
        ['provider-keys', '/settings/provider-keys'],
        ['signed-in-campaigns', '/campaigns'],
      ] as const) {
        await page.goto(path);
        await settle(page);
        await page.evaluate(() => document.fonts.ready);
        expect(await violations(page)).toEqual([]);
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        await page.screenshot({ path: `${evidence}/screenshots/${slug}-${name}.png` });
      }
    });
  }

  for (const { name, width, height } of SHOTS) {
    test(`evidence: sign-in at ${name} px under the enforced policy`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await watchViolations(page);
      await page.goto('/sign-in');
      await expect(
        page.getByRole('heading', { level: 1, name: 'AI UGC Ad Director' }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await violations(page)).toEqual([]);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await page.screenshot({ path: `${evidence}/screenshots/sign-in-${name}.png` });
      await expectNoAxeViolations(page, `${evidence}/axe/sign-in-${name}.json`);
    });
  }
});
