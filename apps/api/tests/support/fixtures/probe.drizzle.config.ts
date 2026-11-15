import { defineConfig } from 'drizzle-kit';

// Same shape as apps/api/drizzle.config.ts, pointed at the fixture schema and a temporary output folder.
const url = process.env['MIGRATION_DATABASE_URL'];

export default defineConfig({
  dialect: 'postgresql',
  schema: './tests/support/fixtures/probe-schema.ts',
  out: process.env['PROBE_OUT'] ?? './tests/support/fixtures/out',
  migrations: { prefix: 'index' },
  ...(url === undefined ? {} : { dbCredentials: { url } }),
  strict: true,
});
