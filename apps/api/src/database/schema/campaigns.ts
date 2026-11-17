import { sql } from 'drizzle-orm';
import {
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
import { users } from './identity.js';
import { mediaObjects } from './media.js';

// Campaign tables of migration M0008 (ARCHITECTURE §2.2, SB v6 §4.2). `drafts.campaign_id` points up at `campaigns`
// (SB-D1); the media references are SET NULL (SB-D17) so a deleted object never takes a draft or campaign with it.
// Timestamps are read as text so the microseconds that order the cursor survive.

/** One row per submitted brief intake (REQ-005, REQ-012). `deleting` is the only hidden state (SB v6 §1 rule 7). */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('active'),
    productName: varchar('product_name', { length: 120 }).notNull(),
    productDescription: varchar('product_description', { length: 2000 }).notNull(),
    productMediaId: uuid('product_media_id').references(() => mediaObjects.id, {
      onDelete: 'set null',
    }),
    segmentCount: smallint('segment_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('campaigns_owner_active_idx')
      .on(table.ownerId, sql`${table.updatedAt} desc`, sql`${table.id} desc`)
      .where(sql`${table.state} = 'active'`),
    index('campaigns_product_name_trgm_idx').using('gin', sql`${table.productName} gin_trgm_ops`),
    index('campaigns_product_description_trgm_idx').using(
      'gin',
      sql`${table.productDescription} gin_trgm_ops`,
    ),
    uniqueIndex('campaigns_product_media_uq')
      .on(table.productMediaId)
      .where(sql`${table.productMediaId} is not null`),
    check('campaigns_state_ck', sql`${table.state} in ('active', 'deleting')`),
    check('campaigns_segment_count_ck', sql`${table.segmentCount} between 1 and 4`),
    check('campaigns_product_name_ck', sql`length(btrim(${table.productName})) > 0`),
  ],
);

/** The intake wizard's saved state (REQ-005). `campaign_id` set means submitted and read-only (SB-D13). */
export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    step: smallint('step').notNull().default(1),
    adStyle: text('ad_style').notNull().default('ugc'),
    intakeMode: text('intake_mode').notNull().default('description'),
    productName: varchar('product_name', { length: 120 }),
    productDescription: varchar('product_description', { length: 2000 }),
    audienceAgeMin: smallint('audience_age_min'),
    audienceAgeMax: smallint('audience_age_max'),
    audienceGender: text('audience_gender'),
    audienceInterests: varchar('audience_interests', { length: 40 }).array(),
    directionGoal: text('direction_goal'),
    directionTone: varchar('direction_tone', { length: 60 }),
    segmentCount: smallint('segment_count'),
    concept: varchar('concept', { length: 4000 }),
    script: varchar('script', { length: 4000 }),
    productMediaId: uuid('product_media_id').references(() => mediaObjects.id, {
      onDelete: 'set null',
    }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('drafts_owner_open_idx')
      .on(table.ownerId, sql`${table.updatedAt} desc`, sql`${table.id} desc`)
      .where(sql`${table.campaignId} is null`),
    uniqueIndex('drafts_campaign_uq')
      .on(table.campaignId)
      .where(sql`${table.campaignId} is not null`),
    uniqueIndex('drafts_product_media_uq')
      .on(table.productMediaId)
      .where(sql`${table.productMediaId} is not null`),
    check('drafts_version_ck', sql`${table.version} > 0`),
    check('drafts_step_ck', sql`${table.step} between 1 and 5`),
    check('drafts_ad_style_ck', sql`${table.adStyle} = 'ugc'`),
    check('drafts_intake_mode_ck', sql`${table.intakeMode} in ('description', 'script')`),
    check(
      'drafts_product_name_ck',
      sql`${table.productName} is null or length(btrim(${table.productName})) > 0`,
    ),
    check(
      'drafts_age_min_ck',
      sql`${table.audienceAgeMin} is null or ${table.audienceAgeMin} between 21 and 99`,
    ),
    check(
      'drafts_age_max_ck',
      sql`${table.audienceAgeMax} is null or ${table.audienceAgeMax} between 21 and 99`,
    ),
    check(
      'drafts_age_range_ck',
      sql`${table.audienceAgeMin} is null or ${table.audienceAgeMax} is null or ${table.audienceAgeMax} >= ${table.audienceAgeMin}`,
    ),
    check(
      'drafts_gender_ck',
      sql`${table.audienceGender} is null or ${table.audienceGender} in ('all', 'female', 'male')`,
    ),
    check(
      'drafts_interests_ck',
      sql`${table.audienceInterests} is null or cardinality(${table.audienceInterests}) <= 10`,
    ),
    check(
      'drafts_goal_ck',
      sql`${table.directionGoal} is null or ${table.directionGoal} in ('awareness', 'conversion', 'retention')`,
    ),
    check(
      'drafts_segment_count_ck',
      sql`${table.segmentCount} is null or ${table.segmentCount} between 1 and 4`,
    ),
  ],
);
