import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
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

// Brief tables of migration M0009 (ARCHITECTURE §2.2, SB v6 §3.5, SB-D11). `claim_events` is history and `brand_rules`
// is seeded configuration: neither has a foreign key. `claim_issues.rule_id` points at `brand_rules.id` logically only,
// because the rules are reseeded. `owner_id` columns are plain: the owner is checked by the service, and a campaign's
// cascade removes every row below it. Timestamps are read as text so their microseconds survive.

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

/** Brief generation (campaign) and product image analysis (media) jobs, on the provider-job column contract (SB §3.5). */
export const briefJobs = pgTable(
  'brief_jobs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    kind: text('kind').notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id').references(() => mediaObjects.id, { onDelete: 'cascade' }),
    generationSeq: integer('generation_seq').notNull().default(0),
    resultText: varchar('result_text', { length: 1500 }),
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
    uniqueIndex('brief_jobs_reuse_uq')
      .on(table.ownerId, table.reuseHash)
      .where(sql`${table.state} not in ('failed', 'cancelled')`),
    index('brief_jobs_owner_state_idx').on(table.ownerId, table.state),
    index('brief_jobs_poll_idx')
      .on(table.nextPollAt)
      .where(sql`${table.state} in ('submitted', 'processing')`),
    index('brief_jobs_submitting_idx')
      .on(table.submittingAt)
      .where(sql`${table.state} = 'submitting'`),
    index('brief_jobs_copy_idx')
      .on(table.providerCompletedAt)
      .where(sql`${table.state} = 'processing' and ${table.providerCompletedAt} is not null`),
    index('brief_jobs_campaign_idx').on(table.campaignId),
    index('brief_jobs_media_idx').on(table.mediaId),
    check('brief_jobs_kind_ck', sql`${table.kind} in ('brief_generation', 'image_analysis')`),
    check(
      'brief_jobs_parent_ck',
      sql`(${table.kind} = 'brief_generation' and ${table.campaignId} is not null) or (${table.kind} = 'image_analysis' and ${table.mediaId} is not null)`,
    ),
    check('brief_jobs_state_ck', sql`${table.state} in (${list(JOB_STATES)})`),
    check(
      'brief_jobs_cause_ck',
      sql`${table.causeClass} is null or ${table.causeClass} in (${list(CAUSE_CLASSES)})`,
    ),
    check('brief_jobs_generation_seq_ck', sql`${table.generationSeq} >= 0`),
    check('brief_jobs_call_count_ck', sql`${table.callCount} >= 0`),
    check(
      'brief_jobs_completed_ck',
      sql`${table.providerCompletedAt} is null or ${table.providerTaskId} is not null`,
    ),
  ],
);

/** One brief per campaign (REQ-007). Its text lives in `brief_segments`, written in place (SB-D11). */
export const briefs = pgTable(
  'briefs',
  {
    id: uuid('id').primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull(),
    state: text('state').notNull().default('generating'),
    version: integer('version').notNull().default(1),
    generationSeq: integer('generation_seq').notNull().default(1),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('briefs_campaign_uq').on(table.campaignId),
    check('briefs_state_ck', sql`${table.state} in ('generating', 'draft', 'accepted', 'failed')`),
    check('briefs_version_ck', sql`${table.version} > 0`),
    check('briefs_generation_seq_ck', sql`${table.generationSeq} > 0`),
    check(
      'briefs_accepted_ck',
      sql`(${table.state} = 'accepted') = (${table.acceptedAt} is not null)`,
    ),
  ],
);

/** One to four stable rows per brief, updated in place; `revision` goes up on every change of text or state (SB-D11). */
export const briefSegments = pgTable(
  'brief_segments',
  {
    id: uuid('id').primaryKey(),
    briefId: uuid('brief_id')
      .notNull()
      .references(() => briefs.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    state: text('state').notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    dialogue: varchar('dialogue', { length: 600 }).notNull().default(''),
    prompt: varchar('prompt', { length: 2000 }).notNull().default(''),
    wordCount: smallint('word_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('brief_segments_position_uq').on(table.briefId, table.position),
    check('brief_segments_position_ck', sql`${table.position} between 1 and 4`),
    check('brief_segments_state_ck', sql`${table.state} in ('active', 'retired')`),
    check('brief_segments_revision_ck', sql`${table.revision} > 0`),
    check('brief_segments_word_count_ck', sql`${table.wordCount} between 0 and 120`),
  ],
);

/** A claim finding on one field of one segment (REQ-008). The high-risk class is never cleared by a reason. */
export const claimIssues = pgTable(
  'claim_issues',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    briefId: uuid('brief_id')
      .notNull()
      .references(() => briefs.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => briefSegments.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    ruleId: varchar('rule_id', { length: 64 }).notNull(),
    class: text('class').notNull(),
    resolution: text('resolution').notNull().default('open'),
    message: varchar('message', { length: 300 }).notNull(),
    spanStart: integer('span_start'),
    spanEnd: integer('span_end'),
    clearedBy: uuid('cleared_by'),
    clearReason: varchar('clear_reason', { length: 500 }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('claim_issues_open_idx')
      .on(table.briefId)
      .where(sql`${table.resolution} = 'open'`),
    index('claim_issues_segment_idx').on(table.segmentId),
    check('claim_issues_field_ck', sql`${table.field} in ('dialogue', 'prompt')`),
    check('claim_issues_class_ck', sql`${table.class} in ('high_risk', 'other')`),
    check(
      'claim_issues_resolution_ck',
      sql`${table.resolution} in ('open', 'closed_by_edit', 'cleared_with_reason')`,
    ),
    check(
      'claim_issues_clear_ck',
      sql`${table.resolution} <> 'cleared_with_reason' or (${table.class} = 'other' and ${table.clearReason} is not null)`,
    ),
    check(
      'claim_issues_span_ck',
      sql`(${table.spanStart} is null and ${table.spanEnd} is null) or (${table.spanStart} >= 0 and ${table.spanEnd} is not null and ${table.spanEnd} >= ${table.spanStart})`,
    ),
  ],
);

/** History of raised and resolved issues: IDs and classes only, no text (REQ-008, TC-REV-08). No foreign key. */
export const claimEvents = pgTable(
  'claim_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    briefId: uuid('brief_id').notNull(),
    issueId: uuid('issue_id').notNull(),
    class: text('class').notNull(),
    outcome: text('outcome').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('claim_events_at_idx').on(table.at),
    check('claim_events_class_ck', sql`${table.class} in ('high_risk', 'other')`),
    check(
      'claim_events_outcome_ck',
      sql`${table.outcome} in ('raised', 'closed_by_edit', 'cleared_with_reason')`,
    ),
  ],
);

/** The rule set, seeded from `config/brand-rules.json` (SB-D10). Changed only by a reviewed PR and a reseed. */
export const brandRules = pgTable(
  'brand_rules',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    class: text('class').notNull(),
    clearable: boolean('clearable').notNull(),
    kind: text('kind').notNull(),
    params: jsonb('params').notNull(),
    message: varchar('message', { length: 300 }).notNull(),
    rulesVersion: integer('rules_version').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (table) => [
    check('brand_rules_class_ck', sql`${table.class} in ('high_risk', 'other')`),
    check(
      'brand_rules_clearable_ck',
      sql`${table.class} <> 'high_risk' or ${table.clearable} = false`,
    ),
    check(
      'brand_rules_kind_ck',
      sql`${table.kind} in ('phrase', 'regex', 'word_count_min', 'word_count_max_target', 'cta_exact', 'em_dash', 'age_framing')`,
    ),
    check('brand_rules_version_ck', sql`${table.rulesVersion} > 0`),
  ],
);
