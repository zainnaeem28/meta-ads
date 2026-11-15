import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: 'reports/config/junit.xml' }],
      ['junit', { outputFile: 'reports/logging/junit.xml' }],
    ],
    coverage: {
      provider: 'v8',
      include: ['src/platform/config/**/*.ts', 'src/platform/logging/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/platform/config/test-env.ts',
        'src/platform/config/index.ts',
        'src/platform/logging/index.ts',
        'src/platform/logging/test-support.ts',
      ],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/logging',
      thresholds: { lines: 95, branches: 90 },
    },
  },
});
