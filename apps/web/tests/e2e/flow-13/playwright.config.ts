import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { apiEnv } from '../../../../../tools/foundation-tests/api-env.js';

// FLOW-13 on the built artifacts: the compiled api and `next start` (run `pnpm build` first), never the dev server.
const web = resolve(__dirname, '../../..');
const port = Number(process.env.WEB_PORT ?? 3300);
const apiPort = Number(process.env.E2E_API_PORT ?? 4300);
const reports = process.env.REPORT_DIR ?? 'reports/flow-13';
process.env.E2E_API_URL = `http://127.0.0.1:${apiPort}`;
// One database per run, created by the first config load (workers inherit the variable) and dropped by global teardown.
process.env.FLOW13_DATABASE_URL ??= execFileSync(
  'node',
  [resolve(__dirname, 'database.mjs'), 'create'],
  { encoding: 'utf8' },
);

export default defineConfig({
  testDir: '.',
  outputDir: `${web}/${reports}/pw-output`,
  globalTeardown: resolve(__dirname, 'teardown.ts'),
  reporter: [['junit', { outputFile: `${web}/${reports}/e2e-junit.xml` }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node ../api/dist/main.api.js',
      cwd: web,
      env: {
        ...apiEnv(apiPort),
        WEB_ORIGIN: `http://127.0.0.1:${port}`,
        DATABASE_URL: process.env.FLOW13_DATABASE_URL,
      },
      url: `http://127.0.0.1:${apiPort}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
      cwd: web,
      env: {
        APP_ENV: 'test',
        WEB_ORIGIN: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_API_ORIGIN: process.env.E2E_API_URL,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
      },
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
