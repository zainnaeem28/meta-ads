import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validEnv } from '../config/test-env.js';

// TASK-023: the HTTP edge in the built apps/api/dist/main.api.js (real entry point) with a uniquely named database
// of the shared test PostgreSQL; the failing startup check runs through the real composition function.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const apiDir = join(import.meta.dirname, '..', '..', '..');
const adminUrl =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
const database = `task023_${randomBytes(4).toString('hex')}`;
const PORT = 3943;
const base = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:3000';
let databaseUrl = '';
let child: ChildProcess;
let stderr = '';

async function waitForLive(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health/live`)).ok) return;
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
      ...validEnv('api', { DATABASE_URL: databaseUrl, API_PORT: String(PORT) }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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

describe('main.api.js HTTP edge (real entry point)', () => {
  it('answers 405 with Allow and 404 without a token, never 401 (TC-ERR-03)', async () => {
    const wrong = await fetch(`${base}/health/live`, { method: 'POST' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, HEAD');
    expect(((await wrong.json()) as Json)['error']['code']).toBe('method_not_allowed');
    for (const url of ['/api/v1/nowhere', '/internal/metrics/missing']) {
      const miss = await fetch(`${base}${url}`, { headers: { authorization: 'Bearer anything' } });
      expect(miss.status).toBe(404);
      expect(((await miss.json()) as Json)['error']['code']).toBe('not_found');
    }
  });

  it('refuses a foreign-origin preflight without allow-origin and answers the web origin (TC-ZT-05, TC-ZT-08)', async () => {
    const foreign = await fetch(`${base}/api/v1/drafts`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(foreign.status).toBe(204);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const own = await fetch(`${base}/api/v1/drafts`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(own.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('sends security headers and no-store under /api/v1', async () => {
    const res = await fetch(`${base}/api/v1/nowhere`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(`${base}/health/live`)).headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('fails startup for a route without a scope (TC-AUT-01)', () => {
    const script = `
      import 'reflect-metadata';
      import { Module } from '@nestjs/common';
      import { createApiApp } from './dist/bootstrap/api.module.js';
      import { createHttpLogging } from './dist/platform/logging/index.js';
      class Loose { loose() { return 'x'; } }
      Reflect.defineMetadata('path', 'loose', Loose);
      Reflect.defineMetadata('path', '/', Loose.prototype.loose);
      Reflect.defineMetadata('method', 0, Loose.prototype.loose);
      try {
        await createApiApp({ WEB_ORIGIN: 'http://localhost:3000', APP_ENV: 'development' }, createHttpLogging({ level: 'silent' }), [Loose]);
        console.log('STARTED');
      } catch (error) { console.log(String(error.message)); process.exit(1); }
    `;
    const run = spawnSync('node', ['--input-type=module', '-e', script], { cwd: apiDir, encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain('Loose.loose: no scope declared');
  });
});
