import { defineConfig, devices } from '@playwright/test';
import { SCREENSHOT } from './tests/support/visual';

// Screenshot capture of the built web app (AIU-29): the same web server as playwright.config.ts, no api process.
// The fe-screen specs mock the browser's API calls (page.route), so the data is fixture data.
const port = Number(process.env.WEB_PORT ?? 3100);
process.env.E2E_API_URL = 'http://127.0.0.1:4100';
process.env.E2E_PROD_URL = `http://127.0.0.1:${port + 1}`;
const reports = process.env.REPORT_DIR ?? '/tmp/aiu29-report';

export default defineConfig({
  testDir: 'e2e',
  outputDir: `${reports}/pw-output`,
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__baselines__/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { ...SCREENSHOT } },
  use: { baseURL: `http://127.0.0.1:${port}`, contextOptions: { reducedMotion: 'reduce' } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
      env: {
        GALLERY_ENABLED: 'true',
        APP_ENV: 'test',
        WEB_ORIGIN: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_API_ORIGIN: 'http://127.0.0.1:4100',
        NEXT_PUBLIC_E2E_PROBE: '1',
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
      },
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
