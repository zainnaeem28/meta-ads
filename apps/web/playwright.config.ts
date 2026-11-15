import { defineConfig, devices } from '@playwright/test';
import { apiEnv } from '../../tools/foundation-tests/api-env.js';
import { SCREENSHOT } from './tests/support/visual';

const port = Number(process.env.WEB_PORT ?? 3100);
const prodPort = Number(process.env.E2E_PROD_PORT ?? port + 1);
const apiPort = Number(process.env.E2E_API_PORT ?? 4100);
process.env.E2E_API_URL = `http://127.0.0.1:${apiPort}`;
process.env.E2E_PROD_URL = `http://127.0.0.1:${prodPort}`;

const reports = `reports/${process.env.REPORT_DIR ?? 'icons-gallery'}`;

const next = (p: number) => `pnpm exec next start --hostname 127.0.0.1 --port ${p}`;

// The built artifacts: `next start` for the web and the compiled api (pnpm build first).
// Tests tagged @harness run in every browser project; the rest (CDP, font internals) run in chromium only.
export default defineConfig({
  testDir: 'e2e',
  outputDir: `${reports}/pw-output`,
  reporter: [['junit', { outputFile: `${reports}/e2e-junit.xml` }]],
  // Linux CI is the baseline platform: one baseline per project, no platform suffix.
  snapshotPathTemplate: '{testDir}/__baselines__/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { ...SCREENSHOT } },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@harness/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@harness/ },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' }, grep: /@harness/ },
  ],
  webServer: [
    {
      command: 'node ../api/dist/main.api.js',
      env: apiEnv(apiPort),
      url: `http://127.0.0.1:${apiPort}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: next(port),
      env: { GALLERY_ENABLED: 'true', APP_ENV: 'test' },
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The same build run as a production deployment: the gallery must not exist there.
      command: next(prodPort),
      env: { GALLERY_ENABLED: 'true', APP_ENV: 'production' },
      url: `http://127.0.0.1:${prodPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
