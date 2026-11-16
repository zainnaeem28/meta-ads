// Runs the @TASK-091 Playwright check against its own throwaway database on the shared test PostgreSQL:
// create, migrate, install the jobs schema, run, drop. Needs `pnpm --filter @shroomap/api build` first.
// Usage (from the repository root): node docs/evidence/TASK-091/e2e-with-database.mjs
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve('apps/api/dist/platform');
const { createTestDatabase } = await import(pathToFileURL(`${dist}/db/test-database.js`));
const { installJobs } = await import(pathToFileURL(`${dist}/jobs/test-support.js`));

const database = await createTestDatabase({ label: 'task091_e2e', migrations: false });
let status = 1;
try {
  await installJobs(database.url);
  const reports = 'reports/fe-screen-006a';
  const run = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '--project=chromium', '--grep', '@TASK-091', '--reporter=junit'],
    {
      cwd: 'apps/web',
      stdio: 'inherit',
      env: {
        ...process.env,
        CI: '1',
        REPORT_DIR: reports,
        PLAYWRIGHT_JUNIT_OUTPUT_FILE: `${reports}/e2e-junit.xml`,
        WEB_PORT: process.env.WEB_PORT ?? '3191',
        E2E_API_PORT: process.env.E2E_API_PORT ?? '4191',
        E2E_DATABASE_URL: database.url,
      },
    },
  );
  status = run.status ?? 1;
} finally {
  await database.drop();
}
process.exit(status);
