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
 * real `provider_keys` row carrying key ciphertext, a pg-boss install with one queue (the `jobs:migrate` step in
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
        `INSERT INTO public.users (id, idp_subject, email, linked_via) VALUES ('00000000-0000-4000-8000-000000000001', 'user_backup_probe', 'backup-probe@example.test', 'first_admin')`,
      );
      await c.query(
        `INSERT INTO public.provider_keys (id, owner_id, provider, status, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
         VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'openai', 'active', '\\xdeadbeef', decode(repeat('01', 12), 'hex'), decode(repeat('ca', 384), 'hex'), 1, 'abcd', repeat('0', 64), 1)`,
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
