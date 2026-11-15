import { defineConfig } from 'vitest/config';

const reports = '../../apps/api/reports/contracts';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    reporters: ['default', ['junit', { outputFile: `${reports}/junit.xml` }]],
    coverage: {
      provider: 'v8',
      reportsDirectory: reports,
      reporter: ['lcovonly'],
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/index.ts'],
    },
  },
});
