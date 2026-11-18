import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Report folder of the ticket whose check is running (its submit_check flags name it).
const reports = process.env.REPORT_DIR ?? 'reports/api-client';

export default defineConfig({
  resolve: {
    // `server-only` is aliased by Next.js at build time (no package is installed); under test it is an empty module.
    alias: { 'server-only': fileURLToPath(new URL('./src/lib/support/empty.ts', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/brand/**/*.test.ts', 'tests/security/**/*.test.ts'],
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
