import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../../reports/release/junit.xml' },
    globalSetup: ['test/coverage-setup.ts'],
  },
});
