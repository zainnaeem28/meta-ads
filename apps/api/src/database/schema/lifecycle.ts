import { sql } from 'drizzle-orm';
import { check, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

// Lifecycle table of migration M0007 (ARCHITECTURE §2.2, §5.8). `deletion_runs` is history: it has no foreign key,
// because a run outlives the campaign or account it removes, and `subject_id` and `owner_id` are plain IDs. One run
// exists per subject (`deletion_runs_subject_uq`). Timestamps are read as text so their microseconds survive.

/** One row per campaign deletion or account erasure run (REQ-013, SB-D12, SB-D17). */
export const deletionRuns = pgTable(
  'deletion_runs',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    step: smallint('step').notNull().default(1),
    state: text('state').notNull().default('running'),
    attempts: smallint('attempts').notNull().default(0),
    remainingObjects: integer('remaining_objects'),
    lastErrorClass: varchar('last_error_class', { length: 64 }),
    notBefore: timestamp('not_before', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('deletion_runs_subject_uq').on(table.kind, table.subjectId),
    check('deletion_runs_kind_ck', sql`${table.kind} in ('campaign', 'account')`),
    check('deletion_runs_state_ck', sql`${table.state} in ('running', 'completed', 'stuck')`),
    check(
      'deletion_runs_step_ck',
      sql`(${table.kind} = 'campaign' and ${table.step} between 1 and 4) or (${table.kind} = 'account' and ${table.step} between 1 and 5)`,
    ),
    check('deletion_runs_attempts_ck', sql`${table.attempts} >= 0`),
    check('deletion_runs_remaining_ck', sql`${table.remainingObjects} is null or ${table.remainingObjects} >= 0`),
  ],
);
