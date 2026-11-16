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

// Identity tables of migration M0003 (ARCHITECTURE §2.2, data dictionary "identity"). Roles and status live here, not in
// the provider. The IDs of `access_requests.decided_by|user_id` and `platform_settings.updated_by` are plain (no FK).

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    idpSubject: varchar('idp_subject', { length: 64 }).notNull(),
    // Stored lower-cased and trimmed.
    email: varchar('email', { length: 320 }).notNull(),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    linkedVia: text('linked_via').notNull(),
    version: integer('version').notNull().default(1),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_idp_subject_uq').on(table.idpSubject),
    uniqueIndex('users_email_lower_uq').on(sql`lower(${table.email})`),
    check('users_role_ck', sql`${table.role} in ('user', 'admin')`),
    check('users_status_ck', sql`${table.status} in ('active', 'suspended', 'removed')`),
    check(
      'users_linked_via_ck',
      sql`${table.linkedVia} in ('first_admin', 'invitation', 'access_request', 'open_signup')`,
    ),
    check('users_version_ck', sql`${table.version} > 0`),
    index('users_admin_active_idx')
      .on(table.id)
      .where(sql`${table.role} = 'admin' and ${table.status} = 'active'`),
    index('users_created_idx').on(sql`${table.createdAt} desc`, sql`${table.id} desc`),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    // Lower-cased.
    email: varchar('email', { length: 320 }).notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    state: text('state').notNull().default('invited'),
    sendState: text('send_state').notNull().default('pending'),
    // Null until the provider call returns; the provider issues and verifies the invitation, we hold no token.
    idpInvitationId: varchar('idp_invitation_id', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invitations_email_invited_uq')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.state} = 'invited'`),
    index('invitations_email_idx').on(sql`lower(${table.email})`),
    uniqueIndex('invitations_idp_invitation_id_uq').on(table.idpInvitationId),
    check(
      'invitations_state_ck',
      sql`${table.state} in ('invited', 'accepted', 'expired', 'revoked')`,
    ),
    check(
      'invitations_send_state_ck',
      sql`${table.sendState} in ('pending', 'sent', 'send_failed')`,
    ),
    check('invitations_expires_ck', sql`${table.expiresAt} > ${table.createdAt}`),
    index('invitations_send_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.sendState} = 'pending'`),
    index('invitations_created_idx').on(sql`${table.createdAt} desc`, sql`${table.id} desc`),
    index('invitations_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.state} = 'invited'`),
  ],
);

export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey(),
    idpSubject: varchar('idp_subject', { length: 64 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    note: varchar('note', { length: 500 }),
    state: text('state').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    userId: uuid('user_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('access_requests_subject_pending_uq')
      .on(table.idpSubject)
      .where(sql`${table.state} = 'pending'`),
    index('access_requests_email_idx').on(sql`lower(${table.email})`),
    check('access_requests_state_ck', sql`${table.state} in ('pending', 'approved', 'declined')`),
  ],
);

/** One row (`id = 1`), created by the seed or on first use. */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: smallint('id').primaryKey().default(1),
    signupMode: text('signup_mode').notNull().default('invited_only'),
    // Set once under the `admin-invariant` lock; cleared only by `first-admin:reopen`.
    firstAdminSeededAt: timestamp('first_admin_seeded_at', { withTimezone: true }),
    openModeVerificationId: varchar('open_mode_verification_id', { length: 120 }),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('platform_settings_single_ck', sql`${table.id} = 1`),
    check('platform_settings_signup_mode_ck', sql`${table.signupMode} in ('invited_only', 'open')`),
  ],
);
