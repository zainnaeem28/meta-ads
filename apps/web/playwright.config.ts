import { defineConfig, devices } from '@playwright/test';
import { apiEnv } from '../../tools/foundation-tests/api-env.js';

const port = Number(process.env.WEB_PORT ?? 3100);
const apiPort = Number(process.env.E2E_API_PORT ?? 4100);
process.env.E2E_API_URL = `http://127.0.0.1:${apiPort}`;

// The built artifacts: `next start` for the web and the compiled api (pnpm build first).
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'reports/api-client/pw-output',
  reporter: [['junit', { outputFile: 'reports/api-client/e2e-junit.xml' }]],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: [
    {
      command: 'node ../api/dist/main.api.js',
      env: { ...apiEnv(apiPort), WEB_ORIGIN: `http://127.0.0.1:${port}` },
      url: `http://127.0.0.1:${apiPort}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
