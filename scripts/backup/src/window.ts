import pg from 'pg';

/**
 * The release migration announces itself with the session advisory lock `release-migration` (taken the way
 * `lockXact` names its locks: `hashtextextended(name, 0)`). As a second signal, any other session holding a lock that
 * conflicts with `pg_dump`'s ACCESS SHARE lock on a table of `public` or `pgboss` (Share, Share Row Exclusive,
 * Exclusive, Access Exclusive) means a DDL statement is running. Both are readable by `app_backup` (`pg_locks` is public).
 */
export const RELEASE_MIGRATION_LOCK = 'release-migration';

const QUERY = `
  SELECT
    (SELECT count(*) FROM pg_locks l
      WHERE l.locktype = 'advisory' AND l.granted
        AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0))::int AS advisory,
    (SELECT count(DISTINCT l.pid) FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_backend_pid()
        AND n.nspname IN ('public', 'pgboss')
        AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'))::int AS ddl`;

export async function releaseMigrationRunning(client: pg.Client): Promise<boolean> {
  const r = await client.query<{ advisory: number; ddl: number }>(QUERY, [RELEASE_MIGRATION_LOCK]);
  const row = r.rows[0];
  return row !== undefined && (row.advisory > 0 || row.ddl > 0);
}

export interface WindowOptions {
  waitMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (waitedMs: number) => void;
}

/** True once no release migration runs; false when `waitMs` passed with one still running. */
export async function waitForMigrationWindow(
  databaseUrl: string,
  options: WindowOptions,
): Promise<{ clear: boolean; waitedMs: number }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (;;) {
      if (!(await releaseMigrationRunning(client)))
        return { clear: true, waitedMs: now() - started };
      const waited = now() - started;
      if (waited >= options.waitMs) return { clear: false, waitedMs: waited };
      options.onWait?.(waited);
      await sleep(options.pollMs);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
