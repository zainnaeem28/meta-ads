import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// FLOW-01 (TC-FLW-01): the built web app (`next build` then `next start`, never the dev server) against the built api and
// worker (see stack.ts), on the shared test PostgreSQL and a real MinIO. Run from apps/web:
//   pnpm exec playwright test --config tests/e2e/flow-01/playwright.config.ts --project=chromium
const web = Number(process.env.WEB_PORT ?? 3104);
const api = Number(process.env.E2E_API_PORT ?? 4104);
const reports = process.env.REPORT_DIR ?? 'reports/flow-01';
const webRoot = resolve(__dirname, '..', '..', '..');

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  outputDir: resolve(webRoot, reports, 'pw-output'),
  globalSetup: './global-setup.ts',
  // One worker: the stack is one database and one provider stub.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['junit', { outputFile: resolve(webRoot, reports, 'e2e-junit.xml') }], ['list']],
  use: {
    baseURL: `http://127.0.0.1:${web}`,
    trace: 'retain-on-failure',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: webRoot,
    command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${web}`,
    env: {
      APP_ENV: 'test',
      WEB_ORIGIN: `http://127.0.0.1:${web}`,
      NEXT_PUBLIC_API_ORIGIN: `http://127.0.0.1:${api}`,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
    },
    url: `http://127.0.0.1:${web}/site.webmanifest`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
