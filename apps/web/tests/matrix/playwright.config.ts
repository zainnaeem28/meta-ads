import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

// TASK-117 runs on the same built artifacts as every other e2e: the compiled api and `next start`
// (see apps/web/playwright.config.ts, whose `matrix-*` projects this config selects).
// Run from apps/web: `pnpm exec playwright test --config tests/matrix/playwright.config.ts --grep @matrix`.
const webDir = resolve(__dirname, '../..');
const reports = resolve(webDir, process.env.REPORT_DIR ?? 'reports/matrix');

// The api refuses to start without the pg-boss schema, so the run uses a throwaway database prepared by the
// FLOW-11 helper (created by the first config load, dropped by global teardown).
const helper = resolve(webDir, 'tests/e2e/flow-11/database.mjs');
process.env.MATRIX_DATABASE_URL ??= execFileSync('node', [helper, 'create'], { encoding: 'utf8' });

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: `${reports}/pw-output`,
  reporter: [['junit', { outputFile: `${reports}/e2e-junit.xml` }]],
  globalSetup: resolve(__dirname, 'setup.ts'),
  globalTeardown: resolve(__dirname, 'teardown.ts'),
  projects: base
    .projects!.filter((p) => p.name?.startsWith('matrix-'))
    .map((p) => ({ ...p, testDir: '.' })),
  webServer: [base.webServer].flat().map((server) => ({
    ...server!,
    cwd: webDir,
    // Only the api server carries DATABASE_URL.
    env: server!.env?.DATABASE_URL
      ? { ...server!.env, DATABASE_URL: process.env.MATRIX_DATABASE_URL }
      : server!.env,
  })),
  use: { ...base.use, trace: 'retain-on-failure' },
});
