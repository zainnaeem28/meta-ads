// A throwaway database on the shared test PostgreSQL with the pg-boss schema and queues the built api needs to start.
// `node database.mjs create` prints its URL; `node database.mjs drop <name>` removes it.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../../../../api/dist');
const load = (file) => import(pathToFileURL(`${dist}/${file}`).href);

if (process.argv[2] === 'create') {
  const { createTestDatabase } = await load('platform/db/test-database.js');
  const { installJobs } = await load('platform/jobs/test-support.js');
  const database = await createTestDatabase({ label: 'flow13', migrations: false });
  await installJobs(database.url);
  process.stdout.write(database.url);
} else if (process.argv[2] === 'drop') {
  const { adminUrl } = await load('platform/db/test-database.js');
  const { default: pg } = await import(pathToFileURL(resolve(dist, '../node_modules/pg/lib/index.js')).href);
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${process.argv[3]}" WITH (FORCE)`);
  await client.end();
}
