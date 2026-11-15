import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts', 'tests/integration/**/*.integration.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    reporters: [
      'default',
      ['junit', { outputFile: 'reports/integration/junit.xml' }],
      ['junit', { outputFile: 'reports/migrations/junit.xml' }],
    ],
    // TASK-025: coverage of the grants suite's own harness (the SQL migration has no line coverage of its own).
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['tests/integration/migrations/support/**/*.ts'],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/migrations',
    },
  },
});
