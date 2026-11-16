import { pathToFileURL } from 'node:url';
import { PgBoss } from 'pg-boss';
import { loadConfigOrExit } from '../platform/config/index.js';
import { PGBOSS_SCHEMA } from '../platform/jobs/boss.js';
import { QUEUES, queueOptions } from '../platform/jobs/queues.js';
import type { CatalogueQueue } from '../platform/jobs/queues.js';

/**
 * `jobs:migrate` (ARCHITECTURE §2.7, SB-D24), run as `app_migrator` after `db:migrate`: installs or upgrades the
 * pg-boss schema in the schema M0001 created, then creates each catalogue queue that is missing and updates the
 * tunable options of those that exist. It is the only place `createQueue` is called, and it is idempotent.
 */
export interface JobsMigrateResult {
  readonly created: string[];
  readonly updated: string[];
}

export interface RuntimeRoles {
  readonly api: string;
  readonly worker: string;
}

export const RUNTIME_ROLES: RuntimeRoles = { api: 'app_api', worker: 'app_worker' };

function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe role name ${name}`);
  return `"${name}"`;
}

/** `roles` null skips the table privilege step (a throwaway test database with no application roles). */
export async function migrateJobs(
  connectionString: string,
  queues: readonly CatalogueQueue[] = QUEUES,
  roles: RuntimeRoles | null = RUNTIME_ROLES,
): Promise<JobsMigrateResult> {
  const boss = new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: true,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 2,
    application_name: 'shroomap-jobs-migrate',
  });
  boss.on('error', (error: Error) => {
    process.stderr.write(`pg-boss error: ${error.message}\n`);
  });
  const result: JobsMigrateResult = { created: [], updated: [] };
  try {
    await boss.start();
    for (const queue of queues) {
      const options = queueOptions(queue);
      if ((await boss.getQueue(queue.name)) === null) {
        await boss.createQueue(queue.name, options);
        result.created.push(queue.name);
      } else {
        // Policy and partitioning cannot change on an existing queue; the rest is tunable.
        const tunable: Record<string, unknown> = { ...options };
        delete tunable['policy'];
        delete tunable['partition'];
        await boss.updateQueue(queue.name, tunable);
        result.updated.push(queue.name);
      }
    }
    // A queue row is catalogue data: the api can never write one, the worker only inserts the rows pg-boss's own
    // scheduler needs (stack validation F-1). Table privileges can only be narrowed once the table exists.
    if (roles !== null) {
      const db = boss.getDb();
      await db.executeSql(
        `REVOKE INSERT, UPDATE, DELETE ON ${PGBOSS_SCHEMA}.queue FROM ${identifier(roles.api)}`,
      );
      await db.executeSql(
        `REVOKE DELETE ON ${PGBOSS_SCHEMA}.queue FROM ${identifier(roles.worker)}`,
      );
    }
  } finally {
    await boss.stop({ graceful: true });
  }
  return result;
}

export async function main(): Promise<void> {
  const config = loadConfigOrExit('release');
  const url = config.MIGRATION_DATABASE_URL;
  if (url === undefined) throw new Error('MIGRATION_DATABASE_URL is required');
  const { created, updated } = await migrateJobs(url);
  process.stdout.write(`jobs:migrate done: ${created.length} created, ${updated.length} updated\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'jobs:migrate failed'}\n`);
    process.exit(1);
  });
}
