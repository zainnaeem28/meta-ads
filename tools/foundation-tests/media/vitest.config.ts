import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    reporters: [
      'default',
      [
        'junit',
        {
          outputFile: join(
            import.meta.dirname,
            '..',
            '..',
            '..',
            'reports',
            'foundation',
            'slices-b-junit.xml',
          ),
        },
      ],
    ],
  },
});
