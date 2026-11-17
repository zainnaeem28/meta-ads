import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config';

// FLOW-10 (TASK-111) runs on the same built artifacts as every other e2e: the compiled api and `next start`
// (see apps/web/playwright.config.ts). Only the test folder and the report folder differ.
// Run from apps/web: `pnpm exec playwright test --config tests/e2e/flow-10/playwright.config.ts --project=chromium`.
// Absolute: Playwright resolves report paths against the config folder, not the working directory.
const webDir = resolve(__dirname, '../../..');
const reports = resolve(webDir, process.env.REPORT_DIR ?? 'reports/flow-10');

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: `${reports}/pw-output`,
  reporter: [['junit', { outputFile: `${reports}/e2e-junit.xml` }]],
  // The base servers are started from apps/web (their commands are relative to it).
  webServer: [base.webServer].flat().map((server) => ({ ...server!, cwd: webDir })),
  use: { ...base.use, trace: 'retain-on-failure' },
});
