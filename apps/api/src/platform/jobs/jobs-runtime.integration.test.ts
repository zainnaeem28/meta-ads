import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import { validEnv } from '../config/test-env.js';
import { UnitOfWork } from '../db/index.js';
import { createTestDatabase } from '../db/test-database.js';
import type { TestDatabase } from '../db/test-database.js';
import { createHttpLogging } from '../logging/index.js';
import { submitOnce } from './at-most-once.js';
import { BOSS, createRuntimeBoss, startRuntimeBoss } from './boss.js';
import { jobTable } from './claim.js';
import { enqueue } from './enqueue.js';
import { POLL_QUEUE, runPoll, schedulePoll } from './poll.js';
import { installJobs } from './test-support.js';

// TASK-029 through the real composition root: the api (`createApiApp`, the one `main.api.ts` runs) submits a job on
// real PostgreSQL and arms its poll on the caller's transaction; a worker-role pg-boss handles the poll job, and a
// duplicate delivery of it reaches the provider no second time.

let database: TestDatabase;
const jobs = jobTable('fake_jobs');
const timing = { intervalSec: 1, leaseSec: 30 };

beforeAll(async () => {
  database = await createTestDatabase({ label: 'task029root', migrations: false });
  await installJobs(database.url);
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query(`create table fake_jobs (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null, state text not null default 'pending',
      cause_class text, cause_message text, reuse_hash text, key_id uuid, key_version int, submitting_at timestamptz,
      provider_task_id text, next_poll_at timestamptz, deadline_at timestamptz, provider_completed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  } finally {
    await client.end();
  }
});

afterAll(async () => {
  await database?.drop();
});

describe('submit, poll and duplicate delivery through the api composition root and a worker', () => {
  it('one provider submit, one provider poll, and the job ends with provider_completed_at set', async () => {
    const { app } = await createApiApp(
      {
        WEB_ORIGIN: 'http://localhost:3000',
        APP_ENV: 'development',
        DATABASE_URL: database.url,
        DATABASE_POOL_MAX: 3,
        DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
        RATE_LIMIT_IP_KEY: validEnv('api', {})['RATE_LIMIT_IP_KEY'],
        TRUST_PROXY_HOPS: 1,
        JOB_CREATE_RATE_LIMIT: 3,
        JOB_CREATE_RATE_WINDOW_MIN: 10,
      },
      createHttpLogging({ level: 'silent' }),
    );
    const pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const worker = createRuntimeBoss({ DATABASE_URL: database.url, role: 'worker' });
    worker.on('error', () => undefined);
    try {
      const boss = app.get<PgBoss>(BOSS);
      const uow = new UnitOfWork(drizzle(pool));
      const created = await pool.query<{ id: string }>(
        `insert into fake_jobs (owner_id) values (gen_random_uuid()) returning id`,
      );
      const id = (created.rows[0] as { id: string }).id;

      let submits = 0;
      let polls = 0;
      const submitted = await submitOnce({
        uow,
        table: jobs,
        jobId: id,
        call: async () => {
          submits += 1;
          return { kind: 'accepted', taskId: 'provider-task' };
        },
        afterAccepted: async (tx) => {
          await schedulePoll(boss, tx, jobs, id, timing.intervalSec);
        },
      });
      expect(submitted).toEqual({ kind: 'submitted', taskId: 'provider-task' });
      await submitOnce({
        uow,
        table: jobs,
        jobId: id,
        call: async () => ((submits += 1), { kind: 'unknown' }),
      });
      expect(submits).toBe(1);

      await startRuntimeBoss(worker);
      const handled: string[] = [];
      await worker.work<{ jobId: string }>(
        POLL_QUEUE,
        { pollingIntervalSeconds: 0.5 },
        async (batch) => {
          for (const job of batch) {
            const outcome = await runPoll({
              boss: worker,
              uow,
              table: jobs,
              jobId: job.data.jobId,
              timing,
              call: async () => {
                polls += 1;
                return { kind: 'completed' };
              },
            });
            handled.push(outcome.kind);
          }
        },
      );
      await expect
        .poll(
          async () =>
            (
              await pool.query('select state, provider_completed_at from fake_jobs where id = $1', [
                id,
              ])
            ).rows[0]?.provider_completed_at,
          { timeout: 30_000 },
        )
        .not.toBeNull();

      // A second delivery of the same poll (at-least-once queue) is skipped: the provider is not called again.
      await drizzle(pool).transaction((tx) => enqueue(boss, tx, POLL_QUEUE, { jobId: id }));
      await expect.poll(() => handled.length, { timeout: 30_000 }).toBe(2);
      expect(handled).toEqual(['polled', 'skipped']);
      expect(polls).toBe(1);
      expect(submits).toBe(1);
    } finally {
      await worker.stop({ graceful: true });
      await pool.end();
      await app.close();
    }
  });
});
