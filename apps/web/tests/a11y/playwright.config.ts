import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

// TASK-118 runs on the same built artifacts as every other e2e: the compiled api and `next start`
// (see apps/web/playwright.config.ts). Only the test folder, the baselines and the report folder differ.
// Run from apps/web: `pnpm exec playwright test --config tests/a11y/playwright.config.ts --grep @a11y --project=chromium`.
const webDir = resolve(__dirname, '../..');
const reports = resolve(webDir, process.env.REPORT_DIR ?? 'reports/a11y');

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: `${reports}/pw-output`,
  reporter: [['junit', { outputFile: `${reports}/e2e-junit.xml` }]],
  webServer: [base.webServer].flat().map((server) => ({ ...server!, cwd: webDir })),
  use: { ...base.use, trace: 'retain-on-failure' },
});
