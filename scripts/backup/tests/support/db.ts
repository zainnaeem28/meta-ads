import {
  cleanup,
  drizzleMigrate,
  installQueues,
  provision,
  renderMigrations,
  teardown,
  tryQuery,
  withClient,
} from '../../../../apps/api/tests/integration/migrations/support/harness.ts';
import type { Env } from '../../../../apps/api/tests/integration/migrations/support/harness.ts';

export { tryQuery, withClient };
export type { Env };

export interface BackupDb {
  env: Env;
  /** `postgres://app_backup...` for the run's database. */
  backupUrl: string;
  dispose: () => Promise<void>;
}

/**
 * A unique database on the shared test PostgreSQL with the four roles created the way the host does, the real M0001
 * applied through `drizzle-kit migrate` as app_migrator (it issues the app_backup grants and default privileges), a
 * `provider_keys` stand-in table carrying key ciphertext, a pg-boss install with one queue (the `jobs:migrate` step in
 * miniature) and a few rows.
 */
export async function makeDb(): Promise<BackupDb> {
  const env = await provision();
  const dir = renderMigrations(env);
  try {
    const migrated = drizzleMigrate(env, dir);
    if (migrated.status !== 0)
      throw new Error(`migrate failed: ${migrated.stderr}${migrated.stdout}`);
    await installQueues(env, [
      { name: 'backup-probe', policy: 'standard', retryLimit: 0, expireInSeconds: 900 },
    ]);
    await withClient(env.urlFor('migrator'), async (c) => {
      await c.query(
        'CREATE TABLE public.provider_keys (id serial PRIMARY KEY, ciphertext bytea NOT NULL, nonce bytea NOT NULL, wrapped_dek bytea NOT NULL)',
      );
      await c.query(
        `INSERT INTO public.provider_keys (ciphertext, nonce, wrapped_dek) VALUES ('\\xdeadbeef', '\\x0102', '\\xcafe')`,
      );
      await c.query(
        `INSERT INTO public.rate_limit_buckets (scope, subject, window_start, count) VALUES ('probe', 'subject-1', now(), 3)`,
      );
    });
  } finally {
    cleanup(dir);
  }
  return {
    env,
    backupUrl: env.urlFor('backup'),
    dispose: async () => {
      const left = await teardown(env);
      if (left.length > 0)
        throw new Error(`leftovers on the shared test server: ${left.join(', ')}`);
    },
  };
}
