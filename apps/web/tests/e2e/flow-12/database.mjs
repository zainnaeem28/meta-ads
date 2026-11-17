// A throwaway database on the shared test PostgreSQL with the pg-boss schema and queues the built api needs to start.
// `node database.mjs create` prints its URL; `node database.mjs drop <name>` removes it.
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../../../../api/dist');
const load = (file) => import(pathToFileURL(`${dist}/${file}`).href);

if (process.argv[2] === 'create') {
  const { createTestDatabase } = await load('platform/db/test-database.js');
  const { installJobs } = await load('platform/jobs/test-support.js');
  const database = await createTestDatabase({ label: 'flow12', migrations: false });
  // The real migrations without their role grants and role checks (the shared test server has no provisioned roles).
  const { default: pg } = await import(
    pathToFileURL(resolve(dist, '../node_modules/pg/lib/index.js')).href
  );
  const folder = resolve(dist, '../src/database/migrations');
  const pool = new pg.Pool({ connectionString: database.url, max: 1 });
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(resolve(folder, file), 'utf8').split('-- Grants')[0];
    for (const statement of sql.split('--> statement-breakpoint')) {
      const text = statement.trim();
      if (text !== '' && !/^(--[^\n]*\n\s*)*DO\b/i.test(text)) await pool.query(text);
    }
  }
  await pool.end();
  await installJobs(database.url);
  process.stdout.write(database.url);
} else if (process.argv[2] === 'exec') {
  // Runs one statement on the run's database and prints the rows as JSON (the test's own clock moves and reads).
  const { default: pg } = await import(
    pathToFileURL(resolve(dist, '../node_modules/pg/lib/index.js')).href
  );
  const client = new pg.Client({ connectionString: process.argv[3] });
  await client.connect();
  const result = await client.query(process.argv[4]);
  await client.end();
  process.stdout.write(JSON.stringify(result.rows ?? []));
} else if (process.argv[2] === 'drop') {
  const { adminUrl } = await load('platform/db/test-database.js');
  const { default: pg } = await import(
    pathToFileURL(resolve(dist, '../node_modules/pg/lib/index.js')).href
  );
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${process.argv[3]}" WITH (FORCE)`);
  await client.end();
}
