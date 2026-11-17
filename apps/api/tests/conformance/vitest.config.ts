import { defineConfig } from 'vitest/config';

// TASK-065: the API conformance, authorization-matrix and zero-trust suites on the running app (QUALITY-RELEASE-PLAN §9).
// `pnpm --filter @shroomap/api test:conformance`. The report is a junit file the gate (scripts/ci/api-matrix.mjs) reads.
export default defineConfig({
  root: import.meta.dirname + '/../..',
  test: {
    include: ['tests/conformance/**/*.conformance.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    reporters: ['default', ['junit', { outputFile: 'reports/conformance/junit.xml' }]],
    coverage: {
      enabled: true,
      provider: 'v8',
      // Like the grants suite (TASK-025) and the security suite (TASK-116), the coverage measured is the suite's own harness:
      // the matrix generator and the scenario table. The product code it drives is covered by its owners' suites.
      include: ['tests/conformance/support/**/*.ts'],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/conformance',
    },
  },
});
