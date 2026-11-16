import pg from 'pg';
import { migrateJobs } from '../../database/jobs-migrate.js';

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
