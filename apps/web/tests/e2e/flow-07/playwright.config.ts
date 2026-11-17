import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config';

// FLOW-07 (TASK-110) runs on the same built artifacts as every other e2e: the compiled api and `next start`
// (see apps/web/playwright.config.ts). Only the test folder and the report folder differ.
// Run from apps/web: `pnpm exec playwright test --config tests/e2e/flow-07/playwright.config.ts --project=chromium`.
// Absolute: Playwright resolves report paths against the config folder, not the working directory.
const webDir = resolve(__dirname, '../../..');
const reports = resolve(webDir, process.env.REPORT_DIR ?? 'reports/flow-07');

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: `${reports}/pw-output`,
  reporter: [['junit', { outputFile: `${reports}/e2e-junit.xml` }]],
  // The base servers are started from apps/web (their commands are relative to it).
  // The last server waits for the first one's build, so every server gets the build's time.
  webServer: [base.webServer].flat().map((server) => ({ ...server!, cwd: webDir, timeout: 360_000 })),
  expect: { ...base.expect, timeout: 15_000 },
  use: { ...base.use, trace: 'retain-on-failure' },
});
