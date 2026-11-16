import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../src/bootstrap/api.module.js';
import { migrateJobs } from '../../../src/database/jobs-migrate.js';
import { validEnv } from '../../../src/platform/config/test-env.js';
import { createHttpLogging } from '../../../src/platform/logging/index.js';
import {
  apiDir,
  cleanup,
  drizzleMigrate,
  pgbossTables,
  provision,
  renderMigrations,
  teardown,
  tryQuery,
  withClient,
} from '../migrations/support/harness.js';
import type { Env } from '../migrations/support/harness.js';
import {
  BOSS,
  JobsNotReadyError,
  createRuntimeBoss,
  startRuntimeBoss,
} from '../../../src/platform/jobs/boss.js';
import { enqueue, UnknownQueueError } from '../../../src/platform/jobs/enqueue.js';
import { QUEUES } from '../../../src/platform/jobs/queues.js';

// TASK-028 on real PostgreSQL with the four roles: the release steps (`db:migrate`, then `jobs:migrate`) as
// app_migrator, then the runtime composition root and a worker-role pg-boss as app_api and app_worker.

let env: Env;
let dir: string;
const roles = () => ({ api: env.roles.api, worker: env.roles.worker });
const logging = () => createHttpLogging({ level: 'silent' });
const edge = (role: 'api' | 'worker' = 'api') => ({
  WEB_ORIGIN: 'http://localhost:3000',
  APP_ENV: 'development' as const,
  DATABASE_URL: env.urlFor(role),
  DATABASE_POOL_MAX: 3,
  DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
});

beforeAll(async () => {
  env = await provision();
  dir = renderMigrations(env);
  const migrated = drizzleMigrate(env, dir);
  expect(migrated.status, migrated.stdout + migrated.stderr).toBe(0);
});

afterAll(async () => {
  cleanup(dir);
  expect(await teardown(env)).toEqual([]);
});

async function asMigrator<T>(fn: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = new PgBoss({
    connectionString: env.urlFor('migrator'),
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 1,
  });
  boss.on('error', () => undefined);
  await boss.start();
  try {
    return await fn(boss);
  } finally {
    await boss.stop({ graceful: true });
  }
}

describe('fail closed before jobs:migrate (probe 11, TC-BKP-08)', () => {
  it('the api composition root refuses to start while the pg-boss schema is not installed', async () => {
    await expect(createApiApp(edge(), logging())).rejects.toThrow(/not installed/);
  });

  it('the built main.api.js exits 1 with the reason on stderr', () => {
    const build = spawnSync('pnpm', ['build'], { cwd: apiDir, encoding: 'utf8' });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const run = spawnSync('node', ['dist/main.api.js'], {
      cwd: apiDir,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env['PATH'] ?? '',
        ...validEnv('api', { DATABASE_URL: env.urlFor('api'), API_PORT: '3951' }),
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/api failed to start: pg-boss is not installed/);
  });

  it('a pg-boss migrate start by a runtime role is refused and creates nothing', async () => {
    for (const role of ['api', 'worker'] as const) {
      const boss = new PgBoss({
        connectionString: env.urlFor(role),
        schema: 'pgboss',
        migrate: true,
        createSchema: false,
        max: 1,
      });
      boss.on('error', () => undefined);
      await expect(boss.start()).rejects.toThrow(/permission denied|must be owner/i);
      await boss.stop({ graceful: false }).catch(() => undefined);
    }
    expect(await pgbossTables(env)).toEqual([]);
  });
});

describe('jobs:migrate (TC-BKP-07/08)', () => {
  it('installs the schema and every catalogue queue, and a second run only updates', async () => {
    const first = await migrateJobs(env.urlFor('migrator'), QUEUES, roles());
    expect(first.created).toEqual(QUEUES.map((q) => q.name));
    expect(first.updated).toEqual([]);
    const second = await migrateJobs(env.urlFor('migrator'), QUEUES, roles());
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual(QUEUES.map((q) => q.name));
    await asMigrator(async (boss) => {
      for (const queue of QUEUES) {
        const stored = await boss.getQueue(queue.name);
        expect(stored?.retryLimit, queue.name).toBe(queue.retryLimit);
        expect(stored?.expireInSeconds, queue.name).toBe(queue.expireInSeconds);
      }
    });
  });

  it('the runtime roles cannot create a queue', async () => {
    const api = createRuntimeBoss({ DATABASE_URL: env.urlFor('api'), role: 'api' });
    api.on('error', () => undefined);
    await api.start();
    try {
      await expect(api.createQueue('rogue-api')).rejects.toThrow(/permission denied/i);
      await expect(api.createQueue('rogue-api-part', { partition: true })).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await api.stop({ graceful: true });
    }
    const worker = createRuntimeBoss({ DATABASE_URL: env.urlFor('worker'), role: 'worker' });
    worker.on('error', () => undefined);
    await worker.start();
    try {
      await expect(worker.createQueue('rogue-part', { partition: true })).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await worker.stop({ graceful: true });
    }
    const rows = await tryQuery(
      env.urlFor('superuser'),
      `SELECT name FROM pgboss.queue WHERE name LIKE 'rogue%'`,
    );
    expect(rows.ok ? rows.rows : 'query failed').toEqual([]);
  });
});

describe('the api composition root and the worker after jobs:migrate', () => {
  it('starts, and a job enqueued on the caller transaction rolls back with it and commits with it', async () => {
    const { app } = await createApiApp(edge(), logging());
    const pool = new pg.Pool({ connectionString: env.urlFor('api'), max: 2 });
    try {
      const boss = app.get<PgBoss>(BOSS);
      const db = drizzle(pool);
      const count = async (name: string) =>
        withClient(env.urlFor('superuser'), async (c) => {
          const r = await c.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1`, [
            name,
          ]);
          return (r.rows[0] as { n: number }).n;
        });

      await expect(
        db.transaction(async (tx) => {
          expect(await enqueue(boss, tx, 'platform.cleanup', { n: 1 })).toBeTruthy();
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await count('platform.cleanup')).toBe(0);

      const id = await db.transaction((tx) => enqueue(boss, tx, 'platform.cleanup', { n: 2 }));
      expect(id).toBeTruthy();
      expect(await count('platform.cleanup')).toBe(1);

      await expect(
        db.transaction((tx) => enqueue(boss, tx, 'not-in-the-catalogue', {})),
      ).rejects.toBeInstanceOf(UnknownQueueError);
      const rejected = await db.transaction((tx) =>
        enqueue(boss, tx, 'brief.generate', { x: 1 }, { retryLimit: 3 }).catch((e: unknown) => e),
      );
      expect((rejected as Error).name).toBe('RetryOnSubmitQueueError');
      expect(await count('brief.generate')).toBe(0);
    } finally {
      await pool.end();
      await app.close();
    }
  });

  it('a job committed by the api is handled by the worker process', async () => {
    const { app } = await createApiApp(edge(), logging());
    const pool = new pg.Pool({ connectionString: env.urlFor('api'), max: 2 });
    const worker = createRuntimeBoss({ DATABASE_URL: env.urlFor('worker'), role: 'worker' });
    worker.on('error', () => undefined);
    try {
      await startRuntimeBoss(worker);
      const seen = new Promise<unknown>((resolve) => {
        void worker.work('media.sanitize', { pollingIntervalSeconds: 0.5 }, async (jobs) => {
          resolve(jobs[0]?.data);
        });
      });
      await drizzle(pool).transaction((tx) =>
        enqueue(app.get<PgBoss>(BOSS), tx, 'media.sanitize', { mediaId: 'm-1' }),
      );
      expect(await seen).toEqual({ mediaId: 'm-1' });
    } finally {
      await worker.stop({ graceful: true });
      await pool.end();
      await app.close();
    }
  });

  it('refuses to start when a catalogue queue is missing, naming it, for the api and the worker', async () => {
    await asMigrator(async (boss) => boss.deleteQueue('media.unattached-sweep'));
    await expect(createApiApp(edge(), logging())).rejects.toThrow(
      /catalogue queue\(s\) missing: media\.unattached-sweep/,
    );
    const worker = createRuntimeBoss({ DATABASE_URL: env.urlFor('worker'), role: 'worker' });
    worker.on('error', () => undefined);
    await expect(startRuntimeBoss(worker)).rejects.toBeInstanceOf(JobsNotReadyError);
    await migrateJobs(env.urlFor('migrator'), QUEUES, roles());
    const { app } = await createApiApp(edge(), logging());
    await app.close();
  });

  it('refuses to start when the schema is behind this build', async () => {
    const version = await withClient(env.urlFor('migrator'), async (c) => {
      const r = await c.query('SELECT version FROM pgboss.version');
      await c.query('UPDATE pgboss.version SET version = version - 1');
      return (r.rows[0] as { version: number }).version;
    });
    try {
      await expect(createApiApp(edge(), logging())).rejects.toThrow(/requires migrations/);
    } finally {
      await withClient(env.urlFor('migrator'), (c) =>
        c.query('UPDATE pgboss.version SET version = $1', [version]),
      );
    }
  });
});
