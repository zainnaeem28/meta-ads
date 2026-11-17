import { sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { briefSegments } from './brief.js';
import { campaigns } from './campaigns.js';
import { mediaObjects } from './media.js';

// Production tables of migration M0010 (ARCHITECTURE §2.2, SB v6 §3.3 and §3.5, SB-D4, SB-D11, SB-D17). `segment_id` has no
// delete rule (NO ACTION, checked at statement end), so the database refuses a direct delete of a segment that has jobs
// while a campaign's cascade removes segments and jobs together. Output media references are SET NULL. `owner_id` is plain:
// the owner is checked by the service. Timestamps are read as text so their microseconds survive.

const JOB_STATES = [
  'pending',
  'submitting',
  'submitted',
  'processing',
  'completed',
  'failed',
  'cancelled',
];
const CAUSE_CLASSES = [
  'temporary',
  'configuration',
  'credit',
  'provider_timeout',
  'key_replaced',
  'key_deleted',
  'reference_unreachable',
  'output_unreachable',
  'outcome_unknown',
  'cancelled_campaign_deleted',
  'cancelled_account_suspended',
  'cancelled_account_removed',
];
const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));

/** One WaveSpeed clip per segment attempt, on the provider-job column contract (SB §3.5). Retry inserts a new row. */
export const videoJobs = pgTable(
  'video_jobs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => briefSegments.id),
    segmentRevision: integer('segment_revision').notNull(),
    referenceMediaId: uuid('reference_media_id').references(() => mediaObjects.id, {
      onDelete: 'set null',
    }),
    providerModel: varchar('provider_model', { length: 120 }).notNull(),
    options: jsonb('options').notNull(),
    outputMediaId: uuid('output_media_id').references(() => mediaObjects.id, {
      onDelete: 'set null',
    }),
    providerOutputDeletedAt: timestamp('provider_output_deleted_at', {
      withTimezone: true,
      mode: 'string',
    }),
    state: text('state').notNull().default('pending'),
    causeClass: text('cause_class'),
    causeMessage: varchar('cause_message', { length: 300 }),
    reuseHash: char('reuse_hash', { length: 64 }).notNull(),
    keyId: uuid('key_id'),
    keyVersion: integer('key_version'),
    callCount: smallint('call_count').notNull().default(0),
    submittingAt: timestamp('submitting_at', { withTimezone: true, mode: 'string' }),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true, mode: 'string' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'string' }).notNull(),
    providerCompletedAt: timestamp('provider_completed_at', { withTimezone: true, mode: 'string' }),
    providerTaskId: varchar('provider_task_id', { length: 128 }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('video_jobs_reuse_uq')
      .on(table.ownerId, table.reuseHash)
      .where(sql`${table.state} not in ('failed', 'cancelled')`),
    index('video_jobs_owner_state_idx').on(table.ownerId, table.state),
    index('video_jobs_campaign_segment_idx').on(
      table.campaignId,
      table.segmentId,
      sql`${table.createdAt} desc`,
    ),
    index('video_jobs_segment_idx').on(table.segmentId),
    index('video_jobs_poll_idx')
      .on(table.nextPollAt)
      .where(sql`${table.state} in ('submitted', 'processing')`),
    index('video_jobs_submitting_idx')
      .on(table.submittingAt)
      .where(sql`${table.state} = 'submitting'`),
    index('video_jobs_copy_idx')
      .on(table.providerCompletedAt)
      .where(sql`${table.state} = 'processing' and ${table.providerCompletedAt} is not null`),
    check('video_jobs_state_ck', sql`${table.state} in (${list(JOB_STATES)})`),
    check(
      'video_jobs_cause_ck',
      sql`${table.causeClass} is null or ${table.causeClass} in (${list(CAUSE_CLASSES)})`,
    ),
    check('video_jobs_segment_revision_ck', sql`${table.segmentRevision} > 0`),
    check('video_jobs_call_count_ck', sql`${table.callCount} >= 0`),
    check(
      'video_jobs_options_ck',
      sql`jsonb_typeof(${table.options}) = 'object' and ${table.options} - 'durationSeconds' - 'resolution' - 'aspectRatio' = '{}'::jsonb`,
    ),
    check(
      'video_jobs_completed_ck',
      sql`${table.providerCompletedAt} is null or ${table.providerTaskId} is not null`,
    ),
  ],
);

/** One audio quality check of a completed clip (REQ-010); a re-run inserts a new row and keeps the old one. */
export const qcRuns = pgTable(
  'qc_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    videoJobId: uuid('video_job_id')
      .notNull()
      .references(() => videoJobs.id, { onDelete: 'cascade' }),
    qcState: text('qc_state').notNull().default('pending'),
    reason: varchar('reason', { length: 300 }),
    wordErrorRate: numeric('word_error_rate', { precision: 4, scale: 3 }),
    state: text('state').notNull().default('pending'),
    causeClass: text('cause_class'),
    causeMessage: varchar('cause_message', { length: 300 }),
    reuseHash: char('reuse_hash', { length: 64 }).notNull(),
    keyId: uuid('key_id'),
    keyVersion: integer('key_version'),
    callCount: smallint('call_count').notNull().default(0),
    submittingAt: timestamp('submitting_at', { withTimezone: true, mode: 'string' }),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true, mode: 'string' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'string' }).notNull(),
    providerCompletedAt: timestamp('provider_completed_at', { withTimezone: true, mode: 'string' }),
    providerTaskId: varchar('provider_task_id', { length: 128 }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('qc_runs_reuse_uq')
      .on(table.ownerId, table.reuseHash)
      .where(sql`${table.state} not in ('failed', 'cancelled')`),
    index('qc_runs_job_created_idx').on(table.videoJobId, sql`${table.createdAt} desc`),
    index('qc_runs_owner_state_idx').on(table.ownerId, table.state),
    check('qc_runs_state_ck', sql`${table.state} in (${list(JOB_STATES)})`),
    check(
      'qc_runs_cause_ck',
      sql`${table.causeClass} is null or ${table.causeClass} in (${list(CAUSE_CLASSES)})`,
    ),
    check(
      'qc_runs_qc_state_ck',
      sql`${table.qcState} in ('pending', 'passed', 'failed', 'skipped')`,
    ),
    check(
      'qc_runs_wer_ck',
      sql`${table.wordErrorRate} is null or ${table.wordErrorRate} between 0 and 1`,
    ),
    check('qc_runs_call_count_ck', sql`${table.callCount} >= 0`),
  ],
);
