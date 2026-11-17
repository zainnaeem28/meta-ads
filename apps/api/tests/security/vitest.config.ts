import { defineConfig } from 'vitest/config';

// TASK-116: the security suite (SECURITY-DESIGN §10.9, §16.4). `pnpm --filter @shroomap/api test:security`.
export default defineConfig({
  root: import.meta.dirname + '/../..',
  test: {
    include: ['tests/security/**/*.security.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    reporters: ['default', ['junit', { outputFile: 'reports/security/junit.xml' }]],
    coverage: {
      enabled: true,
      provider: 'v8',
      // Like the grants suite of TASK-025, the coverage measured is the suite's own harness (the stack, the seeding and the
      // OpenAPI walker): the product code it drives is covered by its owners' unit and integration suites.
      include: ['tests/security/support/**/*.ts'],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/security',
    },
  },
});
