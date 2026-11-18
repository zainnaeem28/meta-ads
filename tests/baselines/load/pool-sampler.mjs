#!/usr/bin/env node
/* global setTimeout */
// Samples the api's database connections during the load run (DB pool saturation, TC-NFR-01). Runs until killed.
// Usage: pool-sampler.mjs STATE_FILE OUT_FILE
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pg = createRequire(join(root, 'apps', 'api', 'package.json'))('pg');
const [stateFile, outFile] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const poolMax = Number(process.env.DATABASE_POOL_MAX ?? 10); // registry default of the api process
const samples = [];
const client = new pg.Client({
  connectionString: state.dbAdminUrl.replace(/\/[^/]*$/, `/${state.database}`),
});
await client.connect();
const flush = () =>
  writeFileSync(
    outFile,
    JSON.stringify({
      poolMax,
      samples: samples.length,
      max: Math.max(0, ...samples),
      mean: samples.reduce((a, b) => a + b, 0) / (samples.length || 1),
    }),
  );
process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});
for (;;) {
  const r = await client.query(
    'select count(*)::int as n from pg_stat_activity where usename = $1 and datname = $2',
    [state.roles.api, state.database],
  );
  samples.push(r.rows[0].n);
  flush();
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
}
