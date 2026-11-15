import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validEnv } from '../config/test-env.js';
import { CANARY_EMAIL, CANARY_KEY, CANARY_TOKEN, expectNoCanary } from './test-support.js';

// TC-LOG-01 / TC-LOG-03 through the real composition root: the built apps/api/dist/main.api.js, started as a
// process against a uniquely named database on the shared test PostgreSQL. The canary goes through request
// headers, the URL, a 404 and the configured secret set; stdout and stderr are captured and searched.

const apiDir = join(import.meta.dirname, '..', '..', '..');
const adminUrl =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
const database = `task021_${randomBytes(4).toString('hex')}`;
const CONFIG_SECRET = ['sk', 'test', 'canary-SECRET-literal-77aa11bb'].join('_');
const RELEASE_SHA = 'abc1234def5678';
const PORT = 3941;
let databaseUrl = '';
let child: ChildProcess;
let stdout = '';
let stderr = '';

async function waitForLive(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health/live`)).ok) return;
    } catch {
      if (Date.now() > deadline) throw new Error(`api did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  databaseUrl = url.toString();
  child = spawn('node', ['dist/main.api.js'], {
    cwd: apiDir,
    env: {
      PATH: process.env['PATH'] ?? '',
      ...validEnv('api', {
        DATABASE_URL: databaseUrl,
        CLERK_SECRET_KEY: CONFIG_SECRET,
        RELEASE_SHA,
        API_PORT: String(PORT),
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  await waitForLive();
});

afterAll(async () => {
  child?.kill('SIGTERM');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});

const lines = (): Record<string, unknown>[] =>
  stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('api process logging (real entry point, real PostgreSQL)', () => {
  it('writes JSON with releaseSha on every line, echoes a trusted request ID and replaces a bad one', async () => {
    const trusted = await fetch(`http://127.0.0.1:${PORT}/health/live`, {
      headers: { 'X-Request-ID': 'upstream-4242abcd' },
    });
    expect(trusted.headers.get('x-request-id')).toBe('upstream-4242abcd');
    const bad = await fetch(`http://127.0.0.1:${PORT}/health/live`, {
      headers: { 'X-Request-ID': 'no good!' },
    });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const all = lines();
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) expect(line['releaseSha']).toBe(RELEASE_SHA);
    const requestLine = all.find((line) => line['requestId'] === 'upstream-4242abcd');
    expect(requestLine).toMatchObject({ method: 'GET', status: 200, level: 'info' });
  });

  it('never prints the canary: header, cookie, URL, 404 path, configured secret (TC-LOG-01, TC-LOG-03)', async () => {
    const headers = {
      Authorization: `Bearer ${CANARY_TOKEN}`,
      Cookie: `session=${CANARY_TOKEN}`,
      'X-Request-ID': `req-${CANARY_KEY}`.slice(0, 20),
    };
    const base = `http://127.0.0.1:${PORT}`;
    const responses = [
      await fetch(`${base}/health/live?apiKey=${CANARY_KEY}&email=${CANARY_EMAIL}`, { headers }),
      await fetch(`${base}/missing/${CANARY_KEY}/${CONFIG_SECRET}`, { headers }),
      await fetch(`${base}/health/live`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: CANARY_KEY, email: CANARY_EMAIL, transcript: CANARY_TOKEN }),
      }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 404, 404]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      expectNoCanary(stdout + stderr, [CANARY_KEY, CANARY_TOKEN, CANARY_EMAIL, CONFIG_SECRET]),
    ).toEqual([]);
    expect(stdout).not.toMatch(/Bearer|session=|transcript/);
    expect(lines().some((line) => line['status'] === 404)).toBe(true);
  });
});
