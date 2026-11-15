import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    reporters: [
      'default',
      ['junit', { outputFile: '../../apps/web/reports/icons-gallery/ui-junit.xml' }],
    ],
  },
});
