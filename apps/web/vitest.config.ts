import { defineConfig } from 'vitest/config';

// Report folder of the ticket whose check is running (its submit_check flags name it).
const reports = process.env.REPORT_DIR ?? 'reports/api-client';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/lib/api/msw.setup.ts'],
    reporters: ['default', ['junit', { outputFile: `${reports}/junit.xml` }]],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/msw.setup.ts', 'src/app/**'],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: reports,
    },
  },
});
