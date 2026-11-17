// @vitest-environment node
// Built web (`next start`) against a stub api that answers the real envelope. Run with `pnpm test:built`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../src/lib/auth/local-session';

let api: Server;
let web: ChildProcess;
let base = '';
let received = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received = `${req.method} ${req.url} ${raw}`;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          success: true,
          data: { token: 'built-token', expiresInSeconds: 900 },
          metaData: { requestId: 'r1' },
        }),
      );
    });
  });
  await new Promise<void>((r) => api.listen(0, r));
  const apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const env = {
    ...process.env,
    AUTH_MODE: 'local',
    NODE_ENV: 'production',
    NEXT_PUBLIC_API_ORIGIN: apiOrigin,
  };
  // NEXT_PUBLIC_API_ORIGIN is inlined at build time, so the build is always made for this run's stub api.
  {
    const b = spawnSync('pnpm', ['exec', 'next', 'build'], { env, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('next build failed');
  }
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  web = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/local-token`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('next start did not come up');
}, 600_000);

afterAll(() => {
  web?.kill();
  api?.close();
});

describe('built web GET /local-token against the api envelope', () => {
  it('returns the bearer from data.token and data.expiresInSeconds', async () => {
    const cookie = await signLocalSession({
      sub: 's',
      email: 'o@example.test',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const res = await fetch(`${base}/local-token`, {
      headers: { cookie: `${LOCAL_SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'built-token', expiresInSeconds: 900 });
    expect(received).toBe('POST /api/v1/dev/token {"email":"o@example.test"}');
  });
});
