import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const reports = join(import.meta.dirname, '..', '..', 'reports', 'monitor');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    reporters: ['default', ['junit', { outputFile: join(reports, 'junit.xml') }]],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: reports,
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/health-contract.ts'],
    },
  },
});
