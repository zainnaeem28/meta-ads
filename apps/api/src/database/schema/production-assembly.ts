import { sql } from 'drizzle-orm';
import { boolean, char, check, date, index, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { mediaObjects } from './media.js';
import { thumbstopperJobs } from './production-thumb.js';
import { videoJobs } from './production.js';

// Production tables of migration M0011 (ARCHITECTURE §2.2, §5.7, SB-D11): the assembly of up to four completed clips into
// the final video, and the clips it was made from. `owner_id` is plain: the owner is checked by the service. The clips'
// `video_job_id` has no delete rule (NO ACTION, checked at statement end), so a clip that a final was made from cannot be
// deleted on its own while a campaign's cascade removes assemblies and jobs together. `thumbstopper_job_id` is a plain
// column in M0011; M0012 (`thumbstopper_jobs`) adds its foreign key (SET NULL). Timestamps are read as text.

const STATES = ['pending', 'queued', 'fetching', 'rendering', 'saving', 'done', 'failed'];
const CAUSE_CLASSES = [
  'render_failed',
  'input_unavailable',
  'timeout',
  'cancelled_campaign_deleted',
  'cancelled_account_suspended',
  'cancelled_account_removed',
];
const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));

/** One render of the final video; a matching one that is not `failed` is reused, a new row counts toward the day's limit. */
export const assemblyJobs = pgTable(
  'assembly_jobs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('pending'),
    causeClass: text('cause_class'),
    causeMessage: varchar('cause_message', { length: 300 }),
    reuseHash: char('reuse_hash', { length: 64 }).notNull(),
    thumbstopperJobId: uuid('thumbstopper_job_id').references(() => thumbstopperJobs.id, { onDelete: 'set null' }),
    outputMediaId: uuid('output_media_id').references(() => mediaObjects.id, { onDelete: 'set null' }),
    renderDay: date('render_day', { mode: 'string' }).notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'string' }),
    attempts: smallint('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('assembly_jobs_reuse_uq')
      .on(table.campaignId, table.reuseHash)
      .where(sql`${table.state} <> 'failed'`),
    index('assembly_jobs_owner_day_idx').on(table.ownerId, table.renderDay),
    index('assembly_jobs_campaign_idx').on(table.campaignId, sql`${table.createdAt} desc`),
    check('assembly_jobs_state_ck', sql`${table.state} in (${list(STATES)})`),
    check('assembly_jobs_cause_ck', sql`${table.causeClass} is null or ${table.causeClass} in (${list(CAUSE_CLASSES)})`),
    check('assembly_jobs_attempts_ck', sql`${table.attempts} >= 0`),
  ],
);

/** The clips of one assembly in order (position 1 to 4), with the record of the QC confirmation that let each in (REQ-010). */
export const assemblyClips = pgTable(
  'assembly_clips',
  {
    assemblyJobId: uuid('assembly_job_id')
      .notNull()
      .references(() => assemblyJobs.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    videoJobId: uuid('video_job_id')
      .notNull()
      .references(() => videoJobs.id),
    qcOverrideConfirmed: boolean('qc_override_confirmed').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.assemblyJobId, table.position] }),
    index('assembly_clips_video_job_idx').on(table.videoJobId),
    check('assembly_clips_position_ck', sql`${table.position} between 1 and 4`),
  ],
);
