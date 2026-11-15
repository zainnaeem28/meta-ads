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
      ['junit', { outputFile: 'reports/db/junit.xml' }],
      ['junit', { outputFile: 'reports/egress/junit.xml' }],
      ['junit', { outputFile: 'reports/audit/junit.xml' }],
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/platform/config/**/*.ts',
        'src/platform/logging/**/*.ts',
        'src/platform/http/**/*.ts',
        'src/platform/egress/**/*.ts',
        'src/platform/shared-kernel/**/*.ts',
        'src/platform/db/**/*.ts',
        'src/modules/audit/**/*.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/platform/config/test-env.ts',
        'src/platform/config/index.ts',
        'src/platform/logging/index.ts',
        'src/platform/logging/test-support.ts',
        'src/platform/http/test-support.ts',
        'src/platform/http/index.ts',
        'src/platform/egress/index.ts',
        'src/platform/egress/test-support.ts',
        'src/platform/shared-kernel/index.ts',
        'src/platform/db/index.ts',
        'src/platform/db/schema.ts',
        'src/platform/db/test-database.ts',
        'src/database/**',
        // Wiring and the Drizzle repository are proven on real PostgreSQL by tests/integration/audit.
        'src/modules/audit/index.ts',
        'src/modules/audit/audit.module.ts',
        'src/modules/audit/infrastructure/audit.repository.ts',
        'src/modules/audit/application/ports.ts',
      ],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/http',
      thresholds: { lines: 95, branches: 90 },
    },
  },
});
