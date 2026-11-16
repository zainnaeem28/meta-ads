import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateJobs } from '../../database/jobs-migrate.js';
import { REGISTRY, keysFor } from './registry.js';
import type { KeyDefinition } from './registry.js';
import { SENTINEL, validEnv } from './test-env.js';
import type { Env } from './test-env.js';

// TC-OPS-02 through the real composition root: the built apps/api/dist/main.api.js, started as a process,
// against a uniquely named database on the shared test PostgreSQL.

const apiDir = join(import.meta.dirname, '..', '..', '..');
const adminUrl =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
const database = `task020_${randomBytes(4).toString('hex')}`;
let databaseUrl = '';

interface Ran {
  code: number | null;
  stderr: string;
}

function run(env: Env, port: number, waitForListen: boolean): Promise<Ran & { live?: unknown }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/main.api.js'], {
      cwd: apiDir,
      env: { PATH: process.env['PATH'] ?? '', ...env, API_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('exit', (code) => resolve({ code, stderr }));
    if (!waitForListen) return;
    const deadline = Date.now() + 30_000;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health/live`);
        const live = await res.json();
        child.removeAllListeners('exit');
        child.kill('SIGTERM');
        child.on('exit', (code) => resolve({ code, stderr, live }));
      } catch {
        if (Date.now() > deadline) child.kill('SIGKILL');
        else setTimeout(() => void poll(), 200);
      }
    };
    void poll();
  });
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
  // The api fails closed without the pg-boss schema and queues: the release order is db:migrate, then jobs:migrate.
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query('CREATE SCHEMA pgboss');
  await db.end();
  await migrateJobs(databaseUrl, undefined, null);
});

afterAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});

describe('api process startup (real entry point, real PostgreSQL)', () => {
  it('starts and answers /health/live with a valid configuration pointing at the test database', async () => {
    const db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    expect((await db.query('SELECT current_database() AS name')).rows[0]).toEqual({
      name: database,
    });
    await db.end();
    const ran = await run(validEnv('api', { DATABASE_URL: databaseUrl }), 3921, true);
    expect(ran.live).toEqual({ status: 'ok' });
    expect(ran.stderr).toBe('');
  });

  const required = keysFor('api').filter((key) =>
    (REGISTRY[key] as KeyDefinition).requiredIn?.includes('api'),
  );
  let port = 3930;
  for (const key of required) {
    it(`exits 78 naming only ${key} when it is missing`, async () => {
      const env = validEnv('api', { DATABASE_URL: databaseUrl });
      delete env[key];
      const ran = await run(env, port++, false);
      expect(ran.code).toBe(78);
      expect(ran.stderr).toContain(key);
      expect(ran.stderr.trim().split('\n')).toHaveLength(1);
      for (const value of Object.values(env)) expect(ran.stderr).not.toContain(value);
    });
  }

  it('exits 78 for an invalid value without printing it', async () => {
    const ran = await run(
      validEnv('api', { DATABASE_URL: databaseUrl, TRUST_PROXY_HOPS: SENTINEL }),
      3999,
      false,
    );
    expect(ran.code).toBe(78);
    expect(ran.stderr).toContain('TRUST_PROXY_HOPS');
    expect(ran.stderr).not.toContain(SENTINEL);
  });

  it('exits 78 when the api process is handed the worker-only KEK private keys', async () => {
    const worker = validEnv('worker');
    const ran = await run(
      validEnv('api', {
        DATABASE_URL: databaseUrl,
        KEK_PRIVATE_KEYS: worker['KEK_PRIVATE_KEYS'] as string,
      }),
      3998,
      false,
    );
    expect(ran.code).toBe(78);
    expect(ran.stderr).toContain('KEK_PRIVATE_KEYS');
    expect(ran.stderr).not.toContain('PRIVATE KEY');
  });
});
