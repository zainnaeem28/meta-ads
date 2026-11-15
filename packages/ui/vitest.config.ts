import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test'; // React's act() needs the development build

const reports = `../../apps/web/${process.env.REPORT_DIR ?? 'reports/icons-gallery'}`;

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    reporters: ['default', ['junit', { outputFile: `${reports}/ui-junit.xml` }]],
    coverage: {
      provider: 'v8',
      include: ['src/components/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/components/**/index.ts'],
      reporter: ['lcov', 'text-summary'],
      reportsDirectory: `${reports}/ui`,
      thresholds: { lines: 85, branches: 80 },
    },
  },
});
