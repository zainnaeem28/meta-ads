import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Audit tables of migration M0002 (ARCHITECTURE §2.2, §7.4): no foreign keys, IDs only, never values, emails or content.
// `audit_events` is append-only: the runtime roles hold INSERT and SELECT, never UPDATE, DELETE or TRUNCATE.

/** One row per audited action (REQ-027). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    // Null for `system` and `operator` actors.
    actorId: uuid('actor_id'),
    actorType: text('actor_type').notNull(),
    // The catalogue of ARCHITECTURE §7.4 is checked in code: a CHECK would make every new action a migration.
    action: varchar('action', { length: 64 }).notNull(),
    objectType: varchar('object_type', { length: 32 }).notNull(),
    objectId: uuid('object_id'),
    outcome: text('outcome').notNull(),
    requestId: varchar('request_id', { length: 64 }),
  },
  (table) => [
    check(
      'audit_events_actor_type_ck',
      sql`${table.actorType} in ('user', 'admin', 'system', 'operator')`,
    ),
    check('audit_events_outcome_ck', sql`${table.outcome} in ('allowed', 'denied', 'failed')`),
    index('audit_events_at_idx').on(table.at),
    index('audit_events_actor_at_idx').on(table.actorId, table.at),
  ],
);

// The alert timestamps are read as text: they keep PostgreSQL's microseconds, which a list position must compare exactly.
/** In-app administrator alerts (ALR-5, ALR-8); one open alert per kind and subject. */
export const adminAlerts = pgTable(
  'admin_alerts',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    subjectUserId: uuid('subject_user_id'),
    // An object of integers only, at most ten keys (checked in code).
    counts: jsonb('counts')
      .notNull()
      .default(sql`'{}'::jsonb`),
    dedupeKey: varchar('dedupe_key', { length: 120 }),
    raisedAt: timestamp('raised_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'string' }),
    acknowledgedBy: uuid('acknowledged_by'),
  },
  (table) => [
    check(
      'admin_alerts_kind_ck',
      sql`${table.kind} in ('campaign_deletion_stuck', 'account_erasure_stuck', 'job_burst', 'provider_auth_spike', 'admin_role_changed', 'reservation_inconsistency', 'key_unseal_failed', 'keys_disabled_all')`,
    ),
    check('admin_alerts_counts_ck', sql`jsonb_typeof(${table.counts}) = 'object'`),
    uniqueIndex('admin_alerts_open_dedupe_uq')
      .on(table.dedupeKey)
      .where(sql`${table.acknowledgedAt} is null`),
    index('admin_alerts_queue_idx').on(
      sql`${table.acknowledgedAt} nulls first`,
      sql`${table.raisedAt} desc`,
      sql`${table.id} desc`,
    ),
  ],
);
