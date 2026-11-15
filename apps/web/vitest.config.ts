import { defineConfig } from 'vitest/config';

const reports = `reports/${process.env.REPORT_DIR ?? 'icons-gallery'}`;

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    reporters: ['default', ['junit', { outputFile: `${reports}/junit.xml` }]],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/app/**/*.tsx'],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: reports,
    },
  },
});
