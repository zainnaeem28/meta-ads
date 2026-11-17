import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { apiEnv } from '../../../../../tools/foundation-tests/api-env.js';

// FLOW-03 on the built artifacts: the compiled api and `next start` (run `pnpm build` first), never the dev server.
// Behind them: the shared test PostgreSQL (one database per run), the worker run in-process, the provider stub, an S3
// stand-in and real FFmpeg (harness.mjs; docs/evidence/TASK-106/README.md says what is and is not exercised).
const web = resolve(__dirname, '../../..');
const port = Number(process.env.WEB_PORT ?? 3303);
const apiPort = Number(process.env.E2E_API_PORT ?? 4303);
const controlPort = Number(process.env.FLOW03_CONTROL_PORT ?? 4903);
const bucketPort = Number(process.env.FLOW03_BUCKET_PORT ?? 9303);
const reports = process.env.REPORT_DIR ?? 'reports/flow-03';
process.env.E2E_API_URL = `http://127.0.0.1:${apiPort}`;
process.env.E2E_STORAGE_URL = `http://127.0.0.1:${bucketPort}`;
process.env.FLOW03_CONTROL_URL = `http://127.0.0.1:${controlPort}`;
process.env.FFMPEG_PATH ??= 'ffmpeg';
process.env.FFPROBE_PATH ??= 'ffprobe';
// One database per run, created by the first config load (workers inherit the variable) and dropped by global teardown.
process.env.FLOW03_DATABASE_URL ??= execFileSync(
  'node',
  [resolve(__dirname, 'database.mjs'), 'create'],
  { encoding: 'utf8' },
);

export default defineConfig({
  testDir: '.',
  outputDir: `${web}/${reports}/pw-output`,
  globalTeardown: resolve(__dirname, 'teardown.ts'),
  reporter: [['junit', { outputFile: `${web}/${reports}/e2e-junit.xml` }]],
  // Real jobs, real polling: a clip takes a few seconds, the whole journey a minute or two.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node tests/e2e/flow-03/harness.mjs',
      cwd: web,
      env: {
        FLOW03_DATABASE_URL: process.env.FLOW03_DATABASE_URL,
        FLOW03_CONTROL_PORT: String(controlPort),
        FLOW03_BUCKET_PORT: String(bucketPort),
        FFMPEG_PATH: process.env.FFMPEG_PATH,
        FFPROBE_PATH: process.env.FFPROBE_PATH,
        PATH: process.env.PATH ?? '',
      },
      url: `http://127.0.0.1:${controlPort}/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node ../api/dist/main.api.js',
      cwd: web,
      env: {
        ...apiEnv(apiPort),
        WEB_ORIGIN: `http://127.0.0.1:${port}`,
        DATABASE_URL: process.env.FLOW03_DATABASE_URL,
        // Signed media links point at the S3 stand-in.
        R2_ENDPOINT: process.env.E2E_STORAGE_URL,
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
        // The media-src of the page's CSP allows the storage origin only; signed media links point at it.
        R2_ENDPOINT: process.env.E2E_STORAGE_URL,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
      },
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
