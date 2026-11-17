// A throwaway database on the shared test PostgreSQL for FLOW-03: the real migrations' tables (the grants need roles the
// shared server does not have, so each file is applied up to its "-- Grants" step, as the api's own integration suites do),
// the pg-boss schema and queues, and the reference price table. `node database.mjs create` prints its URL;
// `node database.mjs drop <name>` removes it.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const api = resolve(import.meta.dirname, '../../../../api');
const dist = join(api, 'dist');
const migrations = join(api, 'src/database/migrations');
const load = (file) => import(pathToFileURL(`${dist}/${file}`).href);
const require = (await import('node:module')).createRequire(join(api, 'package.json'));
const pg = require('pg');

const FILES = [
  '0010_task-032-audit.sql',
  '0020_task-033-identity.sql',
  '0030_task-039-provider-keys.sql',
  '0040_task-041-media.sql',
  '0050_task-044-usage.sql',
  '0060_task-058-lifecycle.sql',
  '0070_task-046-campaigns.sql',
  '0080_task-048-brief.sql',
  '0090_task-052-production-video.sql',
  '0100_task-055-production-assembly.sql',
  '0110_task-057-production-thumbstopper.sql',
];

if (process.argv[2] === 'create') {
  const { createTestDatabase } = await load('platform/db/test-database.js');
  const { installJobs } = await load('platform/jobs/test-support.js');
  const { runSeed } = await load('database/seed.js');
  const { priceTableSeedStep } = await load('modules/usage/index.js');
  const database = await createTestDatabase({ label: 'flow03', migrations: false });
  const pool = new pg.Pool({ connectionString: database.url, max: 1 });
  const statements = (file, only) => {
    const sql = readFileSync(join(migrations, file), 'utf8').split('-- Grants')[0] ?? '';
    return sql
      .split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((s) => s !== '' && (only === undefined || only.test(s)));
  };
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const s of statements(
    '0001_task-025-platform.sql',
    /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/,
  ))
    await pool.query(s);
  for (const file of FILES) for (const s of statements(file)) await pool.query(s);
  await pool.end();
  await installJobs(database.url);
  await runSeed({
    dataset: 'reference',
    appEnv: 'development',
    databaseUrl: database.url,
    steps: [priceTableSeedStep()],
  });
  process.stdout.write(database.url);
} else if (process.argv[2] === 'drop') {
  const { adminUrl } = await load('platform/db/test-database.js');
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${process.argv[3]}" WITH (FORCE)`);
  await client.end();
}
