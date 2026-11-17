import { defineConfig } from 'vitest/config';

// Tests that need the built web (`next start`); not part of the unit run.
export default defineConfig({ test: { include: ['tests/local-token/**/*.test.ts'] } });
