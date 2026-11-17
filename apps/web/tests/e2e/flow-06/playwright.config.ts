import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config';

// FLOW-06 (TASK-109) runs on the same built artifacts as every other e2e: the compiled api and `next start`
// (see apps/web/playwright.config.ts). Only the test folder and the report folder differ.
// Run from apps/web: `pnpm exec playwright test --config tests/e2e/flow-06/playwright.config.ts --project=chromium`.
// Absolute: Playwright resolves report paths against the config folder, not the working directory.
const webDir = resolve(__dirname, '../../..');
const reports = resolve(webDir, process.env.REPORT_DIR ?? 'reports/flow-06');

// One database per run, created by the first config load (workers inherit the variable) and dropped by global teardown.
process.env.FLOW06_DATABASE_URL ??= execFileSync('node', [resolve(__dirname, 'database.mjs'), 'create'], { encoding: 'utf8' });

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: `${reports}/pw-output`,
  reporter: [['junit', { outputFile: `${reports}/e2e-junit.xml` }]],
  // The base servers are started from apps/web (their commands are relative to it).
  globalTeardown: resolve(__dirname, 'teardown.ts'),
  webServer: [base.webServer].flat().map((server, i) => ({
    ...server!,
    cwd: webDir,
    // The api (first server) runs on this run's own database.
    ...(i === 0 ? { env: { ...server!.env, DATABASE_URL: process.env.FLOW06_DATABASE_URL! } } : {}),
  })),
  // The journeys capture each step twice with axe; a loaded shared host needs room.
  timeout: 120_000,
  expect: { ...base.expect, timeout: 15_000 },
  use: { ...base.use, trace: 'retain-on-failure' },
});
