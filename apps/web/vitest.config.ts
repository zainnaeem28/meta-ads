import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    reporters: ['default', ['junit', { outputFile: 'reports/design-import/junit.xml' }]],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: 'reports/design-import',
    },
  },
});
