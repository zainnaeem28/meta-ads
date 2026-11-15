import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    reporters: ['default', ['junit', { outputFile: 'reports/icons-gallery/junit.xml' }]],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/app/**/*.tsx'],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: 'reports/icons-gallery',
    },
  },
});
