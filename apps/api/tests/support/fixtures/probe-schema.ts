import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

// Fixture table for the migration-command tests (TC-OPS-03); never part of the product schema.
export const probeItems = pgTable('probe_items', {
  id: uuid('id').primaryKey(),
  label: text('label').notNull(),
});
