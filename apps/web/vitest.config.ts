import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/lib/api/msw.setup.ts'],
    reporters: ['default', ['junit', { outputFile: 'reports/api-client/junit.xml' }]],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/msw.setup.ts', 'src/app/**'],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: 'reports/api-client',
    },
  },
});
