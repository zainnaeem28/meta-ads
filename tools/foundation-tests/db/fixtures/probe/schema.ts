import { bigint, pgTable, text } from 'drizzle-orm/pg-core';

// Probe table for the foundation database proof. Not a product table: it only gives the
// grants checks a table with an identity sequence in `public`.
export const probeItems = pgTable('probe_items', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  label: text('label').notNull(),
});
