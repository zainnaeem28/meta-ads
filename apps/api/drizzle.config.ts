import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate --name=<NNNN>_<ticket>-<slug>` (src/platform/db/generate.ts) renames the generated file to the exact name
// given; the number is the ticket's reserved range number and `meta/_journal.json` defines the order of application.
// The index prefix is kept because 'none' breaks drizzle-kit's snapshot diff. `db:migrate` runs under
// app_migrator (MIGRATION_DATABASE_URL). Schema push is forbidden (scripts/ci/lint-db.sh).
const url = process.env['MIGRATION_DATABASE_URL'];

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/platform/db/schema.ts',
    './src/database/schema/*.ts',
    './src/platform/*/schema.ts',
    './src/modules/*/infrastructure/schema.ts',
  ],
  out: './src/database/migrations',
  migrations: { prefix: 'index' },
  ...(url === undefined ? {} : { dbCredentials: { url } }),
  strict: true,
  verbose: true,
});
