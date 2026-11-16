import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { QUEUES } from './queues.js';
import type { CatalogueQueue } from './queues.js';

export const PGBOSS_SCHEMA = 'pgboss';
export const BOSS = Symbol('PG_BOSS');

export type JobsRole = 'api' | 'worker';

/** The runtime handle: the queue DDL calls are not part of it (SB-D24, they run only in `jobs:migrate`). */
export type RuntimeBoss = Omit<PgBoss, 'createQueue' | 'updateQueue' | 'deleteQueue'>;

export interface JobsConfig {
  readonly DATABASE_URL: string;
  readonly role: JobsRole;
  /** pg-boss's own pool: the design budgets 2 for the api and 4 for the worker. */
  readonly poolMax?: number;
  readonly queues?: readonly CatalogueQueue[];
}

export class JobsNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsNotReadyError';
  }
}

/**
 * pg-boss as a runtime process runs it: no schema migration, no schema creation, `jobs:migrate` owns both. The api
 * neither supervises nor schedules; the worker does both (maintenance, cron).
 */
export function createRuntimeBoss(config: JobsConfig): PgBoss {
  const worker = config.role === 'worker';
  return new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: worker,
    schedule: worker,
    max: config.poolMax ?? (worker ? 4 : 2),
    application_name: `shroomap-${config.role}-jobs`,
  });
}

/** The schema version this build of pg-boss expects (read from the installed package). */
export function expectedSchemaVersion(): number {
  const entry = createRequire(import.meta.url).resolve('pg-boss');
  const root = dirname(dirname(entry));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    pgboss: { schema: number };
  };
  return manifest.pgboss.schema;
}

/**
 * Fail closed (DEVOPS-PLAN §15 probe 11): the schema must be installed at the version this build expects, and every
 * catalogue queue must exist. Nothing is created here; the remedy is to run `jobs:migrate`.
 */
export async function assertJobsReady(
  boss: Pick<PgBoss, 'isInstalled' | 'schemaVersion' | 'getQueues'>,
  queues: readonly CatalogueQueue[] = QUEUES,
): Promise<void> {
  if (!(await boss.isInstalled())) {
    throw new JobsNotReadyError('pg-boss schema is not installed: run jobs:migrate');
  }
  const installed = await boss.schemaVersion();
  const expected = expectedSchemaVersion();
  if (installed === null || installed < expected) {
    throw new JobsNotReadyError(
      `pg-boss schema is at version ${String(installed)}, this build needs ${String(expected)}: run jobs:migrate`,
    );
  }
  const present = new Set((await boss.getQueues(queues.map((queue) => queue.name))).map((q) => q.name));
  const missing = queues.filter((queue) => !present.has(queue.name)).map((queue) => queue.name);
  if (missing.length > 0) {
    throw new JobsNotReadyError(
      `catalogue queue(s) missing: ${missing.join(', ')}: run jobs:migrate`,
    );
  }
}

/** Start the runtime instance and check it; a failed check stops it again so the process can exit. */
export async function startRuntimeBoss(
  boss: PgBoss,
  queues: readonly CatalogueQueue[] = QUEUES,
): Promise<void> {
  try {
    await boss.start();
    await assertJobsReady(boss, queues);
  } catch (error) {
    await boss.stop({ graceful: false }).catch(() => undefined);
    throw error;
  }
}

@Injectable()
export class JobsLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject('JOBS_QUEUES') private readonly queues: readonly CatalogueQueue[],
  ) {}

  async onModuleInit(): Promise<void> {
    await startRuntimeBoss(this.boss, this.queues);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

@Module({})
export class JobsModule {
  static forRoot(config: JobsConfig): DynamicModule {
    const boss = createRuntimeBoss(config);
    // pg-boss emits `error` for background faults; an unhandled one would crash the process with no context.
    boss.on('error', (error: Error) => {
      process.stderr.write(`pg-boss error: ${error.message}\n`);
    });
    return {
      module: JobsModule,
      global: true,
      providers: [
        { provide: BOSS, useValue: boss },
        { provide: 'JOBS_QUEUES', useValue: config.queues ?? QUEUES },
        JobsLifecycle,
      ],
      exports: [BOSS],
    };
  }
}
