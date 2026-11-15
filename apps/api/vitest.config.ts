import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: 'reports/config/junit.xml' }],
      ['junit', { outputFile: 'reports/logging/junit.xml' }],
      ['junit', { outputFile: 'reports/http/junit.xml' }],
    ],
    coverage: {
      provider: 'v8',
      include: ['src/platform/config/**/*.ts', 'src/platform/logging/**/*.ts',
        'src/platform/http/**/*.ts',
        'src/platform/shared-kernel/**/*.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/platform/config/test-env.ts',
        'src/platform/config/index.ts',
        'src/platform/logging/index.ts',
        'src/platform/logging/test-support.ts',
        'src/platform/http/test-support.ts',
        'src/platform/http/index.ts',
        'src/platform/shared-kernel/index.ts',
      ],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/http',
      thresholds: { lines: 95, branches: 90 },
    },
  },
});
