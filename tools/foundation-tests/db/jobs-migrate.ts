import { PgBoss } from 'pg-boss';
import { baseQueues } from './queues.ts';
import type { Queue } from 'pg-boss';

// Foundation form of `jobs:migrate` (ARCHITECTURE §2.7): under app_migrator, install or upgrade the
// pg-boss 12 schema into the pre-created `pgboss` schema, then create every queue of the catalogue
// that is missing and update the ones whose options differ. It is the only place createQueue runs.
// EXTRA_QUEUES (JSON array of queue definitions) stands for a queue added to the catalogue later.
const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const extra = JSON.parse(process.env['EXTRA_QUEUES'] ?? '[]') as Queue[];
const catalogue: Queue[] = [...baseQueues, ...extra];

const boss = new PgBoss({
  connectionString: url,
  schema: 'pgboss',
  migrate: true,
  createSchema: false,
  supervise: false,
  schedule: false,
  max: 2,
});
boss.on('error', (error) => {
  console.error(`pg-boss error: ${error.message}`);
});

try {
  await boss.start();
  for (const queue of catalogue) {
    const { name, ...options } = queue;
    const existing = await boss.getQueue(name);
    if (!existing) {
      await boss.createQueue(name, options);
      console.log(`created queue ${name}`);
    } else {
      // Only the catalogue's tunable options; partition and policy cannot change on an existing queue.
      const { retryLimit, retryBackoff, expireInSeconds } = options;
      await boss.updateQueue(
        name,
        Object.fromEntries(
          Object.entries({ retryLimit, retryBackoff, expireInSeconds }).filter(
            ([, v]) => v !== undefined,
          ),
        ),
      );
      console.log(`queue ${name} present, options updated`);
    }
  }
} finally {
  await boss.stop({ graceful: true });
}
console.log('jobs:migrate done');
