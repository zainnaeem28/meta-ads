import {
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Platform tables of migration M0001 (ARCHITECTURE §2.2): no foreign keys, IDs only, no personal data.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** Fixed-window rate limit counters (platform/rate-limit). Rows older than one day are deleted hourly. */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    scope: varchar('scope', { length: 48 }).notNull(),
    // A user ID, or the HMAC of a client IP for unauthenticated scopes.
    subject: varchar('subject', { length: 64 }).notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.subject, table.windowStart] })],
);

/** Idempotent job creation records (platform/idempotency, SB-D7, SB-D14). Expire after 24 hours. */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    ownerId: uuid('owner_id').notNull(),
    operationId: varchar('operation_id', { length: 16 }).notNull(),
    key: varchar('key', { length: 128 }).notNull(),
    // SHA-256 of method, path and canonical JSON body.
    requestHash: bytea('request_hash').notNull(),
    resourceType: varchar('resource_type', { length: 32 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    responseStatus: smallint('response_status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.operationId, table.key] }),
    check('idempotency_records_hash_len_ck', sql`octet_length(${table.requestHash}) = 32`),
    index('idempotency_records_expiry_idx').on(table.expiresAt),
  ],
);
