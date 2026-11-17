import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateJobs } from '../../database/jobs-migrate.js';
import { validEnv } from '../config/test-env.js';
import { createTestDatabase } from './test-database.js';
import type { TestDatabase } from './test-database.js';

// TASK-024 through the real entry points: the built apps/api/dist/main.api.js opens its pool from the
// configuration and fails startup when the database cannot be reached; `db:seed` refuses and counts.

const apiDir = join(import.meta.dirname, '..', '..', '..');
const PORT = 3951;
const base = `http://127.0.0.1:${PORT}`;
let database: TestDatabase;
let child: ChildProcess | undefined;
let stderr = '';

function node(args: string[], env: Record<string, string>) {
  const run = spawnSync('node', args, {
    cwd: apiDir,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: run.status, out: run.stdout + run.stderr };
}

beforeAll(async () => {
  const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  database = await createTestDatabase({ label: 'task024boot', migrations: false });
});

afterAll(async () => {
  child?.kill('SIGTERM');
  await database?.drop();
});

describe('main.api.js (real entry point)', () => {
  it('fails startup with a named reason when the database does not exist', () => {
    const missing = new URL(database.url);
    missing.pathname = '/t_task024_missing_database';
    const result = node(
      ['dist/main.api.js'],
      validEnv('api', { DATABASE_URL: missing.toString(), API_PORT: String(PORT) }),
    );
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      'api failed to start: database check failed: cannot run a query (3D000)',
    );
    expect(result.out).not.toContain('t_task024_missing_database');
  });

  it('fails startup within the acquire timeout when the server does not answer', () => {
    const result = node(
      ['dist/main.api.js'],
      validEnv('api', {
        DATABASE_URL: 'postgres://app_api@127.0.0.1:9/app',
        DATABASE_ACQUIRE_TIMEOUT_MS: '500',
        API_PORT: String(PORT),
      }),
    );
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      'api failed to start: database check failed: cannot run a query (ECONNREFUSED)',
    );
  });

  it('starts, holds its pool from the configuration and closes it on shutdown', async () => {
    const owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    await owner.query('CREATE SCHEMA pgboss');
    await owner.end();
    await migrateJobs(database.url, undefined, null);
    child = spawn('node', ['dist/main.api.js'], {
      cwd: apiDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        ...validEnv('api', {
          DATABASE_URL: database.url,
          API_PORT: String(PORT),
          DATABASE_POOL_MAX: '3',
        }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/health/live`)).ok) break;
      } catch {
        if (Date.now() > deadline) throw new Error(`api did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const admin = new pg.Client({
      connectionString: database.url.replace(/\/[^/]+$/, '/postgres'),
    });
    await admin.connect();
    try {
      const app = await admin.query(
        "select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = 'shroomap'",
        [database.name],
      );
      expect(app.rows[0].n).toBeGreaterThanOrEqual(1);
      expect(app.rows[0].n).toBeLessThanOrEqual(3);
      const closed = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await closed;
      const after = await admin.query(
        "select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = 'shroomap'",
        [database.name],
      );
      expect(after.rows[0].n).toBe(0);
    } finally {
      await admin.end();
    }
  });
});

describe('db:seed (real entry point)', () => {
  const release = (overrides: Record<string, string>) =>
    validEnv('release', { MIGRATION_DATABASE_URL: database.url, ...overrides });

  it('refuses a dataset the environment does not allow, with exit code 2 and no database access', () => {
    const result = node(
      ['dist/database/seed.js', '--dataset=staging'],
      release({ APP_ENV: 'development' }),
    );
    expect(result.status).toBe(2);
    expect(result.out).toContain('seed refused: dataset staging runs only with APP_ENV=staging');
    expect(node(['dist/database/seed.js'], release({})).out).toContain('--dataset must be one of');
  });

  it('fails the reference dataset on an unmigrated database, in one transaction, leaving nothing behind', () => {
    // The migrated run (3 steps, twice) is proven in tests/integration/migrations and tests/integration/seeds.
    for (let run = 0; run < 2; run += 1) {
      const result = node(['dist/database/seed.js', '--dataset=reference'], release({}));
      expect(result.status, result.out).not.toBe(0);
      expect(result.out).not.toContain('seed reference done');
    }
  });
});
