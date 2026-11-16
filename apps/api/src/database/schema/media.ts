import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

// Media tables of migration M0005 (ARCHITECTURE §2.2, SB v6 §4.2). `campaign_id` is a plain column (SB-D2): `campaigns`
// is a higher layer, so no foreign key points up. Other tables reference `media_objects` with their own foreign keys.

/** One row per stored object (REQ-006, REQ-020). The R2 key is built only by the media module from server-side IDs. */
export const mediaObjects = pgTable(
  'media_objects',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    bytes: bigint('bytes', { mode: 'number' }),
    contentType: varchar('content_type', { length: 32 }),
    width: integer('width'),
    height: integer('height'),
    campaignId: uuid('campaign_id'),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
    rejectReason: text('reject_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_objects_storage_key_uq').on(table.storageKey),
    index('media_objects_owner_created_idx').on(
      table.ownerId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),
    index('media_objects_campaign_idx')
      .on(table.campaignId)
      .where(sql`${table.campaignId} is not null`),
    index('media_objects_unattached_idx')
      .on(table.createdAt)
      .where(sql`${table.kind} = 'upload' and ${table.attachedAt} is null`),
    check('media_objects_kind_ck', sql`${table.kind} in ('upload', 'clip', 'final', 'thumbstopper')`),
    check('media_objects_state_ck', sql`${table.state} in ('processing', 'ready', 'rejected')`),
    check(
      'media_objects_reject_ck',
      sql`(${table.state} = 'rejected') = (${table.rejectReason} is not null)`,
    ),
    check(
      'media_objects_reject_reason_ck',
      sql`${table.rejectReason} in ('type_not_allowed', 'pixel_cap_exceeded', 'decompression_bomb', 'decode_failed')`,
    ),
    check('media_objects_bytes_ck', sql`${table.bytes} >= 0`),
    check(
      'media_objects_content_type_ck',
      sql`${table.contentType} in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4')`,
    ),
    check('media_objects_width_ck', sql`${table.width} > 0`),
    check('media_objects_height_ck', sql`${table.height} > 0`),
  ],
);

/** Bytes stored per owner (REQ-020 quota). Changed in the same transaction as each `media_objects` insert, resize or delete. */
export const storageUsage = pgTable(
  'storage_usage',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    bytesUsed: bigint('bytes_used', { mode: 'number' }).notNull().default(0),
  },
  (table) => [check('storage_usage_bytes_ck', sql`${table.bytesUsed} >= 0`)],
);
