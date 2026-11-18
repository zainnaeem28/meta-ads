import { defineConfig } from 'vitest/config';

// TASK-119 unit checks: the budget script and the cache rules. Run from apps/web:
//   pnpm exec vitest run --config tests/perf/vitest.config.ts --coverage
const reports = process.env.REPORT_DIR ?? 'reports/perf';

export default defineConfig({
  test: {
    include: ['tests/perf/**/*.test.ts'],
    reporters: ['default', ['junit', { outputFile: `${reports}/junit.xml` }]],
    coverage: {
      provider: 'v8',
      include: ['tests/perf/bundle-budgets.mjs', 'perf.config.ts'],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: reports,
    },
  },
});
