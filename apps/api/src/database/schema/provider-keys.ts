import { sql } from 'drizzle-orm';
import {
  char,
  check,
  customType,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

// Provider-key tables of migration M0004 (ARCHITECTURE §2.2, ADR-004, ADR-009, TD-D7; SECURITY-DESIGN §9.2, §9.4).
// `ciphertext`, `nonce` and `wrapped_dek` are Secret: `app_api` is granted every column except those three for SELECT,
// and the repositories always project explicit columns. `key_events` has no foreign keys and holds IDs only.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** One sealed key per owner and provider (REQ-015, REQ-016). */
export const providerKeys = pgTable(
  'provider_keys',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    // Part of the AAD: a ciphertext moved to another row or version fails to open.
    version: integer('version').notNull().default(1),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    wrappedDek: bytea('wrapped_dek').notNull(),
    kekVersion: smallint('kek_version').notNull(),
    last4: char('last4', { length: 4 }).notNull(),
    // Lower hex HMAC-SHA-256 under the pepper version below (TD-D6): old fingerprints stay as display values.
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    fingerprintPepperVersion: smallint('fingerprint_pepper_version').notNull(),
    consecutiveAuthFailures: smallint('consecutive_auth_failures').notNull().default(0),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_keys_owner_provider_uq').on(table.ownerId, table.provider),
    check('provider_keys_provider_ck', sql`${table.provider} in ('openai', 'wavespeed')`),
    check('provider_keys_status_ck', sql`${table.status} in ('active', 'untested', 'disabled')`),
    check('provider_keys_version_ck', sql`${table.version} > 0`),
    check('provider_keys_ciphertext_ck', sql`octet_length(${table.ciphertext}) between 1 and 1024`),
    check('provider_keys_nonce_ck', sql`octet_length(${table.nonce}) = 12`),
    check('provider_keys_wrapped_dek_ck', sql`octet_length(${table.wrappedDek}) = 384`),
    check('provider_keys_kek_version_ck', sql`${table.kekVersion} > 0`),
    check('provider_keys_fingerprint_ck', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check('provider_keys_pepper_version_ck', sql`${table.fingerprintPepperVersion} > 0`),
    check('provider_keys_failures_ck', sql`${table.consecutiveAuthFailures} >= 0`),
    index('provider_keys_kek_version_idx').on(table.kekVersion),
  ],
);

/** The columns the worker role reads to unseal a key (M0004): an explicit projection, never every column. */
export const sealedKeyColumns = {
  id: providerKeys.id,
  ownerId: providerKeys.ownerId,
  provider: providerKeys.provider,
  status: providerKeys.status,
  version: providerKeys.version,
  ciphertext: providerKeys.ciphertext,
  nonce: providerKeys.nonce,
  wrappedDek: providerKeys.wrappedDek,
  kekVersion: providerKeys.kekVersion,
};

/** The owner's key trail (REQ-019). History: no foreign keys, IDs only, never a value. */
export const keyEvents = pgTable(
  'key_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    // Null when the event concerns no single row (a rate-limited attempt).
    keyId: uuid('key_id'),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('key_events_provider_ck', sql`${table.provider} in ('openai', 'wavespeed')`),
    check(
      'key_events_kind_ck',
      sql`${table.kind} in ('added', 'replaced', 'deleted', 'test_passed', 'test_failed', 'stored_untested', 'validated_by_job', 'auth_failed', 'disabled', 'disabled_by_operator', 'attempt_rate_limited', 'rewrapped')`,
    ),
    index('key_events_owner_at_idx').on(
      table.ownerId,
      sql`${table.at} desc`,
      sql`${table.id} desc`,
    ),
  ],
);
