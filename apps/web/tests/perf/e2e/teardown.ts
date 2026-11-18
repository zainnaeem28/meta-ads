import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Drops the run's database. */
export default function teardown() {
  const url = process.env.PERF_DATABASE_URL;
  if (url)
    execFileSync('node', [
      resolve(__dirname, '../../e2e/local-token/database.mjs'),
      'drop',
      new URL(url).pathname.slice(1),
    ]);
}
