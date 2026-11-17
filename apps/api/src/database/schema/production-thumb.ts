import { sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { mediaObjects } from './media.js';

// Production table of migration M0012 (ARCHITECTURE §2.2, §5.5, SB v6 §3.3 and §3.5, SB-D4, SB-D17): the thumbstopper callout
// image, one OpenAI image call per job, on the provider-job column contract. `owner_id` is plain: the owner is checked by the
// service. The output media reference is SET NULL, like every output reference (SB-D17). Timestamps are read as text so
// their microseconds survive.

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

/** One thumbstopper image attempt of a campaign. A matching one that is not `failed` or `cancelled` is reused. */
export const thumbstopperJobs = pgTable(
  'thumbstopper_jobs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    calloutText: varchar('callout_text', { length: 80 }).notNull(),
    providerModel: varchar('provider_model', { length: 120 }).notNull(),
    outputMediaId: uuid('output_media_id').references(() => mediaObjects.id, {
      onDelete: 'set null',
    }),
    state: text('state').notNull().default('pending'),
    causeClass: text('cause_class'),
    causeMessage: varchar('cause_message', { length: 300 }),
    reuseHash: char('reuse_hash', { length: 64 }).notNull(),
    keyId: uuid('key_id'),
    keyVersion: integer('key_version'),
    callCount: smallint('call_count').notNull().default(0),
    submittingAt: timestamp('submitting_at', { withTimezone: true, mode: 'string' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'string' }).notNull(),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('thumbstopper_jobs_reuse_uq')
      .on(table.ownerId, table.reuseHash)
      .where(sql`${table.state} not in ('failed', 'cancelled')`),
    index('thumbstopper_jobs_campaign_created_idx').on(
      table.campaignId,
      sql`${table.createdAt} desc`,
    ),
    index('thumbstopper_jobs_owner_state_idx').on(table.ownerId, table.state),
    index('thumbstopper_jobs_submitting_idx')
      .on(table.submittingAt)
      .where(sql`${table.state} = 'submitting'`),
    check('thumbstopper_jobs_state_ck', sql`${table.state} in (${list(JOB_STATES)})`),
    check(
      'thumbstopper_jobs_cause_ck',
      sql`${table.causeClass} is null or ${table.causeClass} in (${list(CAUSE_CLASSES)})`,
    ),
    check('thumbstopper_jobs_call_count_ck', sql`${table.callCount} >= 0`),
    check('thumbstopper_jobs_callout_ck', sql`char_length(${table.calloutText}) between 1 and 80`),
  ],
);
