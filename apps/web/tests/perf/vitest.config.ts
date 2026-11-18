import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// TASK-119 unit checks: the budget script and the cache rules. Run from apps/web:
//   pnpm exec vitest run --config tests/perf/vitest.config.ts --coverage
const reports = process.env.REPORT_DIR ?? 'reports/perf';

export default defineConfig({
  resolve: {
    // `server-only` is aliased by Next.js at build time (no package is installed); under test it is an empty module.
    alias: {
      'server-only': fileURLToPath(new URL('../../src/lib/support/empty.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/perf/**/*.test.ts'],
    reporters: ['default', ['junit', { outputFile: `${reports}/junit.xml` }]],
    coverage: {
      provider: 'v8',
      include: [
        'tests/perf/bundle-budgets.mjs',
        'perf.config.ts',
        'src/lib/query/server-prefetch.ts',
        'src/lib/auth/server-token.ts',
        'src/lib/api/client.ts',
      ],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: reports,
    },
  },
});
