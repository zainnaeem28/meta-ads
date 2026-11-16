import 'reflect-metadata';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CRON_SCHEDULES, createWorkerApp } from '../../bootstrap/worker.module.js';
import type { WorkerApp, WorkerConfig } from '../../bootstrap/worker.module.js';
import { tryRecoverySweepLock } from '../db/index.js';
import { createTestDatabase } from '../db/test-database.js';
import type { TestDatabase } from '../db/test-database.js';
import { buildLogger } from '../logging/index.js';
import { submitOnce, submitOrphanHook } from './at-most-once.js';
import { BOSS, createRuntimeBoss, startRuntimeBoss } from './boss.js';
import { jobTable } from './claim.js';
import { SWEEP_QUEUE, runRecoverySweep } from './sweep.js';
import { SweepRegistry } from './sweep-registry.js';
import { installJobs } from './test-support.js';

// TASK-030 through the real worker composition root (`createWorkerApp`, the one `main.worker.ts` runs) on real
// PostgreSQL: a job handled by the worker process, a worker killed mid-job, the sweep lock between two workers, the
// watchdog on a stalled sweep, and the drain window.

let database: TestDatabase;
const jobs = jobTable('fake_jobs');
const { logger } = buildLogger({ level: 'silent' });
const apps: WorkerApp[] = [];
const extras: PgBoss[] = [];

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    DATABASE_URL: database.url,
    DATABASE_POOL_MAX: 4,
    DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
    WORKER_WATCHDOG_SECONDS: 180,
    WORKER_DRAIN_SECONDS: 5,
    WORKER_CONCURRENCY_PROVIDER: 2,
    WORKER_CONCURRENCY_SANITIZE: 1,
    WORKER_CONCURRENCY_DELETION: 1,
    ...overrides,
  };
}

async function start(
  options: Parameters<typeof createWorkerApp>[1],
  overrides: Partial<WorkerConfig> = {},
): Promise<WorkerApp> {
  const app = await createWorkerApp(config(overrides), options);
  apps.push(app);
  return app;
}

async function apiBoss(): Promise<PgBoss> {
  const boss = createRuntimeBoss({ DATABASE_URL: database.url, role: 'api' });
  boss.on('error', () => undefined);
  await startRuntimeBoss(boss);
  extras.push(boss);
  return boss;
}

async function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function newJob(): Promise<string> {
  const rows = await query<{ id: string }>(
    `insert into fake_jobs (owner_id) values (gen_random_uuid()) returning id::text as id`,
  );
  return rows[0]!.id;
}

const stateOf = async (id: string) =>
  (await query<{ state: string; cause_class: string | null }>(
    'select state, cause_class from fake_jobs where id = $1',
    [id],
  ))[0]!;

beforeAll(async () => {
  database = await createTestDatabase({ label: 'task030', migrations: false });
  await installJobs(database.url);
  await query(`create table fake_jobs (
    id uuid primary key default gen_random_uuid(), owner_id uuid not null, state text not null default 'pending',
    cause_class text, cause_message text, reuse_hash text, key_id uuid, key_version int, submitting_at timestamptz,
    provider_task_id text, next_poll_at timestamptz, deadline_at timestamptz, provider_completed_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.runtime.drain().catch(() => undefined);
    await app.context.close().catch(() => undefined);
  }
  for (const boss of extras.splice(0)) await boss.stop({ graceful: false }).catch(() => undefined);
});

afterAll(async () => {
  await database?.drop();
});

describe('the worker process handles a job end to end', () => {
  it('runs a queued job through the handler and schedules the every-minute sweep', async () => {
    const seen: string[] = [];
    await start({
      logger,
      handlers: {
        'brief.generate': (job) => {
          seen.push(job.id);
          return Promise.resolve();
        },
      },
    });
    const boss = await apiBoss();
    const id = await boss.send('brief.generate', { hello: 'world' });
    await vi.waitFor(() => expect(seen).toEqual([id]), { timeout: 15_000 });

    const schedules = await boss.getSchedules();
    const byQueue = new Map(schedules.map((schedule) => [schedule.name, schedule.cron]));
    expect(byQueue.get(SWEEP_QUEUE)).toBe('* * * * *');
    // Hourly sweeps are scheduled by their owners' handlers: none was registered here.
    expect(byQueue.has('platform.cleanup')).toBe(false);
    expect(CRON_SCHEDULES.map((entry) => entry.queue)).toContain('production.provider-copy-cleanup');
  });

  it('schedules an hourly sweep once its owner registers a handler', async () => {
    await start({ logger, handlers: { 'platform.cleanup': () => Promise.resolve() } });
    const boss = await apiBoss();
    const schedule = await boss.getSchedule('platform.cleanup');
    expect(schedule?.cron).toBe('0 * * * *');
  });
});

describe('kill the worker mid-job', () => {
  it('resumes without a second paid submit: the lost attempt is settled, never resubmitted', async () => {
    let providerCalls = 0;
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const handlerFor = (app: () => WorkerApp) => async (job: { data: unknown }) => {
      const { jobId } = job.data as { jobId: string };
      await submitOnce({
        uow: { run: (fn) => app().runtime.unitOfWork(fn) },
        table: jobs,
        jobId,
        call: async () => {
          providerCalls += 1;
          await stuck; // the worker dies while the provider call is in flight
          return { kind: 'accepted', taskId: 'late' } as const;
        },
      });
    };

    let a!: WorkerApp;
    a = await start({ logger, handlers: { 'brief.generate': handlerFor(() => a) } });
    const jobId = await newJob();
    const boss = await apiBoss();
    await boss.send('brief.generate', { jobId });
    await vi.waitFor(() => expect(providerCalls).toBe(1), { timeout: 15_000 });
    expect((await stateOf(jobId)).state).toBe('submitting');

    // kill -9: no drain, the pool and the pg-boss instance simply go away
    await a.context.get<PgBoss>(BOSS).stop({ graceful: false });
    await a.context.close();
    apps.splice(apps.indexOf(a), 1);

    // a new worker starts; its start-up sweep settles the orphan
    let b!: WorkerApp;
    const registry = new SweepRegistry();
    registry.register(submitOrphanHook('fake-orphans', jobs, 0));
    b = await start({ logger, registry, handlers: { 'brief.generate': handlerFor(() => b) } });
    await vi.waitFor(
      async () => expect(await stateOf(jobId)).toEqual({ state: 'failed', cause_class: 'outcome_unknown' }),
      { timeout: 15_000 },
    );

    // a duplicate delivery of the same job reaches no provider
    await boss.send('brief.generate', { jobId });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(providerCalls).toBe(1);
    release();
  });
});

describe('one sweep at a time', () => {
  it('two workers sweeping together never run the hooks concurrently', async () => {
    let running = 0;
    let peak = 0;
    let runs = 0;
    const hookFor = () => {
      const registry = new SweepRegistry();
      registry.register({
        name: 'slow',
        async run() {
          running += 1;
          runs += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 400));
          running -= 1;
          return { swept: 0 };
        },
      });
      return registry;
    };
    const a = await start({ logger, registry: hookFor() });
    const b = await start({ logger, registry: hookFor() });
    await vi.waitFor(() => expect(running).toBe(0), { timeout: 10_000 });
    runs = 0;
    await Promise.all([a.runtime.sweep(), b.runtime.sweep(), a.runtime.sweep(), b.runtime.sweep()]);
    expect(peak).toBe(1);
    expect(runs).toBe(1);
  });

  it('the lock is free again after a sweep and refused while a session holds it', async () => {
    const a = await start({ logger, registry: new SweepRegistry() });
    const pool = new pg.Pool({ connectionString: database.url, max: 1 });
    try {
      const held = await tryRecoverySweepLock(pool);
      expect(held).not.toBeNull();
      const registry = new SweepRegistry();
      const run = vi.fn().mockResolvedValue({ swept: 0 });
      registry.register({ name: 'h', run });
      const other = new pg.Pool({ connectionString: database.url, max: 1 });
      try {
        const skipped = await runRecoverySweep({
          registry,
          log: logger,
          inTx: (fn) => a.runtime.unitOfWork(fn),
          acquire: () => tryRecoverySweepLock(other),
        });
        expect(skipped.kind).toBe('skipped');
        await held!.release();
        const ran = await runRecoverySweep({
          registry,
          log: logger,
          inTx: (fn) => a.runtime.unitOfWork(fn),
          acquire: () => tryRecoverySweepLock(other),
        });
        expect(ran.kind).toBe('ran');
      } finally {
        await other.end();
      }
    } finally {
      await pool.end();
    }
  });
});

describe('watchdog', () => {
  it('exits 70 when the sweep hangs past WORKER_WATCHDOG_SECONDS', async () => {
    const exit = vi.fn();
    let free: () => void = () => undefined;
    const hang = new Promise<void>((resolve) => (free = resolve));
    const registry = new SweepRegistry();
    registry.register({
      name: 'hang',
      async run() {
        await hang;
        return { swept: 0 };
      },
    });
    await start({ logger, registry, exit }, { WORKER_WATCHDOG_SECONDS: 1 });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(70), { timeout: 10_000 });
    free();
  });
});

describe('SIGTERM drain', () => {
  it('waits for the job in hand and returns inside WORKER_DRAIN_SECONDS', async () => {
    let started = false;
    let finished = false;
    const app = await start(
      {
        logger,
        handlers: {
          'brief.generate': async () => {
            started = true;
            await new Promise((resolve) => setTimeout(resolve, 1200));
            finished = true;
          },
        },
      },
      { WORKER_DRAIN_SECONDS: 10 },
    );
    const boss = await apiBoss();
    await boss.send('brief.generate', {});
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 15_000 });
    const t0 = Date.now();
    await app.runtime.drain();
    expect(finished).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('gives up at the end of the window when a job does not finish', async () => {
    let started = false;
    let free: () => void = () => undefined;
    const never = new Promise<void>((resolve) => (free = resolve));
    const app = await start(
      {
        logger,
        handlers: {
          'brief.generate': async () => {
            started = true;
            await never;
          },
        },
      },
      { WORKER_DRAIN_SECONDS: 1 },
    );
    const boss = await apiBoss();
    await boss.send('brief.generate', {});
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 15_000 });
    const t0 = Date.now();
    await app.runtime.drain();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(5000);
    await app.runtime.drain(); // a second signal is a no-op
    free();
  });
});
