import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

// Usage tables of migration M0006 (ARCHITECTURE §2.2, §5.9; SB v6 §3.3, SB-D9, SB-D10). `usage_events` is history: its
// `owner_id` and `job_id` are plain columns with no foreign key, so a row outlives its subject. A reservation belongs to
// a live user and is removed with the account.

/** One row per provider call, unique per `(job_type, job_id, call_seq)` (SB-D9). */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    provider: text('provider').notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    jobType: text('job_type').notNull(),
    jobId: uuid('job_id').notNull(),
    callSeq: smallint('call_seq').notNull(),
    outcome: text('outcome').notNull(),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 4 }).notNull(),
    costBasis: text('cost_basis').notNull(),
    latencyMs: integer('latency_ms'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('usage_events_call_uq').on(table.jobType, table.jobId, table.callSeq),
    index('usage_events_owner_at_idx').on(table.ownerId, table.at),
    index('usage_events_at_idx').on(table.at),
    check(
      'usage_events_provider_ck',
      sql`${table.provider} in ('openai', 'wavespeed', 'assembly_vendor')`,
    ),
    check(
      'usage_events_job_type_ck',
      sql`${table.jobType} in ('brief_generation', 'image_analysis', 'video', 'qc', 'thumbstopper', 'assembly')`,
    ),
    check('usage_events_call_seq_ck', sql`${table.callSeq} >= 1`),
    check(
      'usage_events_outcome_ck',
      sql`${table.outcome} in ('succeeded', 'failed', 'rejected', 'unconfirmed')`,
    ),
    check(
      'usage_events_cost_basis_ck',
      sql`${table.costBasis} in ('estimate', 'zero_rejected', 'unconfirmed_estimate')`,
    ),
    check('usage_events_cost_ck', sql`${table.estimatedCostUsd} >= 0`),
    check('usage_events_latency_ck', sql`${table.latencyMs} >= 0`),
    // The cost basis follows from the outcome (SB-D9): a rejection costs nothing, an unknown outcome keeps the estimate.
    check(
      'usage_events_basis_outcome_ck',
      sql`(${table.outcome} = 'rejected') = (${table.costBasis} = 'zero_rejected')
        and (${table.outcome} = 'unconfirmed') = (${table.costBasis} = 'unconfirmed_estimate')
        and (${table.costBasis} <> 'zero_rejected' or ${table.estimatedCostUsd} = 0)`,
    ),
  ],
);

/** The estimate of the calls of one job that are not yet made; counted by the cap check (REQ-019). */
export const spendReservations = pgTable(
  'spend_reservations',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobType: text('job_type').notNull(),
    jobId: uuid('job_id').notNull(),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 4 }).notNull(),
    remainingCalls: smallint('remaining_calls').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('spend_reservations_job_uq').on(table.jobType, table.jobId),
    index('spend_reservations_owner_idx').on(table.ownerId),
    check(
      'spend_reservations_job_type_ck',
      sql`${table.jobType} in ('brief_generation', 'image_analysis', 'video', 'qc', 'thumbstopper', 'assembly')`,
    ),
    check('spend_reservations_cost_ck', sql`${table.estimatedCostUsd} >= 0`),
    check('spend_reservations_calls_ck', sql`${table.remainingCalls} >= 1`),
  ],
);

/** Provider prices (SB-D10): loaded from `config/price-table.json` by the release seed. No foreign key. */
export const priceTable = pgTable(
  'price_table',
  {
    provider: text('provider').notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    unit: varchar('unit', { length: 32 }).notNull(),
    unitPriceUsd: numeric('unit_price_usd', { precision: 12, scale: 6 }).notNull(),
    unitsPerCall: numeric('units_per_call', { precision: 10, scale: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.operation, table.effectiveFrom] }),
    check(
      'price_table_provider_ck',
      sql`${table.provider} in ('openai', 'wavespeed', 'assembly_vendor')`,
    ),
    check('price_table_price_ck', sql`${table.unitPriceUsd} >= 0`),
    check('price_table_units_ck', sql`${table.unitsPerCall} >= 0`),
  ],
);
