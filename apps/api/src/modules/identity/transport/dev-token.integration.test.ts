import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validEnv, hardened } from '../../../platform/config/test-env.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';

// AIU-251: the local/test token route through the built apps/api/dist/main.api.js (the real entry point) on real
// PostgreSQL: a token minted by the route signs a request in, claims keep the real shape, the guard still verifies;
// the route does not exist with Clerk identity, and the process refuses to start with local identity in staging/production.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const apiDir = join(import.meta.dirname, '..', '..', '..', '..');
const OWNER = 'owner@example.test';
let testDb: TestDatabase;
const running: ChildProcess[] = [];

async function start(port: number, env: Record<string, string>): Promise<string> {
  let err = '';
  const child = spawn('node', ['dist/main.api.js'], {
    cwd: apiDir,
    env: { PATH: process.env['PATH'] ?? '', ...validEnv('api', { DATABASE_URL: testDb.url, API_PORT: String(port), OWNER_EMAIL: OWNER, ...env }) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  running.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health/live`)).ok) return base;
    } catch {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`api did not start: ${err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function mint(base: string, payload: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}/api/v1/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: (await res.json()) as Json };
}
const me = async (base: string, token?: string) => {
  const res = await fetch(`${base}/api/v1/me`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as Json };
};

beforeAll(async () => {
  const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  testDb = await createTestDatabase({ label: 'aiu251', migrations: false });
  // The schema the identity routes use, applied the way the identity-auth suite does (the grants step needs provisioned roles).
  const pool = new pg.Pool({ connectionString: testDb.url, max: 1 });
  const apply = async (file: string, only?: RegExp): Promise<void> => {
    const sql = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
    for (const statement of sql.split('--> statement-breakpoint')) {
      const text = statement.trim();
      if (text !== '' && (only === undefined || only.test(text))) await pool.query(text);
    }
  };
  await apply('0001_task-025-platform.sql', /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/);
  await apply('0010_task-032-audit.sql');
  await apply('0020_task-033-identity.sql');
  await pool.end();
  await installJobs(testDb.url);
});

afterAll(async () => {
  for (const child of running) child.kill('SIGKILL');
  await testDb?.drop();
});

describe('local mode (development, IDENTITY_MODE=local)', () => {
  it('mints a token the same process verifies: owner links as admin with a second factor, others as users', async () => {
    const base = await start(3961, { IDENTITY_MODE: 'local' });
    expect((await me(base)).status).toBe(401);

    const owner = await mint(base, { email: OWNER.toUpperCase() });
    expect(owner.status).toBe(200);
    expect(owner.json['data']).toMatchObject({ email: OWNER, expiresInSeconds: 3600 });
    const token = owner.json['data']['token'] as string;
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Json;
    expect(claims).toMatchObject({ iss: 'https://identity.local.invalid', sub: owner.json['data']['sub'], fva: [0, 0], azp: 'http://localhost:3000' });
    expect(typeof claims['sid']).toBe('string');
    const signedIn = await me(base, token);
    expect(signedIn.status).toBe(200);
    expect(signedIn.json['data']).toMatchObject({ linkState: 'linked', role: 'admin' });

    // Same email again: the same subject, the same account (idempotent).
    const again = await mint(base, { email: OWNER });
    expect(again.json['data']['sub']).toBe(owner.json['data']['sub']);
  });

  it('does not weaken verification: a tampered token is 401, a no-second-factor token says so, bad input is 4xx', async () => {
    const base = await start(3962, { IDENTITY_MODE: 'local' });
    const minted = await mint(base, { email: 'someone@example.test', secondFactor: false });
    const token = minted.json['data']['token'] as string;
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from('{"sub":"user_local_x","iss":"https://identity.local.invalid"}').toString('base64url')}.${s}`;
    expect((await me(base, forged)).status).toBe(401);
    // Without a second factor the token says so (`fva[1] = -1`), and the guard's server-side MFA rule applies to it.
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Json;
    expect(claims['fva']).toEqual([0, -1]);
    for (const bad of [{}, { email: 'not-an-email' }, { email: 'a@example.test', role: 'admin' }]) {
      const r = await mint(base, bad);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.json['success']).toBe(false);
    }
  });
});

describe('outside local mode', () => {
  it('does not mount the route with Clerk identity', async () => {
    const base = await start(3963, { IDENTITY_MODE: 'clerk' });
    const r = await mint(base, { email: OWNER });
    expect(r.status).toBe(404);
  });

  for (const appEnv of ['staging', 'production']) {
    it(`refuses to start with IDENTITY_MODE=local when APP_ENV=${appEnv}`, async () => {
      // The database host is a closed local port: the refusal must come from the identity configuration, before any connection.
      const env = {
        ...validEnv('api', { ...hardened('api'), APP_ENV: appEnv, IDENTITY_MODE: 'local' }),
        DATABASE_URL: 'postgres://app_api@127.0.0.1:1/app?sslmode=require',
        API_PORT: appEnv === 'staging' ? '3964' : '3965',
      };
      const child = spawn('node', ['dist/main.api.js'], { cwd: apiDir, env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
      running.push(child);
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(code).not.toBe(0);
      expect(err).toMatch(/IDENTITY_MODE=local is refused/);
    });
  }
});
