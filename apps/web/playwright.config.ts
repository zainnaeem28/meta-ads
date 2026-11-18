import { defineConfig, devices } from '@playwright/test';
import { apiEnv } from '../../tools/foundation-tests/api-env.js';
import { SCREENSHOT } from './tests/support/visual';

const port = Number(process.env.WEB_PORT ?? 3100);
const prodPort = Number(process.env.E2E_PROD_PORT ?? port + 1);
const apiPort = Number(process.env.E2E_API_PORT ?? 4100);
process.env.E2E_API_URL = `http://127.0.0.1:${apiPort}`;
process.env.E2E_PROD_URL = `http://127.0.0.1:${prodPort}`;

// Report folder of the ticket whose check is running (its submit_check flags name it).
const reports = process.env.REPORT_DIR ?? 'reports/api-client';

/** One project per row of TC-NFR-06 (desktop at the design's 1440 px width; the phones keep their device profile). */
export const MATRIX_PROJECTS = [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  },
  {
    name: 'edge',
    use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1440, height: 900 } },
  },
  {
    name: 'firefox',
    use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } },
  },
  { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  { name: 'ios-safari', use: { ...devices['iPhone 15'] } },
  { name: 'android-chrome', use: { ...devices['Pixel 7'] } },
];

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
    // Home-screen device profiles (TASK-068): iOS Safari and Android Chrome emulation.
    { name: 'ios-safari', use: { ...devices['iPhone 15'] }, grep: /@brand-device/ },
    { name: 'android-chrome', use: { ...devices['Pixel 7'] }, grep: /@brand-device/ },
    // Browser and device matrix (TASK-117): the @matrix suite in tests/matrix runs on every engine and both phone profiles.
    // The names carry the `matrix-` prefix so each project has its own baselines; the Edge project uses the installed Edge channel.
    ...MATRIX_PROJECTS.map(({ name, use }) => ({
      name: `matrix-${name}`,
      testDir: 'tests/matrix',
      grep: /@matrix/,
      use,
    })),
  ],
  webServer: [
    {
      command: 'node ../api/dist/main.api.js',
      // E2E_DATABASE_URL points the api at the shared test database server when localhost has none.
      env: {
        ...apiEnv(apiPort),
        WEB_ORIGIN: `http://127.0.0.1:${port}`,
        ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL } : {}),
      },
      url: `http://127.0.0.1:${apiPort}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The e2e build bakes in the api origin (read by the root provider) and enables the test-only probe page.
      command: `pnpm exec next build && ${next(port)}`,
      env: {
        GALLERY_ENABLED: 'true',
        APP_ENV: 'test',
        WEB_ORIGIN: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_API_ORIGIN: process.env.E2E_API_URL,
        NEXT_PUBLIC_E2E_PROBE: '1',
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
      },
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      // The same build run as a production deployment: the gallery must not exist there.
      // Waits for the first server, whose command builds the shared .next artifact.
      command: `until curl -sf http://127.0.0.1:${port} >/dev/null; do sleep 1; done; ${next(prodPort)}`,
      env: { GALLERY_ENABLED: 'true', APP_ENV: 'production' },
      // A static file: a hosted deployment signs requests in through the identity provider, which has no keys here.
      url: `http://127.0.0.1:${prodPort}/site.webmanifest`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
