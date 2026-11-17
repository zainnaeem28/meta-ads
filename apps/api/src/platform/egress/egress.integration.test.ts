import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validEnv } from '../config/test-env.js';
import { installJobs } from '../jobs/test-support.js';

// TASK-031: the egress module wired into the built api (`dist/main.api.js`, real composition root) on a uniquely
// named database of the shared test PostgreSQL: the process starts with the allow-list, and refuses to start with a bad one.

const apiDir = join(import.meta.dirname, '..', '..', '..');
const adminUrl =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
const database = `task031_${randomBytes(4).toString('hex')}`;
const PORT = 3944;
let databaseUrl = '';
let child: ChildProcess | undefined;

async function withAdmin(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(sql);
  await admin.end();
}

beforeAll(async () => {
  const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  await withAdmin(`CREATE DATABASE ${database}`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  databaseUrl = url.toString();
  await installJobs(databaseUrl);
});

afterAll(async () => {
  child?.kill('SIGTERM');
  await withAdmin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
});

describe('egress in the real api composition root', () => {
  it('main.api.js refuses to start when the allow-list names an IP address', () => {
    const run = spawnSync('node', ['dist/main.api.js'], {
      cwd: apiDir,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        ...validEnv('api', {
          DATABASE_URL: databaseUrl,
          API_PORT: String(PORT + 1),
          EGRESS_ALLOWED_HOSTS: '{"openai":["10.0.0.5"]}',
        }),
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('EGRESS_ALLOWED_HOSTS is not acceptable');
    expect(run.stderr).toContain('openai: 10.0.0.5 is an IP address');
  });

  it('main.api.js starts with the default allow-list and the Egress service refuses unsafe fetches', async () => {
    child = spawn('node', ['dist/main.api.js'], {
      cwd: apiDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        ...validEnv('api', { DATABASE_URL: databaseUrl, API_PORT: String(PORT) }),
      },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health/live`)).ok) break;
      } catch {
        if (Date.now() > deadline) throw new Error('api did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const script = `
      import 'reflect-metadata';
      import { createApiApp } from './dist/bootstrap/api.module.js';
      import { EGRESS } from './dist/platform/egress/index.js';
      import { createHttpLogging } from './dist/platform/logging/index.js';
      const { app } = await createApiApp({ WEB_ORIGIN: 'http://localhost:3000', APP_ENV: 'development',
        EGRESS_ALLOWED_HOSTS: { openai: ['api.openai.com'] } }, createHttpLogging({ level: 'silent' }));
      const egress = app.get(EGRESS);
      const out = [];
      for (const [provider, url] of [['openai', 'https://evil.example.com/x'], ['openai', 'https://169.254.169.254/latest'],
        ['openai', 'http://api.openai.com/'], ['wavespeed', 'https://api.wavespeed.ai/']]) {
        try { await egress.fetch(provider, { url }); out.push('FETCHED'); } catch (error) { out.push(error.reason); }
      }
      console.log(JSON.stringify(out));
      await app.close();
    `;
    const run = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: apiDir,
      encoding: 'utf8',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout.trim().split('\n').pop()).toBe(
      JSON.stringify(['host_not_allowed', 'host_not_allowed', 'not_https', 'provider_unknown']),
    );
  });
});
