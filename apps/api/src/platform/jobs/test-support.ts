import pg from 'pg';
import { migrateJobs } from '../../database/jobs-migrate.js';
import { SWEEP_QUEUE } from './sweep.js';

/**
 * Test helper: a throwaway database that a real process (`dist/main.api.js`) will start against needs the pg-boss
 * schema and the catalogue queues, as the release step leaves them. No application roles exist there.
 */
export async function installJobs(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS pgboss');
  } finally {
    await client.end();
  }
  await migrateJobs(databaseUrl, undefined, null);
}

/**
 * Test helper: stop the periodic recovery sweep (the every-minute cron and any tick already queued) so a test that
 * counts provider reads or watches a row step by step sees only the sweeps it runs itself through `runtime.sweep()`.
 * The sweep stays registered and runnable; only its schedule is removed.
 */
export async function stopPeriodicSweep(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`delete from pgboss.schedule where name = $1`, [SWEEP_QUEUE]);
    await client.query(`delete from pgboss.job where name = $1 and state in ('created', 'retry')`, [
      SWEEP_QUEUE,
    ]);
  } finally {
    await client.end();
  }
}
