import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const PLATFORM_CLEANUP_JOB = 'platform.cleanup';
export const BUCKET_RETENTION_DAYS = 1;

export interface CleanupResult {
  readonly idempotencyRecords: number;
  readonly rateLimitBuckets: number;
}

/**
 * Body of the hourly `platform.cleanup` job: idempotency records past expiry and rate-limit buckets whose window
 * started more than a day ago. Nothing else is touched.
 */
export async function runPlatformCleanup(db: Pick<NodePgDatabase, 'execute'>): Promise<CleanupResult> {
  const records = await db.execute(sql`delete from idempotency_records where expires_at <= now()`);
  const buckets = await db.execute(
    sql`delete from rate_limit_buckets where window_start < now() - make_interval(days => ${BUCKET_RETENTION_DAYS})`,
  );
  return { idempotencyRecords: records.rowCount ?? 0, rateLimitBuckets: buckets.rowCount ?? 0 };
}
