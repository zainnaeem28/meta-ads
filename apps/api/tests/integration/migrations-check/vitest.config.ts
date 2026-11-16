import { defineConfig } from 'vitest/config';

// `pnpm db:check-history` (scripts/ci/db-check-history.sh): the migration check harness on the shared test PostgreSQL.
// Run from apps/api. The JUnit file is what the gate reads; coverage measures the harness code itself.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/integration/migrations-check/**/*.migcheck.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    reporters: ['default', ['junit', { outputFile: 'reports/migcheck/junit.xml' }]],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['tests/integration/migrations-check/support/**/*.ts'],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/migcheck',
    },
  },
});
