import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from '../../../apps/web/playwright.config';

// Same built api + `next start` web servers as the web e2e suite; only the test folder differs.
export default defineConfig({
  ...base,
  testDir: '.',
  webServer: (base.webServer as object[]).map((server) => ({ ...server, cwd: resolve(__dirname, '../../../apps/web') })) as never,
  outputDir: '../../../apps/web/reports/frames-addendum/pw-output',
  reporter: [['junit', { outputFile: '../../../apps/web/reports/frames-addendum/e2e-junit.xml' }]],
});
