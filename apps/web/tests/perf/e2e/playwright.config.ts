import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// TASK-119 on the built artifacts: the baseline stack (the built api and `next start` of the built web in local mode, 25
// accounts with campaigns, briefs and stub jobs on a throwaway database), never the dev server. The stack is the one
// `scripts/ci/lighthouse.sh --budgets` measures, so first-data behaviour is proven on the same artifact.
// Run from apps/web: CI=1 pnpm exec playwright test --config tests/perf/e2e/playwright.config.ts --grep @fe-perf-budgets
const web = resolve(__dirname, '../../..');
const root = resolve(web, '../..');
const reports = process.env.REPORT_DIR ?? 'reports/perf';
const stateDir = resolve(web, reports, 'stack-state');
const stateFile = resolve(stateDir, 'state.json');
// Brought up by the first config load (main process); the workers inherit the variable and read the same state.
if (!process.env.PERF_STACK_STATE) {
  execFileSync('node', [resolve(root, 'tests/baselines/stack.mjs'), 'up', '--state', stateDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.env.PERF_STACK_STATE = stateFile;
}
const stack = JSON.parse(readFileSync(process.env.PERF_STACK_STATE!, 'utf8')) as {
  webUrl: string;
  apiUrl: string;
};
process.env.E2E_API_URL = stack.apiUrl;

export default defineConfig({
  testDir: '.',
  outputDir: `${web}/${reports}/pw-output`,
  globalTeardown: resolve(__dirname, 'teardown.ts'),
  reporter: [['junit', { outputFile: `${web}/${reports}/e2e-junit.xml` }]],
  // One browser context at a time: the tests switch identities and read counts of requests.
  workers: 1,
  // Cold loads of several routes in one test run on a shared host; the default 30 s is too tight.
  timeout: 90_000,
  use: {
    baseURL: stack.webUrl,
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
