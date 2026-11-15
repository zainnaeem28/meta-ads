import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/foundation-tests/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    reporters: ['default', ['junit', { outputFile: 'reports/foundation/junit.xml' }]],
  },
});
