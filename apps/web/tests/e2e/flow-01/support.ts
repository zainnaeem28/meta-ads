import { deflateSync } from 'node:zlib';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

export const CORS_WORKAROUND = process.env.FLOW01_CORS_WORKAROUND !== '0';
export const CONTROL = () => process.env.FLOW01_CONTROL_URL!;
export const API = () => process.env.FLOW01_API_URL!;

/** A valid PNG of the given size: a gradient, so the bytes are not trivially compressible. */
export function png(size: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const at = y * (size * 3 + 1);
    for (let x = 0; x < size; x += 1) {
      rows[at + 1 + x * 3] = (x * 255) / size;
      rows[at + 2 + x * 3] = (y * 255) / size;
      rows[at + 3 + x * 3] = 120;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface Session {
  userId: string;
  sub: string;
  /** The session token of this operator, for calls the test makes itself. */
  bearer: string;
  /** Replaces the bearer the api sees (an expired or revoked session); `null` restores the real one. */
  setBearer(value: string | null): void;
  /** The api calls the page made, as `METHOD /path status`. */
  calls: string[];
  /** The answers of 4xx and 5xx calls with their body. */
  errors: string[];
  /** Fails the next call starting with `METHOD /path` with this answer. */
  failNext(call: string, status: number, code: string): void;
}

/** A new linked operator (with an OpenAI key unless `withKey` is false) and a session token for it. */
export async function newOperator(
  withKey = true,
): Promise<{ sub: string; token: string; userId: string }> {
  return (await (await fetch(`${CONTROL()}/token?key=${withKey ? '1' : '0'}`)).json()) as {
    sub: string;
    token: string;
    userId: string;
  };
}

export async function tokenFor(sub: string): Promise<string> {
  return ((await (await fetch(`${CONTROL()}/token?sub=${sub}`)).json()) as { token: string }).token;
}

/** The provider stub answers every call normally or with a failure. */
export const provider = (mode: 'ok' | 'fail') => fetch(`${CONTROL()}/stub?mode=${mode}`);

export async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  return (await (await fetch(`${CONTROL()}/sql?q=${encodeURIComponent(query)}`)).json()) as T[];
}

/**
 * Signs the operator in as the web does in local mode (the signed session cookie) and gives the page the bearer the local
 * identity provider of the running api accepts: the web app sends none in local mode, so it is added at the network layer.
 * Every other part of each request and every answer is the real api's.
 */
export async function signIn(
  context: BrowserContext,
  page: Page,
  baseURL: string,
  withKey = true,
): Promise<Session> {
  const { sub, token: bearer, userId } = await newOperator(withKey);
  await context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({
        sub,
        email: `${sub}@example.test`,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      url: baseURL,
    },
  ]);
  let override: string | null = null;
  const failures = new Map<string, { status: number; code: string }>();
  const calls: string[] = [];
  const errors: string[] = [];
  await page.route(`${API()}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const call = `${request.method()} ${path}`;
    const key = [...failures.keys()].find((k) => call.startsWith(k));
    const injected = key === undefined ? undefined : failures.get(key);
    if (key !== undefined && injected) {
      failures.delete(key);
      calls.push(`${call} ${injected.status}`);
      return route.fulfill({
        status: injected.status,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': (await request.headerValue('origin')) ?? '*',
          'access-control-allow-credentials': 'true',
          'access-control-expose-headers': 'x-request-id,etag,retry-after',
        },
        body: JSON.stringify({
          success: false,
          error: { code: injected.code, message: 'Injected failure.', details: [] },
          metaData: { requestId: 'req-flow01-injected' },
        }),
      });
    }
    const response = await route.fetch({
      headers: { ...request.headers(), authorization: `Bearer ${override ?? bearer}` },
    });
    calls.push(`${call} ${response.status()}`);
    if (response.status() >= 400)
      errors.push(`${call} ${response.status()}: ${(await response.text()).slice(0, 600)}`);
    // MISMATCH FLOW01-F1 (TASK-019 contracts http.ts vs TASK-023 cors.ts): the generated client sends `credentials: 'include'`,
    // the api answers no Access-Control-Allow-Credentials, so a browser refuses every call. Worked around here only, so
    // the rest of the journey can be proven; flow-01.spec.ts holds a test that fails until the owner fixes it.
    return route.fulfill({
      response,
      headers: {
        ...response.headers(),
        ...(CORS_WORKAROUND ? { 'access-control-allow-credentials': 'true' } : {}),
      },
    });
  });
  return {
    userId,
    sub,
    bearer,
    setBearer: (value) => void (override = value),
    calls,
    errors,
    failNext: (call, status, code) => void failures.set(call, { status, code }),
  };
}

export const heading = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
export const settle = (page: Page) => page.evaluate(() => document.fonts.ready);
