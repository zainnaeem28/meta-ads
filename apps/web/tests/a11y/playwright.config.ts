import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

// TASK-118 runs on the same built artifacts as every other e2e: the compiled api and `next start`
// (see apps/web/playwright.config.ts). Only the test folder, the baselines and the report folder differ.
// Run from apps/web: `pnpm exec playwright test --config tests/a11y/playwright.config.ts --grep @a11y --project=chromium`.
const webDir = resolve(__dirname, '../..');
const reports = resolve(webDir, process.env.REPORT_DIR ?? 'reports/a11y');

// The api refuses to start without the pg-boss schema, so the run uses a throwaway database prepared by the
// FLOW-11 helper (one per run, created by the first config load, dropped by global teardown).
const helper = resolve(webDir, 'tests/e2e/flow-11/database.mjs');
process.env.A11Y_DATABASE_URL ??= execFileSync('node', [helper, 'create'], { encoding: 'utf8' });

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: `${reports}/pw-output`,
  reporter: [['junit', { outputFile: `${reports}/e2e-junit.xml` }]],
  globalTeardown: resolve(__dirname, 'teardown.ts'),
  webServer: [base.webServer].flat().map((server) => ({
    ...server!,
    cwd: webDir,
    // Only the api server carries DATABASE_URL.
    env: server!.env?.DATABASE_URL
      ? { ...server!.env, DATABASE_URL: process.env.A11Y_DATABASE_URL }
      : server!.env,
  })),
  use: { ...base.use, trace: 'retain-on-failure' },
});
