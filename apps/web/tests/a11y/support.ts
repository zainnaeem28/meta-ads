import { mkdirSync } from 'node:fs';
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../src/lib/auth/local-session';

/** Where this ticket's axe results and screenshots are committed (the coverage script reads them). */
export const EVIDENCE = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-118';

export const signedIn = async (context: BrowserContext, baseURL: string) =>
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

export const NOW = '2026-11-16T12:00:00.000Z';
export const meta = { requestId: 'req-e2e-118', timestamp: NOW };
export const ok = (data: unknown, m: unknown = meta) => ({
  status: 200,
  body: { success: true, data, metaData: m },
});
export const failure = (status: number, code: string, details: unknown[] = []) => ({
  status,
  body: { success: false, error: { code, message: 'Refused.', details }, metaData: meta },
});

export type Answer =
  { status: number; body?: unknown; headers?: Record<string, string> } | 'hang' | undefined;
export type Script = (
  method: string,
  path: string,
  url: URL,
  route: Route,
) => Answer | Promise<Answer>;

/**
 * Contract-shaped answers for the operations a screen reads (labelled mocks). The built web app calls the api origin; the
 * api sets no CORS headers yet, so the browser requests are relayed here with them. A path the script does not answer
 * reaches the real running api.
 */
export async function relay(page: Page, script: Script) {
  const origin = process.env.E2E_API_URL!;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': 'x-request-id,etag,retry-after',
    };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-headers':
            (await request.headerValue('access-control-request-headers')) ?? '*',
        },
      });
    }
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const answer = await script(request.method(), path, url, route);
    if (answer === 'hang') return new Promise<void>(() => undefined);
    if (answer) {
      return route.fulfill({
        status: answer.status,
        headers: { ...cors, ...(answer.headers ?? {}) },
        ...(answer.status === 204
          ? {}
          : { contentType: 'application/json', body: JSON.stringify(answer.body) }),
      });
    }
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}

export const settle = async (page: Page) => {
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await Promise.all(
      ['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 16px Inter`)),
    );
    await document.fonts.ready;
  });
};

export const ensureDir = (dir: string) => mkdirSync(dir, { recursive: true });

/** The text of the page as a reader meets it: visible text nodes, in order. */
export const visibleText = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      const text = n.textContent?.trim();
      if (!el || !text) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.closest('script,style,noscript,[hidden],[aria-hidden="true"]')) continue;
      out.push(text);
    }
    return out;
  });

/**
 * Loss of content under a layout change: horizontal page scroll, or text clipped by its own box
 * (overflow hidden/clip with no ellipsis) so that part of it cannot be read.
 */
export const contentLoss = (page: Page) =>
  page.evaluate(() => {
    const problems: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1)
      problems.push(`page scrolls sideways (${doc.scrollWidth} > ${window.innerWidth})`);
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const clips =
        ['hidden', 'clip'].includes(style.overflowX) ||
        ['hidden', 'clip'].includes(style.overflowY);
      if (!clips || !el.textContent?.trim()) continue;
      if (el.closest('[aria-hidden="true"],.sr-only')) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue; // visually hidden on purpose (screen-reader text)
      const ellipsis = style.textOverflow === 'ellipsis';
      const wide =
        el.scrollWidth > el.clientWidth + 1 &&
        !ellipsis &&
        ['hidden', 'clip'].includes(style.overflowX);
      const tall =
        el.scrollHeight > el.clientHeight + 1 &&
        ['hidden', 'clip'].includes(style.overflowY) &&
        style.display !== 'inline';
      if ((wide || tall) && el.clientWidth > 0 && el.clientHeight > 0) {
        problems.push(
          `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''} clips "${el.textContent.trim().slice(0, 40)}"`,
        );
      }
    }
    return problems;
  });

export const expectNoLoss = async (page: Page, label: string) => {
  expect(await contentLoss(page), `${label}: content lost`).toEqual([]);
};

/** UI-UX §12 text-spacing override (WCAG 1.4.12): line height 1.5, paragraph 2em, letter 0.12em, word 0.16em. */
export const TEXT_SPACING_CSS = `*{line-height:1.5 !important;letter-spacing:.12em !important;word-spacing:.16em !important} p{margin-bottom:2em !important}`;
